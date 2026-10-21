import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from './libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from './libraryDatabaseProtocol.ts'
import { getLibraryDatabasePath, LibraryDatabase } from './libraryDatabase.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'

class ManualProcess extends EventEmitter {
  messages: LibraryDatabaseWorkerRequest[] = []
  kills = 0
  postMessage(message: LibraryDatabaseWorkerRequest) {
    this.messages.push(message)
  }
  kill() {
    this.kills++
    this.emit('exit', 0)
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function workerClient(json: string, children: ChildProcess[]) {
  return new LibraryDatabaseServiceClient({
    serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
    libraryFilePath: json,
    fork: (entry) => {
      const child = fork(entry, [], {
        execArgv: ['--experimental-strip-types'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      children.push(child)
      Object.assign(child, {
        postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
      })
      return child as unknown as DatabaseUtilityProcess
    }
  })
}

async function uploadWorkerView(
  client: LibraryDatabaseServiceClient,
  id: string,
  count = 12_005,
  mixed = false
) {
  await client.syncPlaylistView({ kind: 'begin', id, versions: [] })
  let sequence = 0
  for (let offset = 0; offset < count; offset += 200)
    await client.syncPlaylistView({
      kind: 'append',
      id,
      sequence: ++sequence,
      entries: Array.from({ length: Math.min(200, count - offset) }, (_, i) =>
        mixed && (offset + i) % 7 === 0
          ? {
              id: 'ncm:7',
              snapshot: {
                id: 'ncm:7',
                filePath: '',
                title: 'Remote',
                artist: 'Artist',
                source: 'ncm'
              }
            }
          : { id: (offset + i) % 2 ? 'one' : 'two' }
      )
    })
  await client.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence })
}

async function queueWorkerFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'queue-worker-build-')),
    json = join(root, 'music-library.json'),
    children: ChildProcess[] = []
  writeFileSync(
    json,
    JSON.stringify([
      { id: 'one', filePath: join(root, 'one.flac'), title: 'One' },
      { id: 'two', filePath: join(root, 'two.flac'), title: 'Two' }
    ])
  )
  const client = workerClient(json, children)
  await client.getMetadata()
  const inspector = new DatabaseSync(getLibraryDatabasePath(json), { readOnly: true })
  t.after(async () => {
    inspector.close()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    client.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  return { client, inspector, children, json }
}

test('worker navigation preview returns one exact occurrence without committing or exposing a renderer method', async (t) => {
  const { client } = await queueWorkerFixture(t)
  const queue = await client.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const page = await client.readLibraryQueue(queue.id)
  assert.deepEqual(await client.readLibraryQueueNeighbor(queue.id, queue.revision, 0, -1, true), {
    ...page.items[2],
    logicalQueueEnd: true
  })
  assert.deepEqual(await client.readLibraryQueueNeighbor(queue.id, queue.revision, 2, 1, true), {
    ...page.items[0],
    logicalQueueEnd: false
  })
  assert.equal(await client.readLibraryQueueNeighbor(queue.id, queue.revision, 2, 1, false), null)
  const window = await client.readLibraryQueuePlaybackWindow(queue.id, queue.revision, 2, true)
  assert.deepEqual(window.queue, queue)
  assert.deepEqual(window.items, [page.items[2], { ...page.items[0], logicalQueueEnd: false }])
  assert.equal(window.lastPlayablePosition, 2)
  assert.equal(window.libraryRevision, page.libraryRevision)
  assert.deepEqual(await client.getLibraryQueue(queue.id), queue)
  await assert.rejects(
    client.readLibraryQueueNeighbor(queue.id, queue.revision + 1, 0, 1, true),
    /变化|revision|changed/i
  )
})

async function waitForQueueCleanup(inspector: DatabaseSync) {
  const deadline = Date.now() + 10_000
  while (
    Number(inspector.prepare("SELECT count(*) AS n FROM queues WHERE state<>'ready'").get()?.n)
  ) {
    assert.ok(
      Date.now() < deadline,
      'worker background cleanup must converge without a new mutation'
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('real worker yields during completed checkpoint cleanup and recovers after termination mid-cleanup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'scan-cleanup-worker-')),
    json = join(root, 'music-library.json'),
    path = getLibraryDatabasePath(json),
    children: ChildProcess[] = [],
    clients: LibraryDatabaseServiceClient[] = []
  const seed = new LibraryDatabase(path)
  seed.replaceDocument({
    version: 2,
    revision: 5,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.wav'), title: 'Retained' }]
  })
  seed.sql
    .exec(`INSERT INTO scan_jobs(id,mode,roots,state,updated_at) VALUES('done','full','[]','completed',1234);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<30000)
    INSERT INTO scan_items SELECT 'done',printf('file-%05d',i),'{}','committed',NULL,1,1 FROM n;
    INSERT INTO scan_directories VALUES('done','root','complete',NULL);`)
  const progress = seed.getScanProgress('done'),
    queue = seed.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' }),
    queuePage = seed.readLibraryQueue(queue.id)
  seed.close()
  const inspector = new DatabaseSync(path, { readOnly: true })
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill()
        await exit
      }
    for (const client of clients) client.destroy()
    inspector.close()
    rmSync(root, { recursive: true, force: true })
  })
  const client = workerClient(json, children)
  clients.push(client)
  const page = await client.queryTracks({ limit: 1 })
  assert.equal(page.tracks[0].title, 'Retained')
  const left = Number(inspector.prepare('SELECT count(*) AS n FROM scan_items').get()!.n)
  assert.ok(left > 0 && left < 30000, 'ordinary query must return between bounded cleanup pulses')
  assert.deepEqual(await client.getScanProgress('done'), progress)
  const exit = once(children[0], 'exit')
  children[0].kill()
  await exit
  assert.ok(Number(inspector.prepare('SELECT count(*) AS n FROM scan_items').get()!.n) > 0)
  const restarted = workerClient(json, children)
  clients.push(restarted)
  assert.deepEqual(await restarted.getScanProgress('done'), progress)
  const deadline = Date.now() + 10000
  while (
    inspector.prepare("SELECT checkpoints_reclaimed FROM scan_jobs WHERE id='done'").get()!
      .checkpoints_reclaimed !== 1
  ) {
    assert.ok(Date.now() < deadline, 'cleanup must resume and drain without a mutation')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(inspector.prepare('SELECT count(*) AS n FROM scan_items').get()!.n, 0)
  assert.equal(inspector.prepare('SELECT count(*) AS n FROM scan_directories').get()!.n, 0)
  assert.deepEqual(await restarted.getScanProgress('done'), progress)
  assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
  assert.deepEqual(await restarted.readLibraryQueue(queue.id), queuePage)
  assert.equal(inspector.prepare('SELECT updated_at FROM scan_jobs').get()!.updated_at, 1234)
})

test('real worker streams both queue orders in bounded pages and restart keeps publication but abandons an unfinished seed', async (t) => {
  const { client, inspector, children } = await queueWorkerFixture(t)
  const metadata = await client.getMetadata()
  const id = 'worker-stream-ready'
  await client.buildLibraryQueue({
    kind: 'begin',
    id,
    order: 'shuffle',
    contentRevision: metadata.revision
  })
  const originals = Array.from({ length: 605 }, (_, index) =>
    index % 7 === 0
      ? {
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: 'ncm:7', source: 'ncm', title: `Remote ${index}` }
        }
      : { id: index % 2 ? 'one' : 'two' }
  )
  const displayed = originals.map((_, index) => {
    const originalPosition = (index + 200) % originals.length
    return { ...originals[originalPosition], originalPosition }
  })
  let sequence = 0
  for (let offset = 0; offset < displayed.length; offset += 200) {
    const reply = await client.buildLibraryQueue({
      kind: 'append',
      id,
      sequence: ++sequence,
      items: displayed.slice(offset, offset + 200)
    })
    assert.deepEqual(reply, {
      kind: 'building',
      id,
      sequence,
      total: Math.min(displayed.length, offset + 200)
    })
    assert.equal(
      inspector.prepare('SELECT state FROM queues WHERE id=?').get(id)?.state,
      'building'
    )
    await assert.rejects(client.getLibraryQueue(id), /does not exist/)
    assert.equal(
      (await client.getTracksByIds(['one'])).tracks.length,
      1,
      'an unfinished seed does not block ordinary reads'
    )
  }
  const reply = await client.buildLibraryQueue({
    kind: 'commit',
    id,
    sequence: ++sequence,
    selectedIndex: 0
  })
  if (reply.kind !== 'ready') throw new Error('Expected ready worker queue')
  assert.equal(reply.queue.total, 605)
  assert.equal(reply.queue.order, 'shuffle')
  const tail = await client.readLibraryQueue(id, 600, 200)
  assert.equal(tail.items.length, 5)
  assert.deepEqual(
    tail.items.map((row) => row.track?.id),
    displayed.slice(600).map((item) => item.id)
  )
  await client.buildLibraryQueue({
    kind: 'begin',
    id: 'worker-stream-interrupted',
    order: 'original',
    contentRevision: metadata.revision
  })
  await client.buildLibraryQueue({
    kind: 'append',
    id: 'worker-stream-interrupted',
    sequence: 1,
    items: Array(200).fill({ id: 'one' })
  })
  const child = children.at(-1)!
  child.kill()
  await once(child, 'exit')
  assert.deepEqual(await client.getLibraryQueue(id), reply.queue)
  assert.deepEqual(await client.readLibraryQueue(id, 600, 200), tail)
  await assert.rejects(
    client.buildLibraryQueue({
      kind: 'commit',
      id: 'worker-stream-interrupted',
      sequence: 2,
      selectedIndex: 0
    }),
    /expired/
  )
  await waitForQueueCleanup(inspector)
  assert.equal(
    inspector.prepare('SELECT 1 FROM queues WHERE id=?').get('worker-stream-interrupted'),
    undefined
  )
  const restored = await client.editLibraryQueue(id, reply.queue.revision, {
    kind: 'order',
    order: 'original'
  })
  assert.equal(restored.queue.index, 200)
  const first = await client.readLibraryQueue(id, 0, 200)
  assert.deepEqual(
    first.items.map((row) => row.track?.id),
    originals.slice(0, 200).map((item) => item.id)
  )
  assert.deepEqual(await client.getMetadata(), metadata)
})

test('real worker rejects an oversized seed, releases its shared build slot and cannot replay the rejected batch', async (t) => {
  const { client, inspector } = await queueWorkerFixture(t)
  const { revision } = await client.getMetadata()
  const id = 'worker-stream-invalid'
  await client.buildLibraryQueue({
    kind: 'begin',
    id,
    order: 'original',
    contentRevision: revision
  })
  await assert.rejects(
    client.buildLibraryQueue({
      kind: 'append',
      id,
      sequence: 1,
      items: Array(201).fill({ id: 'one' })
    }),
    /oversized/
  )
  await assert.rejects(
    client.buildLibraryQueue({ kind: 'append', id, sequence: 1, items: [{ id: 'one' }] }),
    /expired/
  )
  await waitForQueueCleanup(inspector)
  assert.equal(inspector.prepare('SELECT 1 FROM queues WHERE id=?').get(id), undefined)
  assert.equal(inspector.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 0)
})

test('worker recent activity uses indexed timestamp and reverse-insertion ties, and freezes the same full order', async (t) => {
  const { client } = await queueWorkerFixture(t)
  const initial = await client.queryTracks({ sort: 'recentlyAdded', limit: 1 })
  assert.deepEqual(
    await client.getTracksByIds([]),
    {
      tracks: [],
      versions: {},
      revision: initial.revision,
      total: 0,
      offset: 0,
      historyRevision: 0
    },
    'empty-ID version probes must not transfer configuration or exclusions'
  )
  assert.deepEqual(
    initial.tracks.map((track) => track.id),
    ['two']
  )
  const track = await client.getTracksByIds(['one'])
  await client.patchTracks([
    { id: 'one', expectedVersion: track.versions.one, patch: { addedAt: 50 } }
  ])
  const recent = await client.queryTracks({ sort: 'recentlyAdded', limit: 1 })
  assert.ok(recent.revision > initial.revision)
  assert.equal((await client.getTracksByIds([])).revision, recent.revision)
  await assert.rejects(client.getTracksByIds([], initial.revision), /发生变化/)
  assert.deepEqual(
    recent.tracks.map((track) => track.id),
    ['one']
  )
  const queue = await client.createLibraryQueue(
    { sort: 'recentlyAdded', contentRevision: recent.revision },
    'two'
  )
  assert.equal(queue.total, 2)
  assert.equal(queue.index, 1)
  assert.deepEqual(
    (await client.readLibraryQueue(queue.id)).items.map((item) => item.track?.id),
    ['one', 'two']
  )
})

test('transport is lazy, waits for database open, and bounds pending requests including startup', async (t) => {
  const child = new ManualProcess()
  let forks = 0
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    maxPendingRequests: 2,
    fork: () => {
      forks++
      return child
    }
  })
  t.after(() => client.destroy())
  assert.equal(forks, 0)
  const first = client.getMetadata(),
    second = client.queryTracks({ limit: 200 })
  await assert.rejects(client.getMetadata(), /queue is full/)
  assert.equal(forks, 1)
  child.emit('message', { kind: 'ready' })
  await tick()
  assert.deepEqual(child.messages, [
    { kind: 'open', libraryFilePath: 'library.json', coverCacheDir: undefined }
  ])
  child.emit('message', { kind: 'opened' })
  await tick()
  for (const request of child.messages)
    if (request.kind === 'call')
      child.emit('message', {
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: { revision: 1 }
      })
  assert.deepEqual(await first, { revision: 1 })
  assert.deepEqual(await second, { revision: 1 })
})

