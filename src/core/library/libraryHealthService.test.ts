import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreLibraryHealthService } from './libraryHealthService.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataFact,
  EntityMetadataJob
} from '../../shared/entityMetadata.ts'
import type { IdentificationProvider } from './musicIdentificationProvider.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
import type { CatalogEntity } from '../../shared/musicCatalog.ts'
import type { CatalogDatabaseApi } from '../../shared/musicCatalog.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import { isCoreRequest } from '../../shared/coreProtocol.ts'

const NOW = 100000000,
  MBID = '00000000-0000-4000-8000-000000000001'
const policy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: true,
  contact: 'https://example.org/contact'
}
const evidence = {
  provider: 'musicbrainz',
  externalId: MBID,
  url: `https://musicbrainz.org/artist/${MBID}`,
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'MusicBrainz contributors',
  revision: '1',
  retrievedAt: NOW
}
const fact = (field: EntityMetadataFact['field'], value: string): EntityMetadataFact => ({
  field,
  value,
  language: 'zh-Hans',
  attribution: evidence
})
type Snapshot = Awaited<ReturnType<CoreEntityMetadataService['inspectHealth']>>
type AsyncDatabase = LibraryDatabaseApi & CatalogDatabaseApi & EntityMetadataDatabaseApi
const asyncDatabase = (db: LibraryDatabase) =>
  new Proxy({} as AsyncDatabase, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        Promise.resolve(Reflect.apply(Reflect.get(db, key), db, args))
  })
