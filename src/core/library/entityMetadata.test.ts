import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_METADATA_SCHEMA_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataFact,
  EntityMetadataPolicy,
  ArtistIdentityCandidate
} from '../../shared/entityMetadata.ts'
import type { TrackData } from '../../shared/track.ts'
import { isCoreRequest, coreOperation } from '../../shared/coreProtocol.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import {
  MusicBrainzWikiProvider,
  MetadataIdentityError,
  type MetadataProvider
} from './entityMetadataProvider.ts'
import { MetadataHttp, MetadataHttpError, retryAfter } from './metadataHttp.ts'

const MBID = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
const evidence = {
  provider: 'musicbrainz' as const,
  externalId: MBID,
  url: `https://musicbrainz.org/artist/${MBID}`,
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'MusicBrainz contributors',
  revision: '',
  retrievedAt: 1000
}
const candidate: ArtistIdentityCandidate = {
  mbid: MBID,
  name: '周杰伦',
  type: 'Person',
  disambiguation: 'Taiwanese musician',
  wikidataId: 'Q238819',
  evidence
}
const intro: EntityMetadataFact = {
  field: 'introduction',
  value: '来自已确认人物的介绍',
  language: 'zh-Hans',
  sourceLanguage: 'zh',
  rendering: 'mediawiki-variant',
  attribution: {
    ...evidence,
    provider: 'wikipedia',
    externalId: '123',
    url: 'https://zh.wikipedia.org/wiki/周杰伦',
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    revision: '456'
  }
}
const policy: EntityMetadataPolicy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: true,
  contact: 'https://github.com/Px-asen/Twilight_Echo'
}
const tick = () => new Promise<void>((r) => setImmediate(r))
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return
    await tick()
  }
  throw new Error('Metadata condition timed out')
}
const track = (id: string, online = false): TrackData => ({
  id,
  title: 'Song',
  artist: '周杰伦',
  album: 'Album',
  duration: 200,
  size: 0,
  cover: null,
  lyrics: null,
  source: online ? 'ncm' : 'local',
  filePath: online ? '' : 'D:/music/one.flac',
  fileName: 'one.flac',
  ...(online ? { ncmSongId: 7, artists: [{ id: 9, name: '周杰伦' }] } : {})
})
function seed(db: LibraryDatabase) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks: [track('one')],
    folders: ['D:/music'],
    exclusions: []
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [track('ncm:7', true)] })
  db.catalogSync({ kind: 'commit', ...job })
  return db.catalogQuery({ kind: 'artist' }).items.map((e) => e.id)
}
function asyncDb(db: LibraryDatabase): EntityMetadataDatabaseApi {
  return new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
}
const provider = (extra: Partial<MetadataProvider> = {}): MetadataProvider => ({
  id: 'musicbrainz-wiki',
  capabilities: {
    entities: ['artist'],
    fields: ['name', 'description', 'introduction'],
    explicitIdentity: true
  },
  resolve: async () => structuredClone(candidate),
  enrich: async () => [structuredClone(intro)],
  ...extra
})

test('public NCM rate limits remain durable retries even after the ordinary error budget', async t => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const [entityId] = seed(db)
  const published = db.identificationPublish(db.identificationInput(entityId), [{
    provider: 'ncm', name: '周杰伦', summary: '', matcherVersion: 'fixture',
    references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }],
    evidence: { origin: 'search', matches: ['name'], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }
  }], 1000)[0]
  db.identificationDecide({ candidateId: published.id, revision: published.revision, linkRevision: published.linkRevision, decision: 'confirm' }, 1001)
  let now = 2000
  const failures: unknown[] = []
  const makeService = () => new CoreEntityMetadataService({
    database: asyncDb(db), provider: provider(), policy: () => policy, now: () => now,
    changed() {}, failed: e => failures.push(e), enrichmentProviders: () => [{
      id: 'platform.ncm', supports: () => true, blockedReason: () => null, context: () => 'public',
      enrich: async () => { throw new Error('NCM_METADATA_RATE_LIMITED') }
    }]
  })
  const job = db.metadataEnqueue({ entityId, type: 'enrich', provider: 'platform.ncm', language: 'en', batchId: 'rate-test', providerContext: 'public' }, now)
  for (let i = 0; i < 6; i++) {
    const service = makeService(); service.activate()
    await until(() => { const saved = db.metadataJobs({ jobId: job.id }).items[0]; return saved.state === 'retry_wait' && saved.attempts >= i + 1 })
    const saved = db.metadataJobs({ jobId: job.id }).items[0]
    assert.equal(saved.reason, 'platform_metadata_rate_limited')
    assert.ok(saved.nextAttemptAt >= now + 60_000)
    await service.shutdown()
    now = saved.nextAttemptAt + 1
  }
  assert.ok(db.metadataJobs({ jobId: job.id }).items[0].attempts >= 6)
  assert.deepEqual(failures, [])
})
function resolve(db: LibraryDatabase, entityId: string, batchId = 'identify') {
  const job = db.metadataEnqueue(
    { entityId, mbid: MBID, language: 'zh-Hans', batchId, type: 'resolve' },
    1000
  )
  const work = db.metadataClaim(1000)!
  assert.equal(work.job.id, job.id)
  assert.equal(db.metadataFinish(work, { state: 'needs_review', candidate }, 1001), true)
  return db.metadataDecide({ jobId: job.id, generation: job.generation, decision: 'confirm' }, 1002)
}