test('worker exit rejects an unconfirmed mutation and never silently replays it', async (t) => {
  const child = new ManualProcess()
  let forks = 0
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    fork: () => {
      forks++
      return child
    }
  })
  t.after(() => client.destroy())
  const pending = client.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'next' } }])
  child.emit('message', { kind: 'ready' })
  child.emit('message', { kind: 'opened' })
  await tick()
  child.emit('exit', 1)
  await assert.rejects(pending, /Refresh its state before retrying a write/)
  assert.equal(forks, 1)
  assert.equal(child.messages.filter((message) => message.kind === 'call').length, 1)
})

test('an unknown streamed publication rejects without replaying commit or opening a replacement worker', async (t) => {
  const child = new ManualProcess()
  let forks = 0
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    fork: () => {
      forks++
      return child
    }
  })
  t.after(() => client.destroy())
  const command = { kind: 'commit' as const, id: 'uncertain-stream', sequence: 2, selectedIndex: 0 }
  const pending = client.buildLibraryQueue(command)
  child.emit('message', { kind: 'ready' })
  child.emit('message', { kind: 'opened' })
  await tick()
  child.emit('exit', 1)
  await assert.rejects(pending, /Refresh its state before retrying a write/)
  assert.equal(forks, 1)
  const calls = child.messages.filter((message) => message.kind === 'call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'buildLibraryQueue')
  assert.deepEqual(calls[0].args, [command])
})

