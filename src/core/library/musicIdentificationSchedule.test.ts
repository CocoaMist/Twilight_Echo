import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_IDENTIFICATION_SCHEDULE_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import { DatabaseSync } from 'node:sqlite'
import type { TrackData } from '../../shared/track.ts'
import type { IdentificationScheduleRequest } from '../../shared/musicIdentificationSchedule.ts'
import { defaultMusicIdentificationSettings } from '../../shared/musicIdentificationSchedule.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import { PlatformIdentificationProvider } from './musicIdentificationProvider.ts'
import { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { isCoreRequest, coreOperation } from '../../shared/coreProtocol.ts'

const provider = {
  id: 'platform.ncm',
  matcherVersion: 'fixture-v1',
  kinds: [
    'artist',
    'recording',
    'release',
    'album_project'
  ] as IdentificationScheduleRequest['providers'][number]['kinds']
}
const config = (
  patch: Partial<IdentificationScheduleRequest> = {}
): IdentificationScheduleRequest => ({
  enabled: true,
  newImports: true,
  history: false,
  providers: [provider],
  ...patch
})
const track = (n = 1): TrackData => ({
  id: `local-${n}`,
  source: 'local',
  filePath: `D:/music/${n}.flac`,
  fileName: `${n}.flac`,
  title: `Song ${n}`,
  artist: `Artist ${n}`,
  album: '',
  duration: 200,
  size: 0,
  cover: null,
  lyrics: null
})
function seed(db: LibraryDatabase, count = 1) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: count }, (_, i) => track(i + 1))
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
}
function platform(db: LibraryDatabase, items: TrackData[]) {
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: items })
  return job
}
const online = (): TrackData => ({
  ...track(),
  id: 'ncm:7',
  source: 'ncm',
  filePath: '',
  artists: [{ id: 9, name: 'Artist 1' }]
})
const empty = { state: 'identified' as const, proposals: [], incomplete: false, reasons: [] }
function drain(db: LibraryDatabase, request = config(), now = 1000) {
  for (let i = 0; i < 100; i++) {
    const result = db.identificationSchedule(request, now)
    if (!result.more) return result
  }
  throw new Error('Schedule did not drain')
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'identification-schedule-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, path: join(root, 'library.sqlite') }
}

test('automatic identification is off by default and source preferences persist in the existing Core settings file', (t) => {
  const { root } = fixture(t),
    filePath = join(root, 'settings.json')
  const options = {
    filePath,
    environment: {
      platform: 'win32' as const,
      resolvePath: resolve,
      defaultCachePath: join(root, 'cache')
    },
    changed() {}
  }
  const repository = new CoreSettingsRepository(options)
  assert.deepEqual(repository.read().musicIdentification, defaultMusicIdentificationSettings())
  repository.update({
    musicIdentification: { newImports: true, history: false, sources: ['platform.ncm'] }
  })
  assert.deepEqual(new CoreSettingsRepository(options).read().musicIdentification, {
    newImports: true,
    history: false,
    sources: ['platform.ncm']
  })
  assert.deepEqual(
    repository.normalize({
      musicIdentification: {
        newImports: true,
        history: false,
        sources: ['https://bad', 'platform.ncm', 'platform.ncm']
      }
    }).musicIdentification.sources,
    ['platform.ncm']
  )
})

test('new local input records an outbox in the catalog transaction but disabled automation creates no network jobs', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  assert.equal(db.identificationScheduleStatus().pending, 2)
  drain(db, config({ enabled: false }))
  assert.equal(db.metadataJobs({}).total, 0)
  drain(db)
  assert.equal(db.metadataJobs({}).total, 2)
  assert.ok(db.metadataClaim(1000)!.automatic)
})

test('platform staging, abort and search-only catalog rows never start automatic work; published membership does', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const staged = platform(db, [online()])
  assert.equal(db.identificationSchedule(config(), 1000).processed, 0)
  assert.equal(db.metadataJobs({}).total, 0)
  db.catalogSync({ kind: 'abort', id: staged.id })
  drain(db)
  assert.equal(db.metadataJobs({}).total, 0)
  const next = platform(db, [online()])
  db.catalogSync({ kind: 'commit', ...next })
  drain(db)
  assert.equal(db.metadataJobs({}).total, 2)
})