test('separately confirmed local/platform artists share one durable introduction, keep source overrides and detach reversibly', () => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-shared-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  try {
    const [a, b] = seed(db)
    assert.notEqual(a, b)
    assert.equal(db.metadataDetail(a, 'zh-Hans').targetId, null)
    const before = db.getContentRevision()
    const first = resolve(db, a),
      second = resolve(db, b)
    assert.equal(first.targetId, second.targetId)
    const job = db.metadataEnqueue(
      { type: 'enrich', entityId: a, language: 'zh-Hans', batchId: 'local' },
      2000
    )
    assert.equal(
      db.metadataEnqueue(
        { type: 'enrich', entityId: b, language: 'zh-Hans', batchId: 'platform' },
        2000
      ).id,
      job.id
    )
    const work = db.metadataClaim(2000)!
    db.metadataOverride(
      {
        entityId: a,
        revision: first.revision,
        mode: 'value',
        value: '我的介绍',
        language: 'zh-Hans'
      },
      2001
    )
    assert.equal(
      db.metadataFinish(work, { state: 'completed', outcome: 'matched', facts: [intro] }, 2002),
      true
    )
    assert.equal(db.metadataDetail(a, 'zh-Hans').introduction!.value, '我的介绍')
    assert.equal(db.metadataDetail(b, 'zh-Hans').introduction!.attribution!.revision, '456')
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM metadata_facts').get()!.n, 1)
    assert.equal(db.getContentRevision(), before)
    let detail = db.metadataDetail(a, 'en')
    detail = db.metadataOverride(
      { entityId: a, revision: detail.revision, mode: 'clear', language: 'en' },
      2003
    )
    assert.equal(
      db.metadataDetail(a, 'zh-Hans').introduction,
      null,
      'explicit clear suppresses other languages too'
    )
    detail = db.metadataOverride(
      { entityId: a, revision: detail.revision, mode: 'reset', language: 'zh-Hans' },
      2004
    )
    assert.equal(detail.introduction!.value, intro.value)
    db.close()
    db = new LibraryDatabase(path)
    assert.deepEqual(db.metadataDetail(b, 'zh-Hans').facts, [intro])
    detail = db.metadataDetail(a, 'zh-Hans')
    db.metadataDetach(a, detail.revision, 3000)
    assert.equal(db.metadataDetail(a, 'zh-Hans').introduction, null)
    assert.equal(db.metadataDetail(b, 'zh-Hans').introduction!.value, intro.value)
    assert.throws(
      () =>
        db.metadataOverride(
          { entityId: a, revision: detail.revision, mode: 'clear', language: 'en' },
          3001
        ),
      /变化/
    )
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM metadata_link_history').get()!.n, 3)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('job cancellation removes only its durable demand and fences the last consumer late reply', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const [a, b] = seed(db)
    resolve(db, a)
    resolve(db, b)
    const job = db.metadataEnqueue(
      { type: 'enrich', entityId: a, language: 'en', batchId: 'a' },
      2000
    )
    db.metadataEnqueue({ type: 'enrich', entityId: b, language: 'en', batchId: 'b' }, 2000)
    const work = db.metadataClaim(2000)!
    assert.equal(db.metadataCancel(job.id, 'a', 2001), true)
    assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'running')
    db.metadataCancel(job.id, 'b', 2002)
    assert.equal(
      db.metadataFinish(work, { state: 'completed', outcome: 'matched', facts: [intro] }, 2003),
      false
    )
    assert.equal(db.metadataDetail(a, 'en').facts.length, 0)
    const resumed = db.metadataEnqueue(
      { type: 'enrich', entityId: a, language: 'en', batchId: 'new' },
      2004
    )
    assert.ok(resumed.generation > job.generation)
  } finally {
    db.close()
  }
})