test('startup failure rejects every waiting request without JSON fallback', async (t) => {
  const child = new ManualProcess()
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    fork: () => child
  })
  t.after(() => client.destroy())
  const one = client.getMetadata(),
    two = client.queryTracks()
  child.emit('message', { kind: 'open-error', error: 'Migration rejected malformed library' })
  await assert.rejects(one, /Migration rejected/)
  await assert.rejects(two, /Migration rejected/)
})

test('actual database process recovers WAL data, preserves cancelled scans and marks interrupted work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-worker-'))
  const json = join(root, 'music-library.json'),
    audio = join(root, 'one.flac')
  writeFileSync(json, JSON.stringify({ version: 2, revision: 4, tracks: [], folders: [root] }))
  writeFileSync(audio, 'fixture')
  const children: ChildProcess[] = []
  const factory = () => workerClient(json, children)
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    rmSync(root, { recursive: true, force: true })
  })
  const first = factory()
  await first.getMetadata()
  await first.startScan({ id: 'cancelled', mode: 'full', roots: [root] })
  await first.setScanState('cancelled', 'cancelled')
  await first.startScan({ id: 'running', mode: 'startup', roots: [root] })
  const info = statSync(audio)
  await first.recordScanFiles('running', [
    { filePath: audio, size: info.size, mtimeMs: info.mtimeMs }
  ])
  await first.claimScanFiles('running')
  await first.commitScanBatch({
    jobId: 'running',
    sequence: 1,
    files: [
      {
        identity: { filePath: audio, size: info.size, mtimeMs: info.mtimeMs },
        tracks: [
          {
            id: 'one',
            filePath: audio,
            title: 'Committed before crash',
            artist: '周杰伦',
            album: 'Release',
            genre: 'Rock',
            duration: 60
          }
        ],
        metadataRead: true
      }
    ]
  })
  // Terminate without closing the database: recovery must consume its WAL, not legacy JSON.
  await first.syncListeningHistory({ kind: 'begin', id: 'durable-history', mode: 'replace' })
  await first.syncListeningHistory({
    kind: 'append',
    id: 'durable-history',
    sequence: 1,
    entries: [{ id: 'one', lastPlayed: 12345 }]
  })
  await first.syncListeningHistory({ kind: 'commit', id: 'durable-history', sequence: 2 })
  await first.syncListeningHistory({ kind: 'begin', id: 'unfinished-history', mode: 'replace' })
  await first.syncListeningHistory({
    kind: 'append',
    id: 'unfinished-history',
    sequence: 1,
    entries: [{ id: 'one', lastPlayed: 99999 }]
  })
  const exited = once(children[0], 'exit')
  first.destroy()
  await exited
  const restarted = factory()
  try {
    assert.equal((await restarted.queryTracks()).tracks[0].title, 'Committed before crash')
    assert.equal((await restarted.queryTracks()).totalDuration, 60)
    const unified = await restarted.queryTracks({
      search: 'zjl',
      sort: 'unifiedSearch',
      preferredSources: [versionSourceKey({ id: 'one', filePath: audio })],
      limit: 1
    })
    assert.equal(unified.total, 1)
    assert.equal(unified.tracks[0].id, 'one')
    assert.equal(unified.revision, (await restarted.getMetadata()).revision)
    const frozenSearch = await restarted.createLibraryQueue(
      { search: 'zjl', sort: 'playlist', contentRevision: unified.revision },
      'one'
    )
    assert.equal(frozenSearch.total, 1)
    await assert.rejects(
      restarted.createLibraryQueue({ search: 'zjl', contentRevision: unified.revision - 1 }, 'one'),
      /发生变化/
    )
    const paths = await restarted.lookupTracksByPaths([audio, 'one.flac', 'missing.flac'])
    assert.deepEqual(paths.ids, ['one', 'one', null])
    const playlist = await restarted.lookupPlaylistTracks(
      { entries: [{ id: 'one' }, { id: 'missing' }], versions: [] },
      paths.revision
    )
    assert.deepEqual(playlist.ids, ['one', null])
    assert.equal(playlist.revision, paths.revision)
    const recent = await restarted.lookupPlaylistTracks(
      {
        entries: [
          { id: 'history:one', sourceIds: ['absent', 'one'] },
          {
            id: 'history:fallback',
            snapshot: {
              id: 'gone',
              title: 'Committed before crash',
              artist: '周杰伦',
              duration: 999
            }
          }
        ],
        versions: [],
        resolution: 'recent'
      },
      paths.revision
    )
    assert.deepEqual(recent.ids, ['one', 'one'])
    assert.equal(recent.revision, paths.revision)
    await assert.rejects(
      restarted.lookupPlaylistTracks({ entries: [], versions: [] }, paths.revision - 1),
      /发生变化/
    )
    assert.equal(
      (await restarted.getTracksByIds(['one'], paths.revision)).tracks[0].title,
      'Committed before crash'
    )
    await assert.rejects(restarted.lookupTracksByPaths([audio], paths.revision - 1), /发生变化/)
    await assert.rejects(restarted.getTracksByIds(['one'], paths.revision - 1), /发生变化/)
    const duplicateCandidates = await restarted.readDuplicateCandidates()
    assert.equal(duplicateCandidates.items[0].id, 'one')
    assert.equal(duplicateCandidates.items[0].title, 'Committed before crash')
    assert.equal(duplicateCandidates.items[0].duration, 60)
    assert.equal(duplicateCandidates.nextCursor, null)
    assert.equal('lyrics' in duplicateCandidates.items[0], false)
    assert.equal(
      (await restarted.queryTracks({ sort: 'lastPlayed', historyRevision: 1 })).historyRevision,
      1
    )
    await assert.rejects(
      restarted.syncListeningHistory({ kind: 'commit', id: 'unfinished-history', sequence: 2 }),
      /session or sequence expired/
    )
    const artists = await restarted.queryCollections('artists', {
      collectionGenre: 'rock',
      limit: 1
    })
    assert.equal(artists.items[0].name, '周杰伦')
    assert.equal(artists.items[0].duration, 60)
    assert.deepEqual(artists.letterOffsets, { Z: 0 })
    assert.equal(artists.offset, 0)
    assert.equal('tracks' in artists.items[0], false)
    const albumCatalog = await restarted.queryCollections('albums', {
      search: 'release zjl',
      collectionSearchMode: 'albumTerms',
      limit: 1
    })
    assert.equal(albumCatalog.total, 1)
    assert.equal(albumCatalog.items[0].name, 'Release')
    const homeAlbums = await restarted.queryCollections('albums', {
      collectionSort: 'trackCount',
      direction: 'desc',
      limit: 5,
      contentRevision: paths.revision
    })
    assert.equal(homeAlbums.items[0].trackCount, 1)
    assert.equal(homeAlbums.total, 1)
    assert.equal(homeAlbums.revision, paths.revision)
    const artistCount = await restarted.queryCollections('artists', {
      collectionCountOnly: true,
      contentRevision: paths.revision
    })
    assert.equal(artistCount.total, 1)
    assert.deepEqual(artistCount.items, [])
    assert.deepEqual(artistCount.letterOffsets, {})
    const tail = await restarted.queryTracks({
      sort: 'insertion',
      direction: 'desc',
      limit: 6,
      contentRevision: paths.revision
    })
    assert.deepEqual(
      tail.tracks.map((track) => track.id),
      ['one']
    )
    assert.equal(
      (
        await restarted.queryCollections('albums', {
          search: 'releasezjl',
          collectionSearchMode: 'albumTerms',
          limit: 1
        })
      ).total,
      0
    )
    assert.equal(
      (
        await restarted.queryCollections('artists', {
          search: '周杰伦',
          collectionSearchMode: 'artistName',
          limit: 1
        })
      ).total,
      1
    )
    assert.equal(
      (
        await restarted.queryCollections('artists', {
          search: 'zjl',
          collectionSearchMode: 'artistName',
          limit: 1
        })
      ).total,
      0
    )
    const jobs = await restarted.listScanJobs()
    assert.equal(jobs.find((job) => job.id === 'running')?.state, 'interrupted')
    assert.equal(jobs.find((job) => job.id === 'cancelled')?.state, 'cancelled')
  } finally {
    restarted.destroy()
  }
})

