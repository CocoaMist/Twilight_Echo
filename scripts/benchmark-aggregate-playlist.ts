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
import type { LibraryQuery, LibraryTrackRecord } from '../src/shared/libraryDatabase.ts'
import { createLibraryPlaylistView } from '../src/renderer/src/stores/library/libraryPlaylistView.ts'
import { libraryTrack } from '../src/renderer/src/utils/libraryQueuePlayback.ts'
import type { Playlist } from '../src/renderer/src/stores/library/musicStoreTypes.ts'

// Deliberately adversarial synthesized metadata, not real media scanning/UI.
// Same provider + same recording key + distinct provider IDs cannot merge.
// A second case has one recording with N duplicate occurrences to sort.
const count = Number(process.argv[2] ?? 300_000)
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000)
  throw new Error('Expected 1..1000000 members')
const output = process.argv[3] ? resolve(process.argv[3]) : null
const sqlProfile = process.env.TWILIGHT_AGGREGATE_BENCHMARK_SQL_PROFILE === '1'
const profile = sqlProfile || process.env.TWILIGHT_AGGREGATE_BENCHMARK_PROFILE === '1'
const root = mkdtempSync(join(tmpdir(), 'twilight-aggregate-benchmark-')),
  file = join(root, 'music-library.json'),
  harness = join(root, 'worker-memory.mjs'),
  children: ChildProcess[] = []
writeFileSync(
  file,
  JSON.stringify([
    {
      id: 'one',
      filePath: join(root, 'one.flac'),
      title: 'Local',
      artist: 'Artist',
      duration: 180,
      source: 'local'
    }
  ])
)
writeFileSync(
  harness,
  `${
    profile
      ? `
const { LibraryDatabaseAggregateViews } = await import(${JSON.stringify(new URL('../src/main/library/libraryDatabaseAggregate.ts', import.meta.url).href)});
const { LibraryDatabasePlaylistViews } = await import(${JSON.stringify(new URL('../src/main/library/libraryDatabasePlaylistViews.ts', import.meta.url).href)});
const aggregateStages = {};
${
  sqlProfile
    ? `
const { DatabaseSync } = await import('node:sqlite');
const sqlStages = {}, originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(query) {
  const statement = originalPrepare.call(this, query);
  for (const method of ['get', 'all', 'run']) {
    const original = statement[method], key = method + ':' + query.replace(/\\s+/g, ' ').trim();
    statement[method] = function(...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const stat = sqlStages[key] ??= { calls: 0, ms: 0, maxMs: 0 };
        const elapsed = performance.now() - start;
        stat.calls++; stat.ms += elapsed; stat.maxMs = Math.max(stat.maxMs, elapsed);
      }
    };
  }
  return statement;
};`
    : 'const sqlStages = undefined;'
}
for (const [type, methods] of [
  [LibraryDatabaseAggregateViews, ['prepare', 'prepareSelection', 'prepareVariants']],
  [LibraryDatabasePlaylistViews, ['prepare', 'materialize', 'prepareDetails', 'maintenance']]
]) {
  for (const method of methods) {
    const original = type.prototype[method];
    type.prototype[method] = function(...args) {
      const phase = type === LibraryDatabaseAggregateViews && method === 'prepare'
        ? (this.states.get(args[0])?.phase ?? 'inputs')
        : (typeof args[0] === 'object' && args[0]?.search ? 'search' : 'default');
      const key = type.name + '.' + method + ':' + phase, start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const stat = aggregateStages[key] ??= { calls: 0, ms: 0, maxMs: 0 };
        const elapsed = performance.now() - start;
        stat.calls++; stat.ms += elapsed; stat.maxMs = Math.max(stat.maxMs, elapsed);
      }
    };
  }
}`
      : 'const aggregateStages = undefined, sqlStages = undefined;'
  }
await import(${JSON.stringify(new URL('../src/main/library/libraryDatabaseService.ts', import.meta.url).href)});
setInterval(()=>process.stdout.write(JSON.stringify({rss:process.memoryUsage().rss,aggregateStages,sqlStages})+'\\n'),100).unref();`
)
let workerPeak = 0,
  parentPeak = process.memoryUsage().rss,
  reads = 0,
  maximumReads = 0,
  uploadActive = 0,
  maximumUploads = 0,
  maxBatch = 0,
  maxTracks = 0