test('rejected candidates persist and changed source/link inputs cannot confirm or commit stale results', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const [a] = seed(db)
    let job = db.metadataEnqueue(
      { entityId: a, type: 'resolve', mbid: MBID, language: 'en', batchId: 'a' },
      1000
    )
    let work = db.metadataClaim(1000)!
    db.metadataFinish(work, { state: 'needs_review', candidate }, 1001)
    db.metadataDecide({ jobId: job.id, generation: job.generation, decision: 'reject' }, 1002)
    assert.equal(db.metadataDetail(a, 'en').link!.state, 'rejected')
    job = db.metadataEnqueue(
      { entityId: a, type: 'resolve', mbid: MBID, language: 'en', batchId: 'explicit-requery' },
      1003
    )
    assert.equal(job.state, 'queued')
    work = db.metadataClaim(1003)!
    db.metadataFinish(work, { state: 'needs_review', candidate }, 1004)
    db.metadataOverride(
      { entityId: a, revision: 1, mode: 'value', value: 'Keep this', language: 'en' },
      1005
    )
    assert.throws(
      () =>
        db.metadataDecide({ jobId: job.id, generation: job.generation, decision: 'confirm' }, 1006),
      /变化/
    )
    job = db.metadataEnqueue(
      { entityId: a, type: 'resolve', mbid: MBID, language: 'en', batchId: 'new' },
      1007
    )
    work = db.metadataClaim(1007)!
    db.sql.prepare("UPDATE catalog_entities SET title='Different' WHERE id=?").run(a)
    assert.equal(db.metadataFinish(work, { state: 'needs_review', candidate }, 1008), false)
    assert.equal(db.metadataJobs({ jobId: job.id }).items[0].reason, 'input_changed')
    job = db.metadataEnqueue(
      { entityId: a, type: 'resolve', mbid: MBID, language: 'en', batchId: 'review' },
      1009
    )
    work = db.metadataClaim(1009)!
    db.metadataFinish(
      work,
      { state: 'needs_review', candidate: null, reason: 'ambiguous_wikidata_relation' },
      1010
    )
    const retry = db.metadataEnqueue(
      { entityId: a, type: 'resolve', mbid: MBID, language: 'en', batchId: 'explicit-retry' },
      1011
    )
    assert.equal(
      retry.state,
      'queued',
      'an explicit query can retry an ambiguous response without confirming it'
    )
    assert.ok(retry.generation > job.generation)
  } finally {
    db.close()
  }
})

test('facts and completion publish atomically; failed writes leave the running task recoverable', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const [a] = seed(db)
    resolve(db, a)
    const job = db.metadataEnqueue(
      { type: 'enrich', entityId: a, language: 'en', batchId: 'a' },
      2000
    )
    const work = db.metadataClaim(2000)!
    db.sql.exec(
      "CREATE TRIGGER fail_metadata_finish BEFORE UPDATE ON metadata_jobs WHEN new.state='completed' BEGIN SELECT RAISE(ABORT,'simulated full disk'); END"
    )
    assert.throws(
      () =>
        db.metadataFinish(work, { state: 'completed', outcome: 'matched', facts: [intro] }, 2001),
      /full disk/
    )
    assert.equal(db.metadataDetail(a, 'en').facts.length, 0)
    assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'running')
    db.sql.exec('DROP TRIGGER fail_metadata_finish')
    db.metadataRecover(2002)
    assert.equal(
      db.metadataFinish(work, { state: 'completed', outcome: 'matched', facts: [intro] }, 2003),
      false
    )
    assert.equal(db.metadataClaim(2003)!.job.generation, work.job.generation + 1)
  } finally {
    db.close()
  }
})