test('a killed database worker retains queue edits, duplicate cursor and shuffle order', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-queue-worker-')),
    json = join(root, 'music-library.json')
  writeFileSync(
    json,
    JSON.stringify({
      version: 2,
      revision: 4,
      folders: [],
      tracks: [
        { id: 'one', filePath: join(root, 'one.flac') },
        { id: 'two', filePath: join(root, 'two.flac') }
      ]
    })
  )
  const children: ChildProcess[] = []
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    rmSync(root, { recursive: true, force: true })
  })
  const client = workerClient(json, children)
  let queue = await client.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const duplicate = (await client.readLibraryQueue(queue.id)).items[2].queueEntryId
  queue = (
    await client.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId: duplicate })
  ).queue
  queue = (
    await client.editLibraryQueue(queue.id, queue.revision, {
      kind: 'insert',
      afterEntryId: duplicate,
      trackIds: ['two', 'two']
    })
  ).queue
  queue = (
    await client.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' })
  ).queue
  const page = await client.readLibraryQueue(queue.id)
  assert.equal(page.items.length, 5)
  assert.equal(page.items[0].queueEntryId, duplicate)
  const exited = once(children[0], 'exit')
  // Kill without SQLite close/checkpoint; the new process must read committed WAL.
  children[0].kill()
  await exited
  const restarted = workerClient(json, children)
  try {
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await restarted.readLibraryQueue(queue.id), page)
    const portable = await restarted.exportPlaybackQueue(
      { id: queue.id, revision: queue.revision, entryId: duplicate, index: queue.index },
      32 * 1024 * 1024 - 1024
    )
    assert.equal(portable.queue.length, 5)
    assert.equal(portable.queue[portable.queueIndex].queueEntryId, duplicate)
    await assert.rejects(
      restarted.editLibraryQueue(queue.id, queue.revision - 1, { kind: 'clear' }),
      /changed concurrently/
    )
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    const original = (
      await restarted.editLibraryQueue(queue.id, queue.revision, {
        kind: 'order',
        order: 'original'
      })
    ).queue
    assert.equal(original.index, 2)
    assert.equal(original.selectedEntryId, duplicate)
    assert.deepEqual(
      (await restarted.readLibraryQueue(queue.id)).items.map((item) => item.track?.id),
      ['one', 'two', 'one', 'two', 'two']
    )
    await restarted.deleteLibraryQueue(queue.id, original.revision)
    await assert.rejects(restarted.getLibraryQueue(queue.id), /does not exist/)
  } finally {
    client.destroy()
    restarted.destroy()
  }
})