let aggregateStages: Record<string, { calls: number; ms: number; maxMs: number }> | undefined
let sqlStages: typeof aggregateStages
const sample = setInterval(() => {
  parentPeak = Math.max(parentPeak, process.memoryUsage().rss)
}, 100)
const client = new LibraryDatabaseServiceClient({
  serviceEntry: fileURLToPath(
    new URL('../src/main/library/libraryDatabaseService.ts', import.meta.url)
  ),
  libraryFilePath: file,
  requestTimeoutMs: 180_000,
  fork: () => {
    const child = fork(harness, [], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'pipe', 'inherit', 'ipc']
    })
    children.push(child)
    let lines = ''
    child.stdout!.on('data', (data: Buffer) => {
      lines += data.toString()
      for (;;) {
        const end = lines.indexOf('\n')
        if (end < 0) break
        const line = lines.slice(0, end)
        lines = lines.slice(end + 1)
        const memory = JSON.parse(line) as {
          rss: number
          aggregateStages?: typeof aggregateStages
          sqlStages?: typeof sqlStages
        }
        workerPeak = Math.max(workerPeak, memory.rss)
        aggregateStages = memory.aggregateStages
        sqlStages = memory.sqlStages
      }
    })
    Object.assign(child, {
      postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
    })
    return child as unknown as DatabaseUtilityProcess
  }
})
const owner = createLibraryPlaylistView({
  syncPlaylistView: async (request) => {
    uploadActive++
    maximumUploads = Math.max(maximumUploads, uploadActive)
    if (request.kind === 'append') maxBatch = Math.max(maxBatch, request.entries.length)
    try {
      return await client.syncPlaylistView(request)
    } finally {
      uploadActive--
    }
  }
})
const quantile = (values: number[], fraction: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null
async function read(query: LibraryQuery) {
  reads++
  maximumReads = Math.max(maximumReads, reads)
  try {
    const page = await client.queryTracks(query)
    maxTracks = Math.max(maxTracks, page.tracks.length)
    assert.ok(page.tracks.length <= 200)
    return page
  } finally {
    reads--
  }
}
async function measured<T>(action: () => Promise<T>, probes = false) {
  const start = performance.now(),
    samples: number[] = []
  let done = false
  const result = action().finally(() => {
    done = true
  })
  const wait = probes
    ? (async () => {
        while (!done) {
          const began = performance.now()
          await client.getTracksByIds(['one'])
          samples.push(performance.now() - began)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      })()
    : Promise.resolve()
  const value = await result
  const ms = performance.now() - start
  await wait
  return {
    value,
    ms,
    probes: {
      count: samples.length,
      p95Ms: quantile(samples, 0.95),
      maxMs: samples.length ? Math.max(...samples) : null
    }
  }
}
try {
  await client.getMetadata()
  const trackIds = Array.from({ length: count }, (_, i) => `ncm:${i}`)
  const snapshots: NonNullable<Playlist['trackSnapshots']> = {}
  for (const id of trackIds)
    snapshots[id] = libraryTrack({
      id,
      filePath: '',
      title: 'Same',
      artist: 'Artist',
      album: 'Album',
      source: 'ncm',
      duration: 180,
      format: 'mp3'
    } as LibraryTrackRecord)
  const playlist: Playlist = {
    id: 'dense',
    name: 'Dense provider',
    createdAt: '',
    trackIds,
    trackSnapshots: snapshots
  }
  const upload = await measured(() =>
    owner.setPlaylist(playlist, { revision: 1, versions: [], preserveSources: true })
  )
  assert.equal(owner.state.value.error, '')
  const query: LibraryQuery = {
    playlistView: owner.state.value.id!,
    sort: 'playlist',
    aggregate: {}
  }
  const cold = await measured(() => read(query), true)
  assert.equal(cold.value.total, count)
  const paging: number[] = []
  for (let i = 0; i < 40; i++) {
    const result = await measured(() =>
      read({ ...query, offset: Math.floor(((i * 7919) % count) / 200) * 200 })
    )
    paging.push(result.ms)
  }
  const search = await measured(() => read({ ...query, search: 'same artist' }), true)
  assert.equal(search.value.total, count)
  const noMatch = await measured(() => read({ ...query, search: 'absent' }), true)
  assert.equal(noMatch.value.total, 0)
  const queue = await measured(
    () =>
      client.createLibraryQueue(
        { ...query, playlistEntryId: String(count - 1), contentRevision: cold.value.revision },
        `ncm:${count - 1}`
      ),
    true
  )
  assert.equal(queue.value.total, count)
  assert.equal(queue.value.index, count - 1)
  await client.deleteLibraryQueue(queue.value.id, queue.value.revision)
  const dense = {
    members: count,
    rows: cold.value.total,
    uploadMs: upload.ms,
    coldMs: cold.ms,
    coldReadProbes: cold.probes,
    pagingP95Ms: quantile(paging, 0.95),
    searchMs: search.ms,
    missingSearchMs: noMatch.ms,
    queueMs: queue.ms,
    queueReadProbes: queue.probes
  }
  const duplicateUpload = await measured(() =>
    owner.setPlaylist(
      { id: 'duplicates', name: 'Duplicates', createdAt: '', trackIds: Array(count).fill('one') },
      { revision: 1, versions: [], preserveSources: true }
    )
  )
  assert.equal(owner.state.value.error, '')
  const duplicateQuery: LibraryQuery = {
    playlistView: owner.state.value.id!,
    sort: 'playlist',
    aggregate: {}
  }
  const duplicateCold = await measured(() => read(duplicateQuery), true)
  assert.equal(duplicateCold.value.total, 1)
  const variantsQuery: LibraryQuery = {
    ...duplicateQuery,
    aggregate: { variantRow: duplicateCold.value.aggregate!.rows[0].rowId },
    offset: Math.floor((count - 1) / 200) * 200
  }
  const variants = await measured(() => read(variantsQuery), true)
  assert.equal(variants.value.total, count)
  assert.equal(variants.value.entryIds!.at(-1), String(count - 1))
  const variantCached = await measured(() => read(variantsQuery))
  const duplicates = {
    members: count,
    rows: 1,
    uploadMs: duplicateUpload.ms,
    coldMs: duplicateCold.ms,
    coldReadProbes: duplicateCold.probes,
    coldVariantsMs: variants.ms,
    variantReadProbes: variants.probes,
    cachedVariantsMs: variantCached.ms
  }
  // Flush the final 100ms worker sample, outside all timed operations. Without
  // this the last variant batches could be absent from the profiling counters.
  await new Promise((resolve) => setTimeout(resolve, 110))
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: process.version,
    scope:
      'Synthetic playlist metadata via production renderer upload owner and real Node worker; not media parsing, Electron UI or device playback',
    dense,
    duplicates,
    bounds: {
      maximumUploadRpcs: maximumUploads,
      maxBatch,
      maximumQueryRpcs: maximumReads,
      maxTracks
    },
    memory: {
      parentPeakRssMiB: parentPeak / 1048576,
      workerPeakRssMiB: workerPeak / 1048576,
      sampleIntervalMs: 100
    },
    ...(profile ? { aggregateStages, ...(sqlProfile ? { sqlStages } : {}) } : {})
  }
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally {
  clearInterval(sample)
  await owner.dispose()
  client.destroy()
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  rmSync(root, { recursive: true, force: true })
}
