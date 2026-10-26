import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreCatalogService } from './service.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { CatalogDatabaseApi } from '../../shared/musicCatalog.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import type { TrackData } from '../../shared/track.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const track = (id: string, source = 'local'): TrackData => ({
  id,
  source,
  filePath: source === 'local' ? `D:/music/${id}.flac` : '',
  fileName: id,
  title: id,
  album: 'Album',
  artist: 'Artist',
  duration: 60,
  size: 0,
  cover: null,
  lyrics: null
})
function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  const api: CatalogDatabaseApi = {
    catalogStatus: async () => db.catalogStatus(),
    catalogAdvance: async (limit) => db.catalogAdvance(limit),
    catalogQuery: async (query) => db.catalogQuery(query),
    catalogDetail: async (...args) => db.catalogDetail(...args),
    catalogSources: async (query) => db.catalogSources(query),
    catalogSync: async (request) => db.catalogSync(request),
    catalogProjectVersions: async (...args) => db.catalogProjectVersions(...args),
    catalogResolve: async (...args) => db.catalogResolve(...args)
  }
  t.after(() => db.close())
  return { db, api }
}
async function idle(service: CoreCatalogService) {
  for (let i = 0; i < 1000; i++) {
    if ((await service.status()).state !== 'running') return
    await tick()
  }
  assert.fail('Catalog did not settle')
}

test('Core backfill starts after activation, yields, joins cancellation and resumes committed progress', async (t) => {
  const { db, api } = fixture(t)
  const locals = Array.from({ length: 450 }, (_, i) => track(`local:${i}`))
  db.replaceDocument({ version: 2, revision: 0, tracks: locals, folders: [], exclusions: [] })
  const revision = db.getContentRevision()
  let release!: () => void,
    advanced!: () => void,
    hold = true
  const entered = new Promise<void>((resolve) => {
    advanced = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new CoreCatalogService({
    database: api,
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: {
      getRevision: () => 0,
      sourceTracks: () => [track('ncm:1', 'ncm'), locals[0], track('radio:1', 'radio')]
    },
    changed: () => {},
    failed: (error) => assert.fail(String(error)),
    yield: async () => {
      if (hold) {
        advanced()
        await barrier
      }
      await tick()
    }
  })
  assert.equal(db.catalogStatus().playlistsRevision, null)
  service.activate()
  await entered
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 201)
  let cancelled = false
  const cancel = service.cancel().then(() => {
    cancelled = true
  })
  await tick()
  assert.equal(cancelled, false, 'cancellation joins dispatched work')
  release()
  await cancel
  assert.equal((await service.status()).state, 'paused')
  assert.equal((await service.status()).localPending, true)
  service.invalidate()
  await tick()
  assert.equal(
    (await service.status()).state,
    'paused',
    'source changes do not undo user cancellation'
  )
  hold = false
  service.refresh()
  await idle(service)
  assert.equal((await service.status()).localPending, false)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 451)
  assert.equal(db.getContentRevision(), revision)
  await service.shutdown()
})

test('changed playlist generations abort staging and reconcile only the current committed membership', async (t) => {
  const { db, api } = fixture(t)
  let revision = 1,
    old = true,
    aborted = 0,
    switched = false
  const sync = api.catalogSync
  api.catalogSync = async (request) => {
    if (request.kind === 'abort') aborted++
    return sync(request)
  }
  const before = Array.from({ length: 401 }, (_, i) => track(`ncm:${i}`, 'ncm'))
  const current = [track('ncm:current', 'ncm')]
  const service = new CoreCatalogService({
    database: api,
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: { getRevision: () => revision, sourceTracks: () => (old ? before : current) },
    changed: () => {},
    failed: (error) => assert.fail(String(error)),
    yield: async () => {
      if (!switched) {
        switched = true
        old = false
        revision++
        assert.equal(db.catalogQuery({ kind: 'recording' }).total, 0)
        service.invalidate()
      }
      await tick()
    }
  })
  service.activate()
  await idle(service)
  assert.equal(aborted, 1)
  assert.equal(db.catalogStatus().playlistsRevision, 2)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].title, 'ncm:current')
  await service.shutdown()
})

test('database failures pause the derived job, expose a safe error and retry only on refresh', async (t) => {
  const { db, api } = fixture(t)
  const original = api.catalogProjectVersions
  let fails = true,
    reported = 0
  api.catalogProjectVersions = async (...args) => {
    if (fails) throw new Error('read https://private:password@host/music?token=secret failed')
    return original(...args)
  }
  const service = new CoreCatalogService({
    database: api,
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: { getRevision: () => 0, sourceTracks: () => [] },
    changed: () => {},
    failed: () => {
      reported++
    }
  })
  service.activate()
  await idle(service)
  assert.equal((await service.status()).state, 'failed')
  assert.equal((await service.status()).error?.includes('password'), false)
  assert.equal(reported, 1)
  service.invalidate()
  await tick()
  assert.equal(reported, 1)
  fails = false
  service.refresh()
  await idle(service)
  assert.equal((await service.status()).error, null)
  assert.equal(db.catalogStatus().versionsRevision, 0)
  await service.shutdown()
})

test('playlist indexing strips heavyweight source extensions before bounded worker transport', async (t) => {
  const { db, api } = fixture(t)
  const original = api.catalogSync
  let appends = 0
  api.catalogSync = async (request) => {
    if (request.kind === 'append') {
      appends++
      const serialized = JSON.stringify(request.tracks)
      assert.equal(serialized.includes('secret-extension'), false)
      assert.equal(serialized.includes('secret-token'), false)
      assert.ok(Buffer.byteLength(serialized) <= 1024 * 1024)
      assert.equal(request.tracks.length <= 200, true)
    }
    return original(request)
  }
  const tracks = Array.from({ length: 450 }, (_, i) => ({
    ...track(`ncm:${i}`, 'ncm'),
    title: 'A'.repeat(8192),
    lyrics: 'heavy'.repeat(10000),
    cover: 'data:image/png;base64,heavy',
    streamUrl: 'https://private/?secret-token',
    custom: 'secret-extension'
  }))
  const service = new CoreCatalogService({
    database: api,
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: { getRevision: () => 0, sourceTracks: () => tracks },
    changed: () => {},
    failed: (error) => assert.fail(String(error)),
    yield: tick
  })
  service.activate()
  await idle(service)
  assert.ok(appends >= 4, 'byte bound splits batches below the 200-source item cap')
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 450)
  await service.shutdown()
})