test(
  'actual worker prepares playlist catalog summaries cooperatively and loses only the private projection on restart',
  { timeout: 30_000 },
  async (t) => {
    const { client, children } = await queueWorkerFixture(t)
    await client.syncPlaylistView({ kind: 'begin', id: 'catalog', versions: [], catalog: true })
    let sequence = 0
    for (let i = 0; i < 405; i += 200)
      await client.syncPlaylistView({
        kind: 'groups',
        id: 'catalog',
        sequence: ++sequence,
        groups: Array.from({ length: Math.min(200, 405 - i) }, (_, j) => ({
          id: String(i + j),
          name: `Mix ${i + j}`,
          isDefault: i + j === 0
        }))
      })
    const count = 12_005
    for (let i = 0; i < count; i += 200)
      await client.syncPlaylistView({
        kind: 'append',
        id: 'catalog',
        sequence: ++sequence,
        entries: Array.from({ length: Math.min(200, count - i) }, (_, j) => ({
          id: (i + j) % 2 ? 'one' : 'two',
          collectionId: String((i + j) % 405)
        }))
      })
    await client.syncPlaylistView({ kind: 'commit', id: 'catalog', sequence: ++sequence })
    let finished = false
    const pending = client
      .queryCollections('playlists', { playlistView: 'catalog', offset: 400 })
      .then((page) => {
        finished = true
        return page
      })
    assert.equal((await client.getTracksByIds(['one'])).tracks[0].id, 'one')
    assert.equal(finished, false, 'ordinary reads are served between catalog projection batches')
    const last = await pending
    assert.equal(last.total, 405)
    assert.equal(last.items.length, 5)
    assert.equal(last.items[0].id, '400')
    assert.ok(last.items.every((summary) => summary.trackCount === 29))
    assert.equal('trackIds' in last.items[0], false)
    const changed = await client.patchTracks([
      { id: 'one', expectedVersion: 1, patch: { duration: 7 } }
    ])
    const refreshed = await client.queryCollections('playlists', {
      playlistView: 'catalog',
      limit: 1
    })
    assert.equal(refreshed.revision, changed.revision)
    assert.equal(refreshed.items[0].trackCount, 30)
    assert.equal(refreshed.items[0].duration, 105)
    const exiting = once(children[0], 'exit')
    children[0].kill()
    await exiting
    await assert.rejects(
      client.queryCollections('playlists', { playlistView: 'catalog' }),
      /expired/
    )
    assert.equal((await client.getTracksByIds(['one'])).tracks[0].duration, 7)
  }
)

test('mixed playlist views disappear on worker restart but committed mixed queues and remote occurrences survive', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-playlist-worker-')),
    json = join(root, 'music-library.json')
  writeFileSync(
    json,
    JSON.stringify([{ id: 'one', title: 'Local', filePath: join(root, 'one.flac') }])
  )
  const children: ChildProcess[] = []
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    rmSync(root, { recursive: true, force: true })
  })
  const client = workerClient(json, children)
  let restarted: LibraryDatabaseServiceClient | undefined
  try {
    await client.syncPlaylistView({ kind: 'begin', id: 'view', versions: [] })
    await client.syncPlaylistView({
      kind: 'append',
      id: 'view',
      sequence: 1,
      entries: [
        { id: 'one' },
        {
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: '', title: 'Remote', artist: 'Artist', source: 'ncm' }
        },
        {
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: '', title: 'Remote', artist: 'Artist', source: 'ncm' }
        }
      ]
    })
    await client.syncPlaylistView({ kind: 'commit', id: 'view', sequence: 2 })
    const page = await client.queryTracks({ playlistView: 'view', sort: 'playlist' })
    assert.deepEqual(page.entryIds, ['0', '1', '2'])
    const queue = await client.createLibraryQueue(
      {
        playlistView: 'view',
        sort: 'playlist',
        playlistEntryId: '2',
        contentRevision: page.revision
      },
      'ncm:7'
    )
    const queued = await client.readLibraryQueue(queue.id)
    const exit = once(children[0], 'exit')
    children[0].kill()
    await exit
    restarted = workerClient(json, children)
    await assert.rejects(restarted.queryTracks({ playlistView: 'view' }), /expired/)
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await restarted.readLibraryQueue(queue.id), queued)
    const previous = await restarted.editLibraryQueue(queue.id, queue.revision, {
      kind: 'step',
      direction: -1,
      wrap: false
    })
    assert.equal(previous.queue.index, 1)
    const exported = await restarted.exportPlaybackQueue(
      {
        id: queue.id,
        revision: previous.queue.revision,
        entryId: previous.queue.selectedEntryId!,
        index: 1
      },
      32000
    )
    assert.equal(exported.queue[1].source, 'ncm')
    await restarted.deleteLibraryQueue(queue.id, previous.queue.revision)
  } finally {
    client.destroy()
    restarted?.destroy()
  }
})