test('uncommitted local catalog pages wait for the complete generation, then repeated scans and display facts do not requeue', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks: [track()] })
  assert.equal(db.identificationSchedule(config(), 1000).processed, 0)
  db.catalogAdvance()
  drain(db)
  for (let work = db.metadataClaim(1000); work; work = db.metadataClaim(1000))
    db.metadataFinish(work, empty, 1001, config())
  const original = db.metadataJobs({}).items
  db.sql.exec("UPDATE catalog_sources SET payload=json_set(payload,'$.cover','changed')")
  assert.equal(db.identificationScheduleStatus().pending, 0)
  seed(db)
  drain(db, config(), 86400001)
  assert.deepEqual(db.metadataJobs({}).items, original)
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  db.sql.prepare("UPDATE catalog_entities SET title='Changed' WHERE id=?").run(artist)
  db.sql.prepare("UPDATE catalog_entities SET title='Artist 1' WHERE id=?").run(artist)
  drain(db, config(), 86400002)
  assert.equal(db.metadataJobs({ entityId: artist }).items[0].generation, 2)
})

test('history demand, fixed horizon and cursor publish atomically and resume across reopen without including later entities', (t) => {
  const { path } = fixture(t)
  let db = new LibraryDatabase(path)
  try {
    seed(db, 120)
    db.sql.exec('DELETE FROM metadata_identification_schedule')
    const request = config({ newImports: false, history: true })
    const first = db.identificationSchedule(request, 1000)
    assert.equal(first.processed, 200)
    assert.equal(first.more, true)
    assert.equal(db.metadataJobs({}).total, 200)
    db.close()
    db = new LibraryDatabase(path)
    assert.deepEqual(db.identificationScheduleStatus().history, first.history)
    seed(db, 121)
    const result = drain(db, request)
    assert.equal(result.history.horizon, first.history.horizon)
    assert.equal(result.history.cursor, result.history.horizon)
    assert.equal(db.metadataJobs({}).total, 240)
    const later = db.catalogQuery({ kind: 'recording', search: 'Song 121' }).items[0]
    assert.equal(db.metadataJobs({ entityId: later.id }).total, 0)
    const paused = db.identificationSchedule(config({ newImports: false, history: false }), 2000)
    assert.deepEqual(paused.history, result.history)
  } finally {
    db.close()
  }
})

test('a demand write failure rolls back the history horizon, cursor, outbox and all jobs together', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  db.sql.exec(`DELETE FROM metadata_identification_schedule;
    CREATE TRIGGER fail_demand BEFORE INSERT ON metadata_demands BEGIN SELECT RAISE(ABORT,'demand failed'); END;`)
  assert.throws(
    () => db.identificationSchedule(config({ newImports: false, history: true }), 1000),
    /demand failed/
  )
  assert.deepEqual(db.identificationScheduleStatus(), {
    pending: 0,
    history: { cursor: 0, horizon: null }
  })
  assert.equal(db.metadataJobs({}).total, 0)
  db.sql.exec('DROP TRIGGER fail_demand')
  drain(db, config({ newImports: false, history: true }))
  assert.equal(db.metadataJobs({}).total, 2)
})

test('removing the last actual member cancels its automatic consumer, never an explicit consumer of the same job', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.catalogSync({ kind: 'commit', ...platform(db, [online()]) })
  drain(db)
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  const manual = db.identificationEnqueue(
    { entityId: artist, batchId: 'manual', providers: [provider] },
    1000
  )[0]
  db.catalogSync({ kind: 'commit', ...platform(db, []) })
  drain(db)
  assert.equal(db.metadataJobs({ jobId: manual.id }).items[0].state, 'queued')
  assert.equal(
    db.sql.prepare("SELECT count(*) n FROM metadata_demands WHERE batch_id LIKE 'auto:%'").get()!.n,
    0
  )
  assert.equal(db.metadataJobs({}).items.filter((j) => j.state === 'cancelled').length, 1)
})

for (const manual of [false, true]) {
  test(`an in-flight automatic result respects settings changes while preserving a ${manual ? 'new explicit shared' : 'pure automatic'} demand`, (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    seed(db)
    const request = config({ providers: [{ ...provider, kinds: ['artist'] }] })
    drain(db, request)
    const work = db.metadataClaim(1000)!
    assert.equal(work.automatic!.origin, 'new')
    if (manual)
      db.identificationEnqueue(
        { entityId: work.job.entityId, batchId: 'manual', providers: [provider] },
        1001
      )
    assert.equal(db.metadataFinish(work, empty, 1002, config({ enabled: false })), true)
    assert.equal(
      db.metadataJobs({ jobId: work.job.id }).items[0].state,
      manual ? 'completed' : 'blocked'
    )
  })
}