test('Core restarts queued/running work without UI, persists Retry-After, blocks disabled policy and rejects late cancel results', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const [a] = seed(db)
  resolve(db, a)
  const demand = { entityId: a, language: 'zh-Hans' as const, batchId: 'a' }
  const job = db.metadataEnqueue({ ...demand, type: 'enrich' }, 2000)
  db.metadataClaim(2000)
  let release!: (facts: EntityMetadataFact[]) => void,
    entered = false
  let sawRunningNotification = false
  let activePolicy = { ...policy },
    now = 3000
  const service = new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: provider({
      enrich: async () => {
        entered = true
        return new Promise((r) => {
          release = r
        })
      }
    }),
    policy: () => activePolicy,
    now: () => now,
    changed() {
      sawRunningNotification ||= db.metadataJobs({ jobId: job.id }).items[0]?.state === 'running'
    },
    failed(e) {
      throw e
    }
  })
  service.activate()
  await until(() => entered)
  assert.equal(sawRunningNotification, true, 'claim publishes a task revision before the provider completes')
  await service.cancel(job.id, 'a')
  release([intro])
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'cancelled')
  await service.shutdown()
  assert.equal(db.metadataDetail(a, 'zh-Hans').facts.length, 0)
  const retry = new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: provider({
      enrich: async () => {
        throw new MetadataHttpError('busy', 503, now + 900000)
      }
    }),
    policy: () => activePolicy,
    now: () => now,
    changed() {},
    failed(e) {
      throw e
    }
  })
  retry.activate()
  await retry.enrich(demand)
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'retry_wait')
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].nextAttemptAt, now + 900000)
  await retry.shutdown()
  now += 900001
  activePolicy = { ...policy, enabled: false }
  const disabled = new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: provider({
      enrich: async () => {
        throw new Error('Must not fetch')
      }
    }),
    policy: () => activePolicy,
    now: () => now,
    changed() {},
    failed(e) {
      throw e
    }
  })
  disabled.activate()
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'blocked')
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].reason, 'metadata_disabled')
  await disabled.shutdown()
})