test(
  'actual worker lets ordinary reads and playback pass two cold views and shared-build readers',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'playlist-worker-fair-')),
      json = join(root, 'music-library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac'), title: 'One' },
        { id: 'two', filePath: join(root, 'two.flac'), title: 'Two' }
      ])
    )
    const client = workerClient(json, children)
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    const queue = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'a')
    await uploadWorkerView(client, 'b')
    const finished: string[] = []
    const a = client
      .queryTracks({ playlistView: 'a', sort: 'playlist', offset: 12_000 })
      .then((result) => {
        finished.push('a')
        return result
      })
    const b = client.queryTracks({ playlistView: 'b', sort: 'playlist' }).then((result) => {
      finished.push('b')
      return result
    })
    const shared = client
      .queryTracks({ playlistView: 'a', sort: 'playlist', offset: 200 })
      .then((result) => {
        finished.push('shared')
        return result
      })
    const quick = await Promise.all([
      client.getMetadata(),
      client.queryTracks({ sort: 'playlist', limit: 1 }),
      client.getTracksByIds(['two']),
      client.readLibraryQueue(queue.id)
    ])
    assert.deepEqual(finished, [], 'cold preparation must leave the serial owner between batches')
    assert.equal(quick[0].trackCount, 2)
    assert.equal(quick[1].tracks.length, 1)
    assert.equal(quick[2].tracks[0].id, 'two')
    assert.equal(quick[3].items[0].track?.id, 'one')
    const pages = await Promise.all([a, b, shared])
    assert.deepEqual(
      pages.map((page) => page.total),
      [12_005, 12_005, 12_005]
    )
    assert.deepEqual(pages[0].entryIds, ['12000', '12001', '12002', '12003', '12004'])
    assert.equal(pages[2].entryIds?.[0], '200')
  }
)

test(
  'actual worker rejects an in-progress old revision or dropped view and rebuilds only on a fresh request',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'playlist-worker-invalidate-')),
      json = join(root, 'music-library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac'), title: 'One' },
        { id: 'two', filePath: join(root, 'two.flac'), title: 'Two' }
      ])
    )
    const client = workerClient(json, children)
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    await uploadWorkerView(client, 'revision')
    const stale = assert.rejects(client.queryTracks({ playlistView: 'revision' }), /变化/)
    await client.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Updated' } }])
    await stale
    assert.equal((await client.getTracksByIds(['one'])).tracks[0].title, 'Updated')
    const fresh = await client.queryTracks({
      playlistView: 'revision',
      search: 'Updated',
      sort: 'playlist'
    })
    assert.equal(fresh.total, 6002)
    assert.equal(
      fresh.tracks.every((track) => track.title === 'Updated'),
      true
    )
    await uploadWorkerView(client, 'history')
    const oldHistory = assert.rejects(
      client.queryTracks({ playlistView: 'history', sort: 'lastPlayed', direction: 'desc' }),
      /Listening history changed/
    )
    await client.syncListeningHistory({ kind: 'begin', id: 'interleaved-history', mode: 'replace' })
    await client.syncListeningHistory({
      kind: 'append',
      id: 'interleaved-history',
      sequence: 1,
      entries: [{ id: 'one', lastPlayed: 999 }]
    })
    await client.syncListeningHistory({ kind: 'commit', id: 'interleaved-history', sequence: 2 })
    await oldHistory
    const currentHistory = await client.queryTracks({
      playlistView: 'history',
      sort: 'lastPlayed',
      direction: 'desc'
    })
    assert.equal(currentHistory.total, 12_005)
    assert.equal(currentHistory.tracks[0].id, 'one')
    await uploadWorkerView(client, 'dropped')
    const cancelled = assert.rejects(client.queryTracks({ playlistView: 'dropped' }), /expired/)
    await client.syncPlaylistView({ kind: 'drop', id: 'dropped' })
    await cancelled
    assert.equal((await client.queryTracks()).total, 2)
    // A released slot is eventually reclaimed by the worker without another sync.
    let released = false
    for (let i = 0; i < 200 && !released; i++) {
      try {
        await client.syncPlaylistView({ kind: 'begin', id: 'dropped', versions: [] })
        released = true
      } catch (error) {
        assert.match(String(error), /being released/)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    assert.equal(released, true)
  }
)

test(
  'closing a worker during cold preparation rejects the pending read instead of publishing a partial page',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'playlist-worker-close-')),
      json = join(root, 'music-library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac') },
        { id: 'two', filePath: join(root, 'two.flac') }
      ])
    )
    const client = workerClient(json, children)
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    await uploadWorkerView(client, 'closing')
    const pending = assert.rejects(client.queryTracks({ playlistView: 'closing' }), /not open/)
    await client.getMetadata()
    children[0].send({ kind: 'close', requestId: 'close-test' })
    await pending
  }
)