const snapshot = (entity: CatalogEntity): Snapshot => ({
  identity: { entityId: entity.id, kind: entity.kind, link: null, references: [] },
  detail: {
    entityId: entity.id,
    targetId: null,
    link: null,
    revision: 0,
    name: entity.title,
    introduction: null,
    override: null,
    facts: []
  },
  hasArtwork: false,
  needsReview: false,
  jobs: [],
  identification: [{ id: 'musicbrainz', reason: null }],
  enrichment: [
    { id: 'musicbrainz-details', reason: null },
    { id: 'public-artwork', reason: null }
  ],
  potentialEnrichment: [
    { id: 'musicbrainz-details', reason: null },
    { id: 'public-artwork', reason: null }
  ]
})
const job = (extra: Partial<EntityMetadataJob> = {}): EntityMetadataJob => ({
  id: 'job',
  entityId: 'entity',
  type: 'identify',
  provider: 'musicbrainz',
  language: 'zh-Hans',
  externalId: MBID,
  state: 'completed',
  generation: 1,
  attempts: 1,
  nextAttemptAt: NOW,
  outcome: 'not_found',
  reason: null,
  candidate: null,
  updatedAt: NOW,
  ...extra
})
async function until(done: () => boolean, milliseconds = 4000) {
  const end = Date.now() + milliseconds
  while (!done()) {
    if (Date.now() >= end) throw new Error('Health condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
function fixture(t: test.TestContext, count = 1) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks: Array.from({ length: count }, (_, i) => ({
      id: `song-${i}`,
      title: `Track ${i}`,
      artist: `Artist ${i}`,
      album: `Album ${i}`,
      filePath: `D:/private/song-${i}.flac`,
      duration: 200
    })),
    folders: [],
    exclusions: []
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entities = ['artist', 'album_project', 'release'].flatMap(
    (kind) => db.catalogQuery({ kind: kind as CatalogEntity['kind'] }).items
  )
  const snapshots = new Map(entities.map((e) => [e.id, snapshot(e)]))
  let serial = 0,
    writes = 0
  const database = asyncDatabase(db)
  const metadata = {
    inspectHealth: async (id: string) => structuredClone(snapshots.get(id)!),
    policy: () => ({ enabled: true, identity: true, introduction: true, reason: null }),
    getRevision: () => 0,
    startIdentification: async ({ entityId }: { entityId: string }) => {
      writes++
      const s = snapshots.get(entityId)!
      s.identity.link = {
        id: 'link',
        entityId,
        kind: s.identity.kind,
        state: 'confirmed',
        targetId: MBID,
        revision: 1
      }
      s.detail.targetId = MBID
      return { batchId: 'health', jobs: [job({ id: `identify:${entityId}` })] }
    },
    enrich: async ({ entityId, provider }: { entityId: string; provider?: string }) => {
      writes++
      const s = snapshots.get(entityId)!
      if (provider === 'public-artwork') s.hasArtwork = true
      else {
        s.detail.facts = [fact('name', '规范名')]
        s.detail.introduction = {
          value: '简介',
          language: 'zh-Hans',
          origin: 'external',
          attribution: evidence
        }
      }
      return job({ id: `${provider}:${entityId}`, type: 'enrich' })
    },
    jobs: async () => ({ total: 1, items: [job()] })
  }
  const health = new CoreLibraryHealthService({
    database,
    metadata,
    language: () => 'zh-Hans',
    now: () => NOW,
    newId: () => String(++serial),
    changed() {}
  })
  t.after(async () => {
    await health.shutdown()
    db.close()
  })
  const scan = async () => {
    health.start()
    await until(() => ['ready', 'failed'].includes(health.state().phase))
    assert.equal(health.state().error, '')
    return health.state().report!
  }
  return { db, health, metadata, entities, snapshots, scan, writes: () => writes }
}

test('health is read-only, reports actual field coverage in distinct units and pages without paths', async (t) => {
  const f = fixture(t, 23),
    report = await f.scan()
  assert.equal(f.writes(), 0)
  assert.deepEqual(report.totals, { tracks: 23, artists: 23, albums: 23, releases: 23 })
  assert.equal(report.metrics.track_tags.missing, 0)
  assert.equal(report.metrics.track_cover.missing, 23)
  assert.equal(report.metrics.artist_intro.repairable, 23)
  assert.equal(report.metrics.release_identity.missing, 23)
  for (const metric of Object.values(report.metrics))
    assert.equal(metric.total, metric.present + metric.hidden + metric.missing)
  const page = f.health.page({ id: report.id, category: 'artist_image', offset: 20, limit: 10 })
  assert.equal(page.total, 23)
  assert.equal(page.items.length, 3)
  assert.doesNotMatch(JSON.stringify({ report, page }), /filePath|private|fingerprint/)
})

test('entity coverage includes streaming library members without counting them as local files', async (t) => {
  const f = fixture(t)
  let upload = f.db.catalogSync({ kind: 'begin', revision: 1 })
  upload = f.db.catalogSync({
    kind: 'append',
    ...upload,
    tracks: [
      {
        id: 'ncm:7',
        source: 'ncm',
        title: 'Remote song',
        artist: 'Remote artist',
        album: 'Remote album',
        filePath: '',
        fileName: '',
        duration: 200,
        size: 0,
        cover: null,
        lyrics: null,
        ncmSongId: 7,
        albumId: '9',
        artists: [{ id: 8, name: 'Remote artist' }]
      }
    ]
  })
  f.db.catalogSync({ kind: 'commit', ...upload })
  for (const kind of ['artist', 'album_project', 'release'] as const)
    for (const entity of f.db.catalogQuery({ kind }).items)
      if (!f.snapshots.has(entity.id)) f.snapshots.set(entity.id, snapshot(entity))
  const report = await f.scan()
  assert.deepEqual(report.totals, { tracks: 1, artists: 2, albums: 2, releases: 2 })
  assert.equal(report.metrics.artist_intro.total, 2)
  assert.equal(report.metrics.track_tags.total, 1)
})

test('manual clear is excluded; no-result, review, source blocking, active jobs and failures stay distinct', async (t) => {
  const f = fixture(t, 6),
    artists = f.entities.filter((e) => e.kind === 'artist').map((e) => f.snapshots.get(e.id)!)
  artists[0].detail.override = { mode: 'clear', value: '', language: 'zh-Hans' }
  artists[0].detail.artworkOverride = { mode: 'clear' }
  artists[1].jobs = [job()]
  artists[2].needsReview = true
  artists[3].identification[0].reason = 'metadata_disabled'
  artists[4].jobs = [job({ state: 'retry_wait' })]
  artists[5].jobs = [job({ state: 'failed', reason: 'metadata_http_503' })]
  const report = await f.scan()
  assert.equal(report.metrics.artist_intro.hidden, 1)
  assert.equal(report.metrics.artist_image.hidden, 1)
  const items = f.health.page({ id: report.id, category: 'artist_identity' }).items
  assert.deepEqual(
    items.map((i) => i.state).sort(),
    ['ready', 'unavailable', 'review', 'blocked', 'processing', 'failed'].sort()
  )
  assert.equal(items.find((i) => i.state === 'failed')!.canRepair, true)
  assert.equal(items.find((i) => i.state === 'unavailable')!.canRepair, false)
})

test('fresh completion works from idle and owns diagnosis, deduplicated queueing and follow-ups', async (t) => {
  const f = fixture(t)
  assert.equal(f.health.state().report, null)
  const started = await f.health.repair({ refresh: true })
  assert.equal(started.phase, 'scanning')
  await assert.rejects(f.health.repair({ refresh: true }), /正在进行/)
  await until(
    () => f.health.state().repair?.stage === 'completed' && f.health.state().phase === 'ready'
  )
  assert.equal(
    f.health.state().repair!.total,
    3,
    'multiple missing fields count each source entity once'
  )
  assert.equal(f.health.state().repair!.jobs, 6)
  assert.equal(f.health.state().report!.metrics.artist_intro.present, 1)
  assert.equal(f.health.state().report!.metrics.artist_image.present, 1)
  assert.equal(f.health.state().report!.metrics.track_cover.missing, 1)
})

test('fresh completion ends naturally for an empty library or cached no-content responses', async (t) => {
  for (const count of [0, 1]) {
    const f = fixture(t, count)
    for (const snapshot of f.snapshots.values()) snapshot.jobs = [job()]
    await f.health.repair({ refresh: true })
    await until(() => f.health.state().repair?.stage === 'completed')
    assert.equal(f.health.state().phase, 'ready')
    assert.equal(f.health.state().error, '')
    assert.equal(f.health.state().repair!.total, 0)
    assert.equal(f.health.state().repair!.jobs, 0)
    assert.equal(f.writes(), 0)
  }
})

test('one click deduplicates fields per entity, confirms only via existing service and follows with biography/name/avatar', async (t) => {
  const f = fixture(t)
  const report = await f.scan()
  await f.health.repair({ id: report.id })
  await until(
    () => f.health.state().repair?.stage === 'completed' && f.health.state().phase === 'ready'
  )
  const updated = f.health.state().report!
  for (const category of [
    'artist_identity',
    'artist_name',
    'artist_intro',
    'artist_image',
    'album_intro'
  ] as const)
    assert.equal(updated.metrics[category].missing, 0, category)
  assert.equal(
    f.health.state().repair?.jobs,
    6,
    'three identity tasks, two text tasks and one portrait task'
  )
  assert.equal(
    updated.metrics.track_cover.missing,
    1,
    'file metadata is never silently overwritten'
  )
  assert.throws(() => f.health.page({ id: report.id }), { code: 'STALE_REVISION' })
})

test('a slow identity does not block biographies for other confirmed artists', async (t) => {
  const f = fixture(t, 2),
    artists = f.entities.filter((e) => e.kind === 'artist')
  const original = f.metadata.startIdentification
  let released = false
  f.metadata.startIdentification = async (request) => {
    const result = await original(request)
    return {
      ...result,
      jobs: result.jobs.map((j) => ({
        ...j,
        state: j.id === `identify:${artists[1].id}` ? ('running' as const) : j.state
      }))
    }
  }
  f.metadata.jobs = async (query?: { jobId?: string }) => ({
    total: 1,
    items: [
      job({
        state: query?.jobId === `identify:${artists[1].id}` && !released ? 'running' : 'completed'
      })
    ]
  })
  const report = await f.scan()
  await f.health.repair({ id: report.id })
  await until(() => !!f.snapshots.get(artists[0].id)!.detail.introduction)
  assert.equal(f.health.state().phase, 'repairing')
  assert.equal(f.snapshots.get(artists[1].id)!.detail.introduction, null)
  released = true
  await until(() => f.health.state().phase === 'ready')
})

test('known portrait permissions are reported before identification instead of advertising an impossible fill', async (t) => {
  const f = fixture(t),
    artist = f.entities.find((e) => e.kind === 'artist')!
  f.snapshots.get(artist.id)!.potentialEnrichment.find((p) => p.id === 'public-artwork')!.reason =
    'commons_images_not_permitted'
  const report = await f.scan()
  assert.equal(report.metrics.artist_image.repairable, 0)
  assert.equal(report.metrics.artist_identity.repairable, 1)
  assert.equal(f.health.page({ id: report.id, category: 'artist_image' }).items[0].state, 'blocked')
})

test('native-only portrait completion can use a permitted public source without requiring MB artwork', async (t) => {
  const f = fixture(t),
    artist = f.entities.find((e) => e.kind === 'artist')!,
    s = f.snapshots.get(artist.id)!
  s.identity.link = {
    id: 'native-link',
    entityId: artist.id,
    kind: 'artist',
    state: 'confirmed',
    targetId: 'native-person',
    revision: 1
  }
  s.detail.targetId = 'native-person'
  s.enrichment = [
    { id: 'vocadb', reason: null },
    { id: 'theaudiodb', reason: null, artwork: true }
  ]
  const calls: string[] = []
  f.metadata.enrich = async ({ provider }) => {
    calls.push(provider!)
    s.hasArtwork = true
    return job({ provider, type: 'enrich' })
  }
  const report = await f.scan()
  assert.equal(report.metrics.artist_image.repairable, 1)
  await f.health.repair({ id: report.id, category: 'artist_image' })
  await until(() => f.health.state().phase === 'ready')
  assert.deepEqual(calls, ['theaudiodb'])
})

test('repair rechecks manual choices after diagnosis, rejects stale libraries and preserves partial enqueue failures', async (t) => {
  const f = fixture(t),
    report = await f.scan()
  const artist = f.snapshots.get(f.entities.find((e) => e.kind === 'artist')!.id)!
  artist.detail.artworkOverride = { mode: 'clear' }
  await f.health.repair({ id: report.id, category: 'artist_image' })
  await until(() => f.health.state().phase === 'ready')
  assert.equal(f.writes(), 0)
  const next = f.health.state().report!
  f.metadata.startIdentification = async () => {
    throw new Error('enqueue acknowledgement lost')
  }
  await f.health.repair({ id: next.id })
  await until(() => f.health.state().phase === 'ready')
  assert.ok(f.health.state().repair!.errors > 0)
  assert.match(f.health.state().repair!.lastError, /acknowledgement lost/)
  const current = f.health.state().report!
  f.db.replaceDocument({ version: 2, revision: 2, tracks: [], folders: [], exclusions: [] })
  await assert.rejects(f.health.repair({ id: current.id }), { code: 'STALE_REVISION' })
})

test('health protocol accepts only bounded Core-owned queries and repair scope, not renderer-supplied facts', () => {
  const valid = (name: string, payload: unknown, kind = 'command') =>
    isCoreRequest({ requestId: 'health:1', epoch: 'core:1', kind, name, payload })
  assert.equal(valid('library.health.page', { id: 'report', limit: 100 }, 'query'), true)
  assert.equal(valid('library.health.page', { id: 'report', limit: 101 }, 'query'), false)
  assert.equal(valid('library.health.repair', { id: 'report', category: 'artist_image' }), true)
  assert.equal(valid('library.health.repair', { refresh: true }), true)
  assert.equal(valid('library.health.repair', { refresh: false }), false)
  assert.equal(valid('library.health.repair', { refresh: true, id: 'report' }), false)
  assert.equal(valid('library.health.repair', { refresh: true, category: 'artist_image' }), false)
  assert.equal(valid('library.health.repair', { id: 'report', entityId: 'injected' }), false)
})

test('health runs through the real persistent Core/SQLite queue with automation OFF and never downloads artwork to diagnose', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks: [
      {
        id: 'one',
        filePath: 'D:/music/one.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        identityTags: {
          version: 1,
          scope: 'audio_file',
          artist: { value: 'Artist', origin: 'audio_tag' },
          musicbrainz: { artistIds: [MBID], albumArtistIds: [] }
        }
      }
    ],
    folders: [],
    exclusions: []
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const database = asyncDatabase(db)
  const identifier: IdentificationProvider = {
    id: 'musicbrainz',
    matcherVersion: 'health-test',
    supports: (kind) => kind === 'artist',
    blockedReason: () => null,
    context: () => 'fixture',
    recall: async (input) => ({
      incomplete: false,
      reasons: [],
      proposals: [
        {
          provider: 'musicbrainz',
          name: 'Artist',
          summary: '',
          matcherVersion: 'health-test',
          references: [{ provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: MBID }],
          evidence: {
            origin: 'explicit_id',
            matches: ['name'],
            missing: [],
            conflicts: [],
            incomplete: false,
            provenance: 'fixture',
            verification: {
              method: 'typed_id',
              reference: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: MBID },
              sourceIds: input.sources!.map((s) => s.sourceId)
            }
          }
        }
      ]
    })
  }
  let downloads = 0
  const details: MetadataDetailProvider = {
    id: 'musicbrainz-details',
    supports: (kind) => kind === 'artist',
    blockedReason: () => null,
    context: () => 'details',
    enrich: async () => ({
      availability: 'available',
      facts: [fact('name', 'Artist'), fact('introduction', '真实持久队列中的简介')]
    })
  }
  const artwork: MetadataDetailProvider = {
    id: 'public-artwork',
    supports: (kind) => kind === 'artist',
    blockedReason: () => null,
    context: () => 'artwork',
    enrich: async () => ({
      availability: 'available',
      facts: [],
      artwork: [
        {
          field: 'artwork',
          scope: 'artist',
          targetId: MBID,
          resource: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
          providerContext: 'artwork',
          attribution: evidence,
          usage: { display: true, cache: true, crossSource: true, export: false }
        }
      ]
    })
  }
  const metadata = new CoreEntityMetadataService({
    database: database as unknown as EntityMetadataDatabaseApi,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    identificationProviders: () => [identifier],
    enrichmentProviders: () => [details, artwork],
    automation: () => ({ newImports: false, history: false, sources: [] }),
    artwork: async () => {
      downloads++
      return 'handle'
    },
    now: () => NOW,
    changed() {},
    failed: (error) => {
      throw error
    }
  })
  let serial = 0
  const health = new CoreLibraryHealthService({
    database,
    metadata,
    language: () => 'zh-Hans',
    now: () => NOW,
    newId: () => String(++serial),
    changed() {}
  })
  t.after(async () => {
    await health.shutdown()
    await metadata.shutdown()
    db.close()
  })
  metadata.activate()
  health.start()
  await until(() => health.state().phase === 'ready').catch((error) => {
    throw new Error(JSON.stringify(health.state()), { cause: error })
  })
  assert.equal(db.metadataJobs({}).total, 0)
  await health.repair({ id: health.state().report!.id, category: 'artist_identity' })
  await until(
    () => health.state().repair?.stage === 'completed' && health.state().phase === 'ready'
  ).catch((error) => {
    throw new Error(JSON.stringify({ state: health.state(), jobs: db.metadataJobs({}) }), {
      cause: error
    })
  })
  assert.equal(health.state().report!.metrics.artist_intro.present, 1)
  assert.equal(health.state().report!.metrics.artist_image.present, 1)
  assert.equal(db.metadataTasks({}).counts.completed, 3)
  assert.equal(downloads, 0)
  assert.equal(
    db.identificationDetail(db.catalogQuery({ kind: 'artist' }).items[0].id).link?.state,
    'confirmed'
  )
})