test('v12 migration makes a consistent backup, preserves catalog IDs and rolls back DDL failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-migration-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  try {
    const ids = seed(db),
      content = db.getContentRevision()
    db.sql.exec(LEGACY_METADATA_SCHEMA_SQL + 'PRAGMA user_version=12;')
    db.close()
    db = new LibraryDatabase(path)
    assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
    assert.deepEqual(
      db.catalogQuery({ kind: 'artist' }).items.map((e) => e.id),
      ids
    )
    assert.equal(db.getContentRevision(), content)
    const snapshot = join(root, readdirSync(root).find((f) => f.includes('.v12-backup-'))!)
    const backup = new DatabaseSync(snapshot)
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 12)
    backup.close()
    db.sql.exec(
      LEGACY_METADATA_SCHEMA_SQL + 'PRAGMA user_version=12; CREATE TABLE metadata_jobs(dummy TEXT);'
    )
    db.close()
    assert.throws(() => new LibraryDatabase(path), /already exists/)
    const old = new DatabaseSync(path)
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, 12)
    assert.equal(
      old.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata_entities'").get(),
      undefined
    )
    old.close()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('public entity requests accept exact IDs and bounded decisions, not client facts or arbitrary endpoints', () => {
  const request = (name: string, payload: unknown, kind = 'command') => ({
    kind,
    name,
    payload,
    requestId: '1',
    epoch: 'core'
  })
  assert.equal(
    isCoreRequest(
      request('metadata.entity.resolve', {
        entityId: 'artist',
        mbid: MBID,
        language: 'zh-Hans',
        batchId: 'batch'
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('metadata.entity.resolve', {
        entityId: 'artist',
        mbid: 'https://musicbrainz.org/artist/' + MBID,
        language: 'en',
        batchId: 'batch'
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('metadata.entity.override', {
        entityId: 'artist',
        revision: 1,
        mode: 'clear',
        language: 'en',
        value: 'hidden'
      })
    ),
    false
  )
  assert.equal(isCoreRequest(request('metadata.entity.jobs', { limit: 101 }, 'query')), false)
  assert.equal(
    isCoreRequest(
      request(
        'metadata.entity.detail',
        { entityId: 'artist', language: 'en', facts: [intro] },
        'query'
      )
    ),
    false
  )
  assert.equal(coreOperation('metadata.entity.decide')!.permission, 'library:write')
  assert.equal(coreOperation('metadata.entity.detail')!.permission, 'library:read')
})

test('a process-style reopen resumes an unfinished disk job and shutdown joins writes without publishing a late response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-restart-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  let service: CoreEntityMetadataService | undefined
  try {
    const [a] = seed(db)
    resolve(db, a)
    const demand = { entityId: a, language: 'zh-Hans' as const, batchId: 'durable' }
    const job = db.metadataEnqueue({ ...demand, type: 'enrich' }, 2000)
    db.metadataClaim(2000)
    db.close()
    db = new LibraryDatabase(path)
    let release!: (facts: EntityMetadataFact[]) => void
    const create = (source: MetadataProvider) =>
      new CoreEntityMetadataService({
        database: asyncDb(db),
        provider: source,
        policy: () => policy,
        now: () => 3000,
        changed() {},
        failed(e) {
          throw e
        }
      })
    service = create(
      provider({
        enrich: async () =>
          new Promise((r) => {
            release = r
          })
      })
    )
    service.activate()
    await until(() => !!release)
    const stopping = service.shutdown()
    release([intro])
    await stopping
    assert.equal(db.metadataDetail(a, 'zh-Hans').facts.length, 0)
    assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'running')
    db.close()
    db = new LibraryDatabase(path)
    service = create(provider())
    service.activate()
    await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
    assert.equal(db.metadataDetail(a, 'zh-Hans').introduction!.value, intro.value)
    assert.equal(db.metadataJobs({ jobId: job.id }).items[0].generation, job.generation + 2)
  } finally {
    await service?.shutdown()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('changing deployment permission while a request runs fences publication, with existing user values intact', async () => {
  const db = new LibraryDatabase(':memory:')
  let currentPolicy = { ...policy },
    release!: (facts: EntityMetadataFact[]) => void
  const service = new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: provider({
      enrich: async () =>
        new Promise((r) => {
          release = r
        })
    }),
    policy: () => currentPolicy,
    now: () => 4000,
    changed() {},
    failed(e) {
      throw e
    }
  })
  try {
    const [a] = seed(db)
    const detail = resolve(db, a)
    db.metadataOverride(
      { entityId: a, revision: detail.revision, mode: 'value', value: 'Manual', language: 'en' },
      2000
    )
    service.activate()
    const job = await service.enrich({ entityId: a, language: 'zh-Hans', batchId: 'a' })
    await until(() => !!release)
    currentPolicy = { ...policy, enabled: false }
    release([intro])
    await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'blocked')
    assert.equal(db.metadataDetail(a, 'zh-Hans').introduction!.value, 'Manual')
    assert.equal(db.metadataDetail(a, 'zh-Hans').facts.length, 0)
  } finally {
    await service.shutdown()
    db.close()
  }
})

test('exact MB → reciprocal Wikidata → Wikipedia preserves language, revision and attribution; disambiguation falls back to English', async () => {
  const calls: URL[] = []
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url)
    let value: unknown
    if (url.hostname === 'musicbrainz.org')
      value = {
        id: MBID,
        name: '周杰伦',
        type: 'Person',
        relations: [
          { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q238819' } }
        ]
      }
    else if (url.hostname === 'www.wikidata.org')
      value = {
        entities: {
          Q238819: {
            id: 'Q238819',
            lastrevid: 77,
            claims: { P434: [{ mainsnak: { datavalue: { value: MBID } } }] },
            descriptions: { zh: { value: '台湾音乐人' } },
            sitelinks: { zhwiki: { title: '周杰伦' }, enwiki: { title: 'Jay Chou' } }
          }
        }
      }
    else
      value = {
        query: {
          pages: [
            {
              pageid: 123,
              title: 'Jay Chou',
              pageprops: {
                wikibase_item: 'Q238819',
                ...(url.hostname === 'zh.wikipedia.org' ? { disambiguation: '' } : {})
              },
              revisions: [{ revid: 88 }],
              extract: 'Public encyclopedia introduction'
            }
          ]
        }
      }
    return new Response(JSON.stringify(value))
  }
  const source = new MusicBrainzWikiProvider(() => policy, fetcher)
  const facts = await source.enrich(MBID, 'zh-Hans', new AbortController().signal)
  assert.equal(facts.find((f) => f.field === 'description')!.language, 'zh')
  const text = facts.find((f) => f.field === 'introduction')!
  assert.equal(text.language, 'en')
  assert.equal(text.attribution.revision, '88')
  assert.equal(text.attribution.license, 'CC-BY-SA-4.0')
  assert.equal(calls[2].searchParams.get('variant'), 'zh-hans')
  assert.equal(calls[2].searchParams.has('search'), false)
  const limited = new MusicBrainzWikiProvider(() => ({ ...policy, wikipediaText: false }), fetcher)
  calls.length = 0
  assert.equal(
    (await limited.enrich(MBID, 'en', new AbortController().signal)).some(
      (f) => f.field === 'introduction'
    ),
    false
  )
  assert.equal(calls.length, 2)
  const notFound = new MusicBrainzWikiProvider(
    () => policy,
    async () => new Response(null, { status: 404 })
  )
  assert.equal(await notFound.resolve(MBID, new AbortController().signal), null)
  const wrong = new MusicBrainzWikiProvider(
    () => policy,
    async () => new Response(JSON.stringify({ id: 'wrong', name: 'Same', type: 'Person' }))
  )
  await assert.rejects(wrong.resolve(MBID, new AbortController().signal), MetadataIdentityError)
})

test('exact artist lookups accept an unknown MusicBrainz subtype without inventing biography or identity errors', async () => {
  for (const type of [null, undefined]) {
    const p = new MusicBrainzWikiProvider(() => policy, async () =>
      new Response(JSON.stringify({ id: MBID, name: 'BilliumMoto', type, relations: [] })))
    const identity = await p.resolve(MBID, new AbortController().signal)
    assert.equal(identity?.type, '')
    assert.equal(identity?.wikidataId, null)
    const facts = await p.enrich(MBID, 'en', new AbortController().signal)
    assert.deepEqual(facts.map(fact => [fact.field, fact.value]), [['name', 'BilliumMoto']])
  }
  for (const type of ['Recording', '', {}, ['Person']]) {
    const p = new MusicBrainzWikiProvider(() => policy, async () =>
      new Response(JSON.stringify({ id: MBID, name: 'Artist', type })))
    await assert.rejects(p.resolve(MBID, new AbortController().signal), MetadataIdentityError)
  }
})

test('HTTP request dedup isolates consumer cancellation; shared host budget serializes old/new adapters and honors Retry-After', async () => {
  let release!: () => void,
    calls = 0,
    concurrent = 0,
    maxConcurrent = 0
  const http = new MetadataHttp(async () => {
    calls++
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    if (calls === 1)
      await new Promise<void>((r) => {
        release = r
      })
    concurrent--
    return new Response('{"ok":true}')
  }, 10)
  const a = new AbortController(),
    b = new AbortController()
  const one = http.fetch('https://musicbrainz.org/ws/2/artist/a', { signal: a.signal })
  const rejected = assert.rejects(one)
  const two = http.fetch('https://musicbrainz.org/ws/2/artist/a', { signal: b.signal })
  await until(() => !!release)
  a.abort()
  await rejected
  release()
  assert.deepEqual(await (await two).json(), { ok: true })
  assert.equal(calls, 1)
  await Promise.all([
    http.fetch('https://musicbrainz.org/ws/2/artist/b'),
    http.fetch('https://musicbrainz.org/ws/2/artist/c')
  ])
  assert.equal(maxConcurrent, 1)
  assert.equal(retryAfter('900', 1000), 901000)
  assert.equal(retryAfter('Sat, 24 Oct 2026 00:00:00 GMT', 0), Date.parse('2026-10-24T00:00:00Z'))
  assert.equal(retryAfter('garbage', 0), null)
  await assert.rejects(http.fetch('https://not-allowed.invalid/'))
  const starts: number[] = []
  const delayed = new MetadataHttp(async () => {
    starts.push(Date.now())
    return starts.length === 1
      ? new Response(null, { status: 429, headers: { 'Retry-After': '0.05' } })
      : new Response('{}')
  }, 1)
  await Promise.all([
    delayed.fetch('https://musicbrainz.org/a'),
    delayed.fetch('https://musicbrainz.org/b')
  ])
  assert.ok(starts[1] - starts[0] >= 40)
})

test('startup cached credits backfill awaits separate bounded batches before metadata claim', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  for (let i = 0; i < 3; i++) {
    const target = `backfill-target-${i}`, value = `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`
    db.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)').run(target, 'musicbrainz', 'recording', value, `Cached recording ${i}`)
    db.sql.prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)').run('musicbrainz', 'recording', 'mbid', value, target)
    db.sql.prepare('INSERT INTO metadata_credit_sets VALUES(?,?,1,0)').run(target, 'musicbrainz-details')
    const personRef = { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: `00000000-0000-0000-0000-${String(i + 10).padStart(12, '0')}` }
    const credit = { personRef, name: `Person ${i}`, targetRef: { provider: 'musicbrainz', kind: 'recording', idType: 'mbid', value }, role: 'vocal', rawRole: 'vocal', relationTypeId: '', direction: 'backward', order: 0, joinphrase: '', attributes: [], begin: '', end: '', attribution: evidence }
    db.sql.prepare('INSERT INTO metadata_credits VALUES(?,?,0,?)').run(target, 'musicbrainz-details', JSON.stringify(credit))
  }
  const events: string[] = [], releases: Array<() => void> = [], failures: unknown[] = []
  let active = 0, maximum = 0, batches = 0
  const original = asyncDb(db)
  const database = new Proxy(original, { get: (target, key: keyof EntityMetadataDatabaseApi) => {
    if (key === 'metadataRecover') return async (now: number) => { events.push('recover:start'); await original.metadataRecover(now); events.push('recover:done') }
    if (key === 'metadataClaim') return async (now: number) => { events.push('claim'); return original.metadataClaim(now) }
    return target[key]
  } })
  const service = new CoreEntityMetadataService({ database, provider: provider(), policy: () => policy, now: () => 1000, changed() {}, failed: error => failures.push(error),
    backfillCredits: async () => { const batch = ++batches; events.push(`batch:${batch}:start`); active++; maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => releases.push(resolve))
      const result = db.explorationBackfillCredits(1); events.push(`batch:${batch}:done`); active--; return result
    } })
  t.after(() => { releases.forEach(release => release()); return service.shutdown() })
  service.activate(); service.activate()
  await until(() => releases.length === 1)
  assert.deepEqual(events, ['recover:start', 'recover:done', 'batch:1:start']); assert.equal(db.explorationQuery({ scope: 'catalog', kinds: ['artist'] }).total, 0)
  await tick(); assert.equal(releases.length, 1); assert.equal(events.includes('claim'), false)
  releases[0](); await until(() => releases.length === 2)
  assert.equal(db.explorationQuery({ scope: 'catalog', kinds: ['artist'] }).total, 1); assert.equal(events.includes('claim'), false)
  releases[1](); await until(() => releases.length === 3)
  assert.equal(db.explorationQuery({ scope: 'catalog', kinds: ['artist'] }).total, 2); assert.equal(events.includes('claim'), false)
  releases[2](); await until(() => events.includes('claim'))
  assert.equal(db.explorationQuery({ scope: 'catalog', kinds: ['artist'] }).total, 3); assert.equal(maximum, 1); assert.equal(batches, 3)
  assert.ok(events.indexOf('claim') > events.indexOf('batch:3:done')); assert.deepEqual(failures, [])
  await service.shutdown(); const finished = [...events]; service.activate(); await tick(); assert.deepEqual(events, finished)
})

test('startup cached credits backfill stops after the in-flight batch without reclaim or replay', async t => {
  const events: string[] = [], failures: unknown[] = []
  let release: (() => void) | null = null
  const database = { metadataRecover: async () => { events.push('recover') }, metadataClaim: async () => { events.push('claim'); return null }, metadataNextAttempt: async () => null } as unknown as EntityMetadataDatabaseApi
  const service = new CoreEntityMetadataService({ database, provider: provider(), policy: () => policy, now: () => 1000, changed() {}, failed: error => failures.push(error),
    backfillCredits: async () => { events.push('batch:start'); await new Promise<void>(resolve => { release = resolve }); events.push('batch:done'); return { processed: 100, pending: true } } })
  t.after(() => { release?.(); return service.shutdown() })
  service.activate(); await until(() => release !== null)
  const stopping = service.shutdown(); service.activate(); release!(); await stopping
  assert.deepEqual(events, ['recover', 'batch:start', 'batch:done']); assert.deepEqual(failures, [])
  service.activate(); await tick(); assert.deepEqual(events, ['recover', 'batch:start', 'batch:done'])
})