test(
  'actual worker builds two complete mixed queues without blocking ordinary reads or the currently playing queue',
  { timeout: 30_000 },
  async (t) => {
    const { client, inspector } = await queueWorkerFixture(t)
    const previous = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'large', 32_005, true)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const finished: string[] = []
    const a = client
      .createLibraryQueue(
        { playlistView: 'large', sort: 'playlist', playlistEntryId: '31997' },
        'ncm:7'
      )
      .then((queue) => {
        finished.push('a')
        return queue
      })
    const b = client
      .createLibraryQueue(
        { playlistView: 'large', sort: 'playlist', playlistEntryId: '0' },
        'ncm:7'
      )
      .then((queue) => {
        finished.push('b')
        return queue
      })
    const quick = await Promise.all([
      client.getMetadata(),
      client.getTracksByIds(['one']),
      client.queryTracks({ sort: 'playlist', limit: 1 }),
      client.readLibraryQueue(previous.id)
    ])
    assert.deepEqual(
      finished,
      [],
      'building queue rows must leave the serial owner between batches'
    )
    assert.equal(quick[0].trackCount, 2)
    assert.equal(quick[1].tracks[0].id, 'one')
    assert.equal(quick[2].total, 2)
    assert.equal(quick[3].items[0].track?.id, 'one')
    assert.equal(
      inspector.prepare("SELECT count(*) AS n FROM queues WHERE state='building'").get()?.n,
      2
    )
    const queues = await Promise.all([a, b])
    assert.deepEqual(
      queues.map((queue) => queue.total),
      [32_005, 32_005]
    )
    assert.deepEqual(
      queues.map((queue) => queue.index),
      [31_997, 0]
    )
    for (const queue of queues) {
      const selected = (await client.readLibraryQueue(queue.id, queue.index, 1)).items[0]
      assert.equal(selected.queueEntryId, queue.selectedEntryId)
      assert.equal(selected.track?.source, 'ncm')
    }
    assert.notEqual(queues[0].selectedEntryId, queues[1].selectedEntryId)
    await client.syncPlaylistView({ kind: 'drop', id: 'large' })
    assert.equal((await client.readLibraryQueue(queues[0].id, 32_000)).items.length, 5)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
  }
)

test(
  'actual worker abandons queue construction promptly on content/history changes or view release',
  { timeout: 30_000 },
  async (t) => {
    const { client, inspector } = await queueWorkerFixture(t)
    const previous = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'large', 32_005, true)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const old = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'playlist' }),
      /变化/
    )
    await client.getMetadata()
    assert.equal(
      inspector.prepare("SELECT count(*) AS n FROM queues WHERE state='building'").get()?.n,
      1
    )
    await client.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Updated' } }])
    await old
    await waitForQueueCleanup(inspector)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const history = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'lastPlayed' }),
      /Listening history changed/
    )
    await client.getMetadata()
    await client.syncListeningHistory({ kind: 'begin', id: 'queue-history', mode: 'replace' })
    await client.syncListeningHistory({
      kind: 'append',
      id: 'queue-history',
      sequence: 1,
      entries: [{ id: 'one', lastPlayed: 100 }]
    })
    await client.syncListeningHistory({ kind: 'commit', id: 'queue-history', sequence: 2 })
    await history
    await waitForQueueCleanup(inspector)
    const released = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'playlist' }),
      /expired/
    )
    await client.getMetadata()
    await client.syncPlaylistView({ kind: 'drop', id: 'large' })
    await released
    await waitForQueueCleanup(inspector)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
    assert.equal((await client.queryTracks()).total, 2)
  }
)

test(
  'killing the actual worker mid-build never recovers a partial queue and preserves the committed mixed queue',
  { timeout: 30_000 },
  async (t) => {
    const { client, inspector, children, json } = await queueWorkerFixture(t)
    await uploadWorkerView(client, 'large', 32_005, true)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const ready = await client.createLibraryQueue(
      { playlistView: 'large', sort: 'playlist', playlistEntryId: '31997' },
      'ncm:7'
    )
    const before = await client.readLibraryQueue(ready.id, 31_995, 10)
    const pending = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'playlist' }),
      /exited/
    )
    await client.getMetadata()
    const hidden = String(
      inspector.prepare("SELECT id FROM queues WHERE state='building'").get()?.id
    )
    assert.notEqual(hidden, 'undefined')
    const exit = once(children[0], 'exit')
    children[0].kill()
    await exit
    await pending
    assert.equal(
      inspector.prepare('SELECT state FROM queues WHERE id=?').get(hidden)?.state,
      'building'
    )
    const restarted = workerClient(json, children)
    t.after(() => restarted.destroy())
    await restarted.getMetadata()
    await assert.rejects(restarted.getLibraryQueue(hidden), /does not exist/)
    assert.deepEqual(await restarted.getLibraryQueue(ready.id), ready)
    assert.deepEqual(await restarted.readLibraryQueue(ready.id, 31_995, 10), before)
    await waitForQueueCleanup(inspector)
    assert.equal(inspector.prepare('SELECT 1 FROM queues WHERE id=?').get(hidden), undefined)
  }
)

test(
  'an actual worker exits on failed durability restoration; its replacement recovers without replaying the failed queue',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'queue-sync-worker-')),
      json = join(root, 'music-library.json'),
      harness = join(root, 'worker-fault.mjs'),
      children: ChildProcess[] = [],
      calls: LibraryDatabaseWorkerRequest[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac') },
        { id: 'two', filePath: join(root, 'two.flac') }
      ])
    )
    writeFileSync(
      harness,
      `import { DatabaseSync } from 'node:sqlite';
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if(sql === 'PRAGMA synchronous=FULL') throw new Error('injected restore failure');
      return exec.call(this, sql);
    };
    await import(${JSON.stringify(new URL('./libraryDatabaseService.ts', import.meta.url).href)});`
    )
    const client = new LibraryDatabaseServiceClient({
      serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
      libraryFilePath: json,
      fork: (entry) => {
        const child = fork(children.length ? entry : harness, [], {
          execArgv: ['--experimental-strip-types'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        })
        children.push(child)
        Object.assign(child, {
          postMessage: (message: LibraryDatabaseWorkerRequest) => {
            calls.push(message)
            child.send(message)
          }
        })
        return child as unknown as DatabaseUtilityProcess
      }
    })
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    const previous = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'view', 605)
    await client.queryTracks({ playlistView: 'view', sort: 'playlist' })
    await assert.rejects(
      client.createLibraryQueue({ playlistView: 'view', sort: 'playlist' }),
      /exited.*Refresh/
    )
    assert.equal(children[0].exitCode, 1)
    await client.getMetadata()
    assert.equal(children.length, 2)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
    assert.equal(
      calls.filter((call) => call.kind === 'call' && call.method === 'createLibraryQueue').length,
      2
    )
    const patched = await client.patchTracks([
      { id: 'one', expectedVersion: 1, patch: { title: 'After recovery' } }
    ])
    assert.equal(patched.tracks[0].title, 'After recovery')
    const inspector = new DatabaseSync(getLibraryDatabasePath(json), { readOnly: true })
    try {
      await waitForQueueCleanup(inspector)
    } finally {
      inspector.close()
    }
  }
)