test('last-member removal also fences already running automatic work', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.catalogSync({ kind: 'commit', ...platform(db, [online()]) })
  drain(db)
  const work = db.metadataClaim(1000)!
  db.catalogSync({ kind: 'commit', ...platform(db, []) })
  db.metadataFinish(work, empty, 1001, config())
  assert.equal(db.metadataJobs({ jobId: work.job.id }).items[0].reason, 'not_library_member')
})

test('explicit batch IDs keep their original meaning even when they use the automatic prefix', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  drain(db)
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  db.identificationEnqueue(
    { entityId: artist, batchId: `auto:${artist}`, providers: [provider] },
    1000
  )
  const work = db.metadataClaim(1000)!
  assert.equal(work.job.entityId, artist)
  assert.equal(work.automatic, undefined)
  db.metadataFinish(work, empty, 1001, config({ enabled: false }))
  assert.equal(db.metadataJobs({ jobId: work.job.id }).items[0].state, 'completed')
})

test('manual tasks take priority and old history gets one turn out of four without changing ordinary manual FIFO', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db, 5)
  db.sql.exec('DELETE FROM metadata_identification_schedule')
  const request = config({
    newImports: false,
    history: true,
    providers: [{ ...provider, kinds: ['artist'] }]
  })
  drain(db, request, 1000)
  const artists = db.catalogQuery({ kind: 'artist' }).items
  for (const artist of artists.slice(0, 4))
    db.identificationEnqueue(
      { entityId: artist.id, batchId: 'manual', providers: [provider] },
      61000
    )
  for (let turn = 0; turn < 4; turn++) {
    const work = db.metadataClaim(61000)!
    assert.equal(!!work.automatic, turn === 3)
    db.metadataFinish(work, empty, 61001, request)
  }
})

test('changing history or adding a provider does not rerun an unchanged completed provider', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  drain(db)
  for (let w = db.metadataClaim(1000); w; w = db.metadataClaim(1000))
    db.metadataFinish(w, empty, 1001, config())
  const before = db.metadataJobs({}).items
  drain(
    db,
    config({ history: true, providers: [provider, { ...provider, id: 'musicbrainz' }] }),
    86401000
  )
  assert.deepEqual(
    db.metadataJobs({}).items.filter((j) => j.provider === provider.id),
    before
  )
  assert.equal(db.metadataJobs({}).total, 4)
})

test('v16 migration backs up original storage and creates scheduling without automatically filling history', (t) => {
  const { root, path } = fixture(t)
  let db = new LibraryDatabase(path)
  seed(db)
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  db.sql.exec(LEGACY_IDENTIFICATION_SCHEDULE_SQL + 'PRAGMA user_version=16;')
  db.close()
  db = new LibraryDatabase(path)
  try {
    assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
    assert.deepEqual(db.identificationScheduleStatus(), {
      pending: 0,
      history: { cursor: 0, horizon: null }
    })
    assert.equal(db.identificationInput(artist).name, 'Artist 1')
    const backup = new DatabaseSync(
      join(root, readdirSync(root).find((n) => n.includes('.v16-backup-'))!)
    )
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 16)
    } finally {
      backup.close()
    }
  } finally {
    db.close()
  }
})

test('v17 DDL failure retains the old schema and its independently usable backup', (t) => {
  const { root, path } = fixture(t)
  const db = new LibraryDatabase(path)
  seed(db)
  db.sql.exec(
    LEGACY_IDENTIFICATION_SCHEDULE_SQL +
      `CREATE TABLE metadata_identification_schedule_state(x); PRAGMA user_version=16;`
  )
  db.close()
  assert.throws(() => new LibraryDatabase(path), /already exists/)
  const old = new DatabaseSync(path)
  try {
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, 16)
    assert.equal(
      old
        .prepare("SELECT 1 FROM sqlite_master WHERE name='metadata_identification_schedule'")
        .get(),
      undefined
    )
    assert.ok(readdirSync(root).some((n) => n.includes('.v16-backup-')))
  } finally {
    old.close()
  }
})

test('identification progress is a bounded read-only public query', () => {
  const request = {
    requestId: '1',
    epoch: 'core:1',
    kind: 'query',
    name: 'identification.status',
    payload: {}
  }
  assert.equal(isCoreRequest(request), true)
  assert.equal(isCoreRequest({ ...request, payload: { url: 'https://bad' } }), false)
  assert.equal(coreOperation('identification.status')!.permission, 'library:read')
})

