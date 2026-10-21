import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from '../src/main/library/libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from '../src/main/library/libraryDatabaseProtocol.ts'
import { createLibraryPlaylistView } from '../src/renderer/src/stores/library/libraryPlaylistView.ts'
import { libraryTrack } from '../src/renderer/src/utils/libraryQueuePlayback.ts'
import type { Playlist } from '../src/renderer/src/stores/library/musicStoreTypes.ts'

// Isolate catalog cost over many configured occurrences, not 300k real media.
// Uses the production renderer upload owner and the actual Node worker IPC.
const count = Number(process.argv[2] ?? 300_000)
if (!Number.isSafeInteger(count) || count < 1)
  throw new Error('Expected a positive occurrence count')
const output = process.argv[3] ? resolve(process.argv[3]) : null
const root = mkdtempSync(join(tmpdir(), 'twilight-playlist-catalog-'))
const children: ChildProcess[] = []
const file = join(root, 'music-library.json')
const local = Array.from({ length: 64 }, (_, i) => ({
  id: `local:${i}`,
  filePath: join(root, `${i}.flac`),
  title: `Local ${i}`,
  artist: 'Artist',
  duration: 180,
  source: 'local'
}))
writeFileSync(file, JSON.stringify(local))
let maxRpc = 0,
  active = 0,
  appendBatches = 0,
  maxBatch = 0
const client = new LibraryDatabaseServiceClient({
  serviceEntry: fileURLToPath(
    new URL('../src/main/library/libraryDatabaseService.ts', import.meta.url)
  ),
  libraryFilePath: file,
  requestTimeoutMs: 120_000,
  fork: (entry) => {
    const child = fork(entry, [], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    })
    children.push(child)
    Object.assign(child, {
      postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
    })
    return child as unknown as DatabaseUtilityProcess
  }
})
const owner = createLibraryPlaylistView({
  syncPlaylistView: async (request) => {
    active++
    maxRpc = Math.max(maxRpc, active)
    if (request.kind === 'append') {
      appendBatches++
      maxBatch = Math.max(maxBatch, request.entries.length)
    }
    try {
      return await client.syncPlaylistView(request)
    } finally {
      active--
    }
  }
})
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
try {
  await client.getMetadata()
  const remote = Array.from({ length: 4 }, (_, i) =>
    libraryTrack({
      id: `provider${i}:7`,
      filePath: '',
      title: `Remote ${i}`,
      artist: 'Remote artist',
      source: `provider${i}`,
      duration: 120
    })
  )
  const playlists: Playlist[] = []
  let localOccurrences = 0
  for (let offset = 0; offset < count; offset += 100) {
    const trackIds = Array.from({ length: Math.min(100, count - offset) }, (_, i) => {
      if ((offset + i) % 7 === 0) return remote[(offset + i) % remote.length].id
      localOccurrences++
      return local[(offset + i) % local.length].id
    })
    playlists.push({
      id: `p${playlists.length}`,
      name: `Mix 中文 ${playlists.length}`,
      createdAt: '',
      trackIds,
      trackSnapshots: Object.fromEntries(remote.map((track) => [track.id, track]))
    })
  }
  const uploadStart = performance.now()
  await owner.setCatalog(playlists, { revision: 1, versions: [] })
  assert.equal(owner.state.value.error, '')
  const uploadMs = performance.now() - uploadStart
  const query = { playlistView: owner.state.value.id! }
  let coldDone = false
  const probes: number[] = []
  const coldStart = performance.now()
  const coldPromise = client.queryCollections('playlists', query).then((page) => {
    coldDone = true
    return page
  })
  while (!coldDone) {
    const start = performance.now()
    assert.equal((await client.getTracksByIds(['local:0'])).tracks.length, 1)
    probes.push(performance.now() - start)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const cold = await coldPromise,
    coldMs = performance.now() - coldStart
  assert.equal(cold.total, playlists.length)
  const pages: number[] = [],
    search: number[] = [],
    order: number[] = []
  let occurrences = 0,
    localCount = 0,
    providers = 0,
    maxItems = 0
  const reversed = playlists.map((playlist) => playlist.id).reverse()
  for (let offset = 0; offset < playlists.length; offset += 200) {
    const start = performance.now()
    const page = await client.queryCollections('playlists', { ...query, offset })
    pages.push(performance.now() - start)
    maxItems = Math.max(maxItems, page.items.length)
    for (const item of page.items) {
      occurrences += item.trackCount
      localCount += item.sourceSummary!.local
      providers += item.sourceSummary!.provider
      assert.equal('tracks' in item, false)
      assert.equal('trackIds' in item, false)
    }
    const orderedStart = performance.now()
    const ordered = await client.queryCollections('playlists', {
      ...query,
      offset,
      collectionOrder: reversed
    })
    order.push(performance.now() - orderedStart)
    assert.deepEqual(
      ordered.items.map((item) => item.id),
      reversed.slice(offset, offset + 200)
    )
    const searchStart = performance.now()
    const found = await client.queryCollections('playlists', { ...query, search: `中文 ${offset}` })
    search.push(performance.now() - searchStart)
    assert.equal(
      found.items.some((item) => item.id === `p${offset}`),
      true
    )
  }
  assert.equal(occurrences, count)
  assert.equal(localCount, localOccurrences)
  assert.equal(providers, count - localOccurrences)
  const report = {
    workload:
      'synthetic configured playlist occurrences over 64 local records and four provider snapshots; production upload owner + Node worker IPC, not real media/Electron UI',
    distinctLocalTracks: 64,
    playlistOccurrences: count,
    playlists: playlists.length,
    uploadMs,
    appendBatches,
    maxBatch,
    maxUnconfirmedUploadRpcs: maxRpc,
    coldSummaryMs: coldMs,
    interleavedReadP95Ms: p95(probes),
    interleavedReadMaxMs: Math.max(...probes),
    interleavedReadSamplesMs: probes,
    pageP95Ms: p95(pages),
    pageSamplesMs: pages,
    searchP95Ms: p95(search),
    searchSamplesMs: search,
    customOrderP95Ms: p95(order),
    customOrderSamplesMs: order,
    maxResponseSummaries: maxItems,
    responseTrackObjects: 0,
    parentPeakRssKiB: process.resourceUsage().maxRSS
  }
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await owner.dispose()
  client.destroy()
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  // Exact absolute test-profile directory returned by mkdtemp, never its parent.
  rmSync(root, { recursive: true, force: true })
}