test(
  'killing migration leaves the source intact and the next worker rebuilds its staging database',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'library-migration-crash-')),
      json = join(root, 'music-library.json')
    const source = JSON.stringify({
      version: 2,
      revision: 23,
      folders: [root],
      tracks: Array.from({ length: 6000 }, (_, i) => ({
        id: `track:${i}`,
        filePath: join(root, `${i}.flac`),
        extension: 'x'.repeat(512)
      }))
    })
    writeFileSync(json, source)
    const children: ChildProcess[] = []
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      rmSync(root, { recursive: true, force: true })
    })
    const first = workerClient(json, children),
      pending = first.getMetadata()
    const rejected = assert.rejects(pending, /stopped|exited/)
    const staging = `${getLibraryDatabasePath(json)}.migrating`,
      deadline = Date.now() + 10_000
    while (!existsSync(staging) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(existsSync(staging))
    assert.equal(existsSync(getLibraryDatabasePath(json)), false)
    const exited = once(children[0], 'exit')
    first.destroy()
    await exited
    await rejected
    assert.equal(readFileSync(json, 'utf8'), source)
    const restarted = workerClient(json, children)
    try {
      const metadata = await restarted.getMetadata()
      assert.equal(metadata.trackCount, 6000)
      assert.equal(metadata.revision, 23)
      assert.equal(
        (await restarted.getTracksByIds(['track:5999'])).tracks[0].extension,
        'x'.repeat(512)
      )
      assert.equal(existsSync(staging), false)
    } finally {
      restarted.destroy()
    }
  }
)

test(
  'real worker aggregate preparation, variant sorting, full queues and recovery yield to normal reads and fence revisions',
  { timeout: 30_000 },
  async (t) => {
    const { client, children, json } = await queueWorkerFixture(t)
    const id = 'aggregate',
      count = 12_005
    await client.syncPlaylistView({ kind: 'begin', id, versions: [], preserveSources: true })
    let sequence = 0
    for (let offset = 0; offset < count; offset += 200)
      await client.syncPlaylistView({
        kind: 'append',
        id,
        sequence: ++sequence,
        entries: Array.from({ length: Math.min(200, count - offset) }, (_, i) => ({
          id: `ncm:${offset + i}`,
          snapshot: {
            id: `ncm:${offset + i}`,
            filePath: '',
            source: 'ncm',
            title: 'Same',
            artist: 'Artist',
            duration: 180
          }
        }))
      })
    await client.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence })
    const query = { playlistView: id, sort: 'playlist' as const, aggregate: {} }
    let done = false
    const cold = client.queryTracks(query).finally(() => {
      done = true
    })
    const rejected = assert.rejects(cold, /变化/)
    assert.equal((await client.getTracksByIds(['one'])).tracks.length, 1)
    assert.equal(done, false, 'cold aggregation must let ordinary reads finish before it')
    const patched = await client.patchTracks([
      { id: 'one', expectedVersion: 1, patch: { title: 'Persistent patch' } }
    ])
    await rejected
    const first = await client.queryTracks(query)
    assert.equal(first.total, count)
    assert.equal(first.tracks.length, 200)
    assert.equal(first.revision, patched.revision)
    let searchDone = false
    const ordinarySearch = client
      .queryTracks({ ...query, aggregate: undefined, search: 'same' })
      .finally(() => {
        searchDone = true
      })
    await client.getTracksByIds(['one'])
    assert.equal(searchDone, false, 'deferred occurrence FTS must yield to ordinary reads')
    const searched = await ordinarySearch
    assert.equal(searched.total, count)
    assert.equal(searched.tracks.length, 200)
    assert.deepEqual(searched.entryIds, first.entryIds)
    const last = await client.queryTracks({ ...query, offset: 12_000 })
    const queue = await client.createLibraryQueue(
      { ...query, contentRevision: last.revision, playlistEntryId: last.entryIds![4] },
      'ncm:12004'
    )
    assert.equal(queue.total, count)
    assert.equal(queue.index, 12_004)
    const window = await client.readLibraryQueue(queue.id, 12_000)
    assert.equal(window.items[4].track!.id, 'ncm:12004')

    // A single recording with many occurrences uses cooperative sort runs too.
    const variantsId = 'variants'
    await client.syncPlaylistView({
      kind: 'begin',
      id: variantsId,
      versions: [],
      preserveSources: true
    })
    sequence = 0
    for (let offset = 0; offset < count; offset += 200)
      await client.syncPlaylistView({
        kind: 'append',
        id: variantsId,
        sequence: ++sequence,
        entries: Array.from({ length: Math.min(200, count - offset) }, () => ({ id: 'two' }))
      })
    await client.syncPlaylistView({ kind: 'commit', id: variantsId, sequence: ++sequence })
    const row = await client.queryTracks({
      playlistView: variantsId,
      sort: 'playlist',
      aggregate: {}
    })
    let sorted = false
    const variants = client
      .queryTracks({
        playlistView: variantsId,
        sort: 'playlist',
        aggregate: { variantRow: row.aggregate!.rows[0].rowId },
        offset: 12_000
      })
      .finally(() => {
        sorted = true
      })
    await client.getTracksByIds(['one'])
    assert.equal(sorted, false)
    const page = await variants
    assert.equal(page.total, count)
    assert.deepEqual(page.entryIds, ['12000', '12001', '12002', '12003', '12004'])

    const dropping = assert.rejects(
      client.queryTracks({ ...query, search: 'new selection' }),
      /expired/
    )
    await client.getMetadata()
    await client.syncPlaylistView({ kind: 'drop', id })
    await dropping
    const exited = once(children[0], 'exit')
    children[0].kill()
    await exited
    const restarted = workerClient(json, children)
    t.after(() => restarted.destroy())
    await assert.rejects(
      restarted.queryTracks({ playlistView: variantsId, sort: 'playlist', aggregate: {} }),
      /expired/
    )
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await restarted.readLibraryQueue(queue.id, 12_000), window)
    assert.equal((await restarted.getTracksByIds(['one'])).tracks[0].title, 'Persistent patch')
  }
)