test('Core automatically drains real members with its existing worker and reconciles an accepted dispatch whose receipt was lost', async (t) => {
  const db = new LibraryDatabase(':memory:')
  seed(db)
  let calls = 0,
    lost = true
  const errors: unknown[] = []
  const database = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) => {
        const result = (db[key] as (...a: unknown[]) => unknown).apply(db, args)
        if (key === 'identificationSchedule' && lost) {
          lost = false
          throw new Error('receipt lost')
        }
        return result
      }
  })
  const settings = { newImports: true, history: false, sources: [provider.id] }
  const policy = {
    enabled: true,
    publicServiceApproved: true,
    contact: 'https://example.com/app',
    wikipediaText: false
  }
  const service = new CoreEntityMetadataService({
    database,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    automation: () => settings,
    identificationProviders: () => [
      {
        id: provider.id,
        matcherVersion: provider.matcherVersion,
        supports: () => true,
        blockedReason: () => null,
        context: () => '',
        recall: async () => {
          calls++
          return { proposals: [], incomplete: false, reasons: [] }
        }
      }
    ],
    now: () => 1000,
    changed() {},
    failed: (e) => errors.push(e)
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
  })
  service.activate()
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (check()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('Core scheduling timed out')
  }
  await until(() => errors.length === 1)
  service.refreshIdentification()
  await until(
    () =>
      db.metadataJobs({}).items.length === 2 &&
      db.metadataJobs({}).items.every((j) => j.state === 'completed')
  )
  assert.equal(calls, 2)
  assert.equal(errors.length, 1)
  service.refreshIdentification()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls, 2)
})

test('disabling automatic settings aborts its HTTP work and recovers a newly shared explicit demand', async (t) => {
  const db = new LibraryDatabase(':memory:')
  seed(db)
  const settings = { newImports: true, history: false, sources: [provider.id] },
    policy = {
      enabled: true,
      publicServiceApproved: true,
      contact: 'https://example.com/app',
      wikipediaText: false
    }
  let entered = false,
    aborted = false,
    calls = 0
  const database = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...a: unknown[]) => unknown).apply(db, args)
  })
  const service = new CoreEntityMetadataService({
    database,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    automation: () => settings,
    identificationProviders: () => [
      {
        id: provider.id,
        matcherVersion: provider.matcherVersion,
        supports: (k) => k === 'artist',
        blockedReason: () => null,
        context: () => '',
        recall: async (_input, signal) => {
          calls++
          if (calls === 1) {
            entered = true
            await new Promise((_, reject) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true
                  reject(signal.reason)
                },
                { once: true }
              )
            )
          }
          return { proposals: [], incomplete: false, reasons: [] }
        }
      }
    ],
    now: () => 1000,
    changed() {},
    failed: (e) => assert.fail(String(e))
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
  })
  service.activate()
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (check()) return
      await new Promise((r) => setImmediate(r))
    }
    throw new Error('Abort recovery timed out')
  }
  await until(() => entered)
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  db.identificationEnqueue({ entityId: artist, batchId: 'explicit', providers: [provider] }, 1000)
  settings.newImports = false
  service.refreshIdentification(true)
  await until(() => db.metadataJobs({ entityId: artist }).items[0].state === 'completed')
  assert.equal(aborted, true)
  assert.equal(calls, 2)
})

test('saved streaming members automatically confirm native identities with the actual platform adapter, without MB permission or search HTTP', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.catalogSync({ kind: 'commit', ...platform(db, [online()]) })
  const policy = { enabled: true, publicServiceApproved: false, contact: '', wikipediaText: false }
  const database = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...a: unknown[]) => unknown).apply(db, args)
  })
  const adapter = new PlatformIdentificationProvider('ncm', {
    inventory: () => [
      {
        id: 'ncm',
        enabled: true,
        configuration: '1',
        supportedMethods: ['searchArtists', 'searchSongs']
      }
    ],
    search: async () => assert.fail('native identity needs no HTTP')
  })
  const service = new CoreEntityMetadataService({
    database,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    automation: () => ({ newImports: true, history: false, sources: [adapter.id] }),
    identificationProviders: () => [adapter],
    now: () => 1000,
    changed() {},
    failed: (e) => assert.fail(String(e))
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
  })
  service.activate()
  for (let i = 0; i < 500; i++) {
    const jobs = db.metadataJobs({}).items
    if (jobs.length === 2 && jobs.every((j) => j.state === 'completed')) break
    await new Promise((r) => setImmediate(r))
  }
  assert.equal(db.metadataJobs({}).total, 2)
  for (const job of db.metadataJobs({}).items)
    assert.equal(db.identificationDetail(job.entityId).link!.state, 'confirmed')
})
