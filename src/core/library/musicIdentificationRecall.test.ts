import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataPolicy
} from '../../shared/entityMetadata.ts'
import type {
  IdentificationInput,
  IdentificationProposal,
  IdentificationRecall,
  IdentificationSourceInput
} from '../../shared/musicIdentification.ts'
import type { TrackData } from '../../shared/track.ts'
import { isCoreRequest, coreOperation } from '../../shared/coreProtocol.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import { MetadataHttpError } from './metadataHttp.ts'
import {
  MusicBrainzIdentificationProvider,
  PlatformIdentificationProvider,
  type IdentificationPlatform,
  type IdentificationProvider
} from './musicIdentificationProvider.ts'

const MBID = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
const OTHER = '00000000-0000-4000-8000-000000000001'
const policy: EntityMetadataPolicy = {
  enabled: true,
  publicServiceApproved: true,
  contact: 'https://example.com/app',
  wikipediaText: false
}
const signal = () => new AbortController().signal
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const source = (extra: Partial<IdentificationSourceInput> = {}): IdentificationSourceInput => ({
  sourceId: 'source-one',
  provider: 'local',
  trackId: 'one',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  albumArtist: '',
  artists: [{ name: 'Artist' }],
  artistIndexes: [0],
  duration: 202,
  tags: {
    version: 1,
    scope: 'audio_file',
    durationSeconds: { value: 200.25, origin: 'audio_tag' }
  },
  ...extra
})
const input = (
  kind: IdentificationInput['kind'] = 'artist',
  sources = [source()]
): IdentificationInput => ({
  entityId: 'entity',
  kind,
  version: 'version',
  linkRevision: 0,
  name: kind === 'artist' ? 'Artist' : kind === 'recording' ? 'Song' : 'Album',
  artist: kind === 'artist' ? '' : 'Artist',
  sources
})
const mbRow = (kind: IdentificationInput['kind']) =>
  kind === 'artist'
    ? { id: MBID, name: 'Artist', type: 'Person' }
    : {
        id: MBID,
        title: kind === 'recording' ? 'Song' : 'Album',
        'artist-credit': [{ name: 'Artist' }],
        ...(kind === 'recording'
          ? { length: 200250 }
          : kind === 'album_project'
            ? { 'primary-type': 'Album' }
            : { status: 'Official', barcode: '123' })
      }
const proposal = (id = '42'): IdentificationProposal => ({
  provider: 'ncm',
  name: 'Artist',
  summary: '',
  matcherVersion: 'fixture-v1',
  references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: id }],
  evidence: {
    origin: 'search',
    matches: ['name'],
    missing: ['verified_identity'],
    conflicts: [],
    incomplete: false,
    provenance: 'fixture'
  }
})
const recalled = (proposals = [proposal()]): IdentificationRecall => ({
  proposals,
  incomplete: false,
  reasons: []
})

for (const kind of ['artist', 'recording', 'album_project', 'release'] as const) {
  test(`MusicBrainz ${kind} uses only its typed ID and records the matching layer`, async () => {
    const calls: URL[] = []
    const provider = new MusicBrainzIdentificationProvider(
      () => policy,
      async (url, options) => {
        calls.push(new URL(String(url)))
        assert.ok(options?.signal)
        return json(mbRow(kind))
      },
      () => 1000
    )
    const s = source({
      tags: {
        version: 1,
        scope: 'audio_file',
        durationSeconds: { value: 200.25, origin: 'audio_tag' },
        musicbrainz: {
          artistIds: kind === 'artist' ? [MBID] : [],
          albumArtistIds: [OTHER],
          ...(kind === 'recording'
            ? { recordingId: MBID, releaseTrackId: OTHER }
            : kind === 'album_project'
              ? { releaseGroupId: MBID, releaseId: OTHER }
              : kind === 'release'
                ? { releaseId: MBID, releaseGroupId: OTHER }
                : {})
        }
      }
    })
    const result = await provider.recall(input(kind, [s]), signal())
    assert.equal(calls.length, 1)
    assert.match(
      calls[0].pathname,
      new RegExp(`/${kind === 'album_project' ? 'release-group' : kind}/${MBID}$`)
    )
    assert.deepEqual(result.proposals[0].references, [
      { provider: 'musicbrainz', kind, idType: 'mbid', value: MBID }
    ])
    assert.equal(result.proposals[0].evidence.origin, 'explicit_id')
    if (kind === 'recording') assert.ok(result.proposals[0].evidence.matches.includes('duration'))
    assert.equal(result.proposals[0].evidence.verification?.method, 'typed_id')
    assert.ok(!result.proposals[0].evidence.missing.includes('pressing_disambiguation'))
  })
}

test('release-track and album-artist IDs are not recording or performer IDs', async () => {
  const urls: URL[] = []
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      const u = new URL(String(url))
      urls.push(u)
      return json({ count: 0, [u.pathname.endsWith('artist') ? 'artists' : 'recordings']: [] })
    }
  )
  const s = source({
    tags: {
      version: 1,
      scope: 'cue_track',
      musicbrainz: { artistIds: [], albumArtistIds: [MBID], releaseTrackId: MBID }
    }
  })
  await provider.recall(input('artist', [s]), signal())
  await provider.recall(input('recording', [s]), signal())
  assert.ok(urls.every((u) => u.searchParams.has('query')))
  assert.ok(urls.every((u) => !u.href.includes(MBID)))
})

test('invalid IDs and wrong entity types are reported without falling through to a name match', async () => {
  let calls = 0
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => {
      calls++
      return json({ id: MBID, title: 'A recording', length: 200000 })
    }
  )
  const s = source({
    tags: {
      version: 1,
      scope: 'audio_file',
      musicbrainz: { artistIds: ['not-an-id'], albumArtistIds: [] }
    }
  })
  let result = await provider.recall(input('artist', [s]), signal())
  assert.equal(calls, 0)
  assert.deepEqual(result.proposals, [])
  assert.equal(result.incomplete, true)
  s.tags.musicbrainz!.artistIds = [MBID]
  result = await provider.recall(input('artist', [s]), signal())
  assert.equal(calls, 1)
  assert.deepEqual(result.proposals, [])
  assert.ok(result.reasons.includes('invalid_entity_identity_or_type'))
})

test('collaborator IDs remain unaligned and lookups are bounded even with more raw IDs', async () => {
  let calls = 0
  const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      calls++
      return json({
        id: new URL(String(url)).pathname.split('/').pop(),
        name: 'Artist',
        type: 'Person'
      })
    }
  )
  const s = source({
    artists: [{ name: 'Artist' }, { name: 'Guest' }],
    tags: {
      version: 1,
      scope: 'audio_file',
      artists: { value: ['Artist', 'Guest'], origin: 'audio_tag' },
      musicbrainz: { artistIds: ids, albumArtistIds: [] }
    }
  })
  const result = await provider.recall(input('artist', [s]), signal())
  assert.equal(calls, 4)
  assert.equal(result.incomplete, true)
  assert.ok(
    result.proposals.every(
      (p) =>
        p.evidence.missing.includes('artist_id_alignment') &&
        p.evidence.conflicts.includes('multiple_explicit_ids')
    )
  )
})

test('search is one bounded escaped page; scores do not replace evidence or raw-precision duration', async () => {
  let calls = 0
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      calls++
      const u = new URL(String(url))
      assert.equal(u.searchParams.get('limit'), '10')
      assert.equal(u.searchParams.get('offset'), '0')
      assert.ok(u.searchParams.get('query')!.includes('\\" OR artist\\:'))
      return json({
        count: 120,
        recordings: Array.from({ length: 12 }, () => ({
          ...mbRow('recording'),
          title: 'Song',
          score: 100,
          length: 203000
        }))
      })
    }
  )
  const i = { ...input('recording'), name: 'Song" OR artist:*' }
  const result = await provider.recall(i, signal())
  assert.equal(calls, 1)
  assert.equal(result.proposals.length, 10)
  assert.equal(result.incomplete, true)
  assert.ok(
    result.proposals.every(
      (p) =>
        p.evidence.origin === 'search' &&
        p.evidence.missing.includes('verified_identity') &&
        p.evidence.conflicts.includes('duration')
    )
  )
})

test('empty, unknown and Various Artists names do not trigger name-only performer lookups', async () => {
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => {
      assert.fail('no meaningful query')
    }
  )
  for (const name of ['', '未知歌手', 'Unknown Artist', 'Various Artists']) {
    const result = await provider.recall({ ...input(), name }, signal())
    assert.deepEqual(result.proposals, [])
    assert.ok(result.reasons.includes('insufficient_metadata'))
  }
})

test('project search uses releasegroup syntax and cannot establish a pressing or a complete album', async () => {
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      assert.match(new URL(String(url)).searchParams.get('query')!, /^releasegroup:/)
      return json({ count: 1, 'release-groups': [mbRow('album_project')] })
    }
  )
  const result = await provider.recall(input('album_project'), signal())
  assert.equal(result.proposals[0].references[0].kind, 'album_project')
  assert.ok(result.proposals[0].evidence.missing.includes('complete_track_validation'))
})

test('MB approval and Retry-After remain independent from platform eligibility', async () => {
  const provider = new MusicBrainzIdentificationProvider(
    () => ({ ...policy, publicServiceApproved: false }),
    async () => {
      assert.fail('not approved')
    }
  )
  await assert.rejects(provider.recall(input(), signal()), /public_service_not_approved/)
  const limited = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => new Response('', { status: 429, headers: { 'Retry-After': '15' } }),
    () => 1000
  )
  await assert.rejects(
    limited.recall(input(), signal()),
    (e: unknown) => e instanceof MetadataHttpError && e.retryAt === 16000
  )
})

function platform(search?: (method: string) => Promise<unknown>) {
  const inventory: IdentificationPlatform[] = [
    {
      id: 'ncm',
      enabled: true,
      configuration: '1',
      supportedMethods: ['searchArtists', 'searchSongs', 'searchAlbums']
    }
  ]
  const calls: string[] = []
  const provider = new PlatformIdentificationProvider('ncm', {
    inventory: () => inventory,
    search: async (id, method, query, limit, offset, sig) => {
      assert.equal(id, 'ncm')
      assert.ok(query)
      assert.equal(limit, 10)
      assert.equal(offset, 0)
      sig.throwIfAborted()
      calls.push(method)
      return search ? search(method) : { items: [{ id: 42, name: 'Artist' }], total: 1 }
    }
  })
  return { provider, inventory, calls }
}

test('native artist IDs use catalog credit positions, not the first artist or an MBID', async () => {
  const { provider, calls } = platform()
  const i = input('artist', [
    source({
      provider: 'ncm',
      artists: [
        { id: 1, name: 'Guest' },
        { id: 42, name: 'Artist' }
      ],
      artistIndexes: [1]
    })
  ])
  const result = await provider.recall(i, signal())
  assert.deepEqual(calls, [])
  assert.equal(result.proposals[0].references[0].value, '42')
  assert.equal(result.proposals[0].evidence.origin, 'provider_native')
  assert.equal(provider.supports('album_project'), false)
})

test('a local legacy artist ID is only a search hint; only declared methods can run', async () => {
  const { provider, inventory, calls } = platform()
  await provider.recall(
    input('artist', [source({ artists: [{ id: 42, name: 'Artist' }] })]),
    signal()
  )
  assert.deepEqual(calls, ['searchArtists'])
  inventory[0].supportedMethods = ['fetchArtistIntro']
  const result = await provider.recall(input(), signal())
  assert.deepEqual(result.reasons, ['provider_search_not_supported'])
  assert.deepEqual(calls, ['searchArtists'])
  inventory[0].enabled = false
  await assert.rejects(provider.recall(input(), signal()), /provider_disabled/)
  assert.deepEqual(calls, ['searchArtists'])
})

test('platform search preserves ambiguity, truncation and a distinct album scope', async () => {
  const { provider } = platform(async (method) =>
    method === 'searchAlbums'
      ? { total: 2, items: [{ id: 'album', name: 'Album', artist: 'Artist' }] }
      : {
          total: 2,
          items: [
            { id: 'ncm:7', title: 'Song', artist: 'Other', duration: 203, source: 'ncm' },
            { id: 'foreign', source: 'other', title: 'Song' }
          ]
        }
  )
  const songs = await provider.recall(input('recording'), signal())
  assert.equal(songs.proposals.length, 1)
  assert.equal(songs.incomplete, true)
  assert.ok(songs.proposals[0].evidence.conflicts.includes('artist_credit'))
  assert.ok(songs.proposals[0].evidence.conflicts.includes('duration'))
  const albums = await provider.recall(input('release'), signal())
  assert.equal(albums.proposals[0].references[0].kind, 'release')
  assert.equal(albums.proposals[0].references[0].provider, 'ncm')
  assert.ok(albums.proposals[0].evidence.missing.includes('pressing_disambiguation'))
  assert.equal(albums.incomplete, true)
})

function seed(db: LibraryDatabase) {
  const track: TrackData = {
    id: 'one',
    source: 'local',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:/music/one.flac',
    fileName: 'one.flac',
    duration: 200,
    size: 0,
    cover: null,
    lyrics: null
  }
  db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks: [track] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return db.catalogQuery({ kind: 'artist' }).items[0].id
}
const asyncDb = (db: LibraryDatabase): EntityMetadataDatabaseApi =>
  new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
const fixtureProvider = (
  recall: IdentificationProvider['recall'] = async () => recalled()
): IdentificationProvider => ({
  id: 'platform.ncm',
  matcherVersion: 'fixture-v1',
  supports: () => true,
  blockedReason: () => null,
  context: () => '1',
  recall
})
const tick = () => new Promise<void>((r) => setImmediate(r))
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await tick()
  }
  throw new Error('identification condition timed out')
}
function service(
  db: LibraryDatabase,
  providers: () => IdentificationProvider[],
  getPolicy = () => policy
) {
  return new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: new MusicBrainzWikiProvider(getPolicy),
    identificationProviders: providers,
    policy: getPolicy,
    now: () => 1000,
    changed: () => {},
    failed: (e) => assert.fail(String(e))
  })
}

test('start persists shared demands in the existing queue and publishes review candidates without linking', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  let calls = 0
  const s = service(db, () => [
    fixtureProvider(async () => {
      calls++
      return recalled([proposal(), proposal('99')])
    })
  ])
  t.after(() => s.shutdown())
  const first = await s.startIdentification({ entityId, batchId: 'one' })
  const second = await s.startIdentification({ entityId, batchId: 'two' })
  assert.equal(first.batchId, 'one')
  assert.equal(first.jobs[0].id, second.jobs[0].id)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM metadata_demands').get()!.n, 2)
  s.activate()
  await until(() => db.metadataJobs({ entityId }).items[0].state === 'needs_review')
  assert.equal(calls, 1)
  assert.equal(db.identificationDetail(entityId).link!.state, 'unresolved')
  const job = db.metadataJobs({ entityId }).items[0]
  assert.equal(job.identification!.candidateIds.length, 2)
  const [candidate] = db.identificationCandidates({ entityId }).items
  await s.decideIdentity({
    candidateId: candidate.id,
    revision: candidate.revision,
    linkRevision: candidate.linkRevision,
    decision: 'confirm'
  })
  assert.equal(db.metadataJobs({ entityId }).items[0].state, 'completed')
  assert.equal(db.identificationDetail(entityId).references[0].provider, 'ncm')
})

test('native-only recall runs without MB public-service approval; global opt-out still blocks it', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db),
    activePolicy = { ...policy, publicServiceApproved: false }
  const s = service(
    db,
    () => [fixtureProvider()],
    () => activePolicy
  )
  t.after(() => s.shutdown())
  s.activate()
  const {
    jobs: [job]
  } = await s.startIdentification({ entityId, batchId: 'one' })
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'needs_review')
  activePolicy.enabled = false
  db.sql.prepare("UPDATE catalog_entities SET title='New name' WHERE id=?").run(entityId)
  await s.startIdentification({ entityId, batchId: 'two' })
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'blocked')
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].reason, 'metadata_disabled')
})

test('shared-demand cancellation aborts only the final consumer and drops a late response', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  let entered = false,
    sig!: AbortSignal,
    finish!: (result: IdentificationRecall) => void
  const s = service(db, () => [
    fixtureProvider(async (_, signal) => {
      entered = true
      sig = signal
      return new Promise((r) => {
        finish = r
      })
    })
  ])
  t.after(() => s.shutdown())
  const {
    jobs: [job]
  } = await s.startIdentification({ entityId, batchId: 'one' })
  await s.startIdentification({ entityId, batchId: 'two' })
  s.activate()
  await until(() => entered)
  await s.cancel(job.id, 'one')
  assert.equal(sig.aborted, false)
  await s.cancel(job.id, 'two')
  assert.equal(sig.aborted, true)
  finish(recalled())
  await s.shutdown()
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'cancelled')
})

test('provider configuration and disable/re-enable changes fence an in-flight response', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  let entered = false,
    finish!: (result: IdentificationRecall) => void,
    revision = '1'
  const p = {
    ...fixtureProvider(async () => {
      entered = true
      return new Promise<IdentificationRecall>((r) => {
        finish = r
      })
    }),
    context: () => revision
  }
  const s = service(db, () => [p])
  t.after(() => s.shutdown())
  s.activate()
  const {
    jobs: [job]
  } = await s.startIdentification({ entityId, batchId: 'one' })
  await until(() => entered)
  revision = '3'
  finish(recalled())
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'blocked')
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].reason, 'provider_configuration_changed')
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
})

test('recover advances generation; changes to inputs or links reject stale publication atomically', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  const request = {
    entityId,
    batchId: 'one',
    providers: [{ id: 'platform.ncm', matcherVersion: 'fixture-v1' }]
  }
  const [job] = db.identificationEnqueue(request, 1000)
  const old = db.metadataClaim(1000)!
  db.metadataRecover(1001)
  assert.equal(db.metadataFinish(old, { state: 'identified', ...recalled() }, 1002), false)
  const work = db.metadataClaim(1002)!
  assert.equal(work.job.generation, job.generation + 1)
  db.sql.prepare("UPDATE catalog_entities SET title='Changed' WHERE id=?").run(entityId)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...recalled() }, 1003), false)
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
  db.identificationEnqueue(request, 1004)
  db.sql.prepare("UPDATE catalog_entities SET title='Changed again' WHERE id=?").run(entityId)
  assert.equal(db.metadataClaim(1004), null, 'stale queued work is discarded before remote calls')
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].reason, 'input_changed')
})

test('recall publication is atomic and rejection remains suppressed on the next request', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  const request = {
    entityId,
    batchId: 'one',
    providers: [{ id: 'platform.ncm', matcherVersion: 'fixture-v1' }]
  }
  const [job] = db.identificationEnqueue(request, 1000)
  const work = db.metadataClaim(1000)!
  db.sql.exec(
    "CREATE TRIGGER fail_recall BEFORE UPDATE ON metadata_jobs WHEN new.state='needs_review' BEGIN SELECT RAISE(ABORT,'simulated full disk'); END"
  )
  assert.throws(
    () => db.metadataFinish(work, { state: 'identified', ...recalled() }, 1001),
    /full disk/
  )
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
  db.sql.exec('DROP TRIGGER fail_recall')
  db.metadataFinish(work, { state: 'identified', ...recalled() }, 1002)
  const c = db.identificationCandidates({ entityId }).items[0]
  db.identificationDecide(
    { candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision, decision: 'reject' },
    1003
  )
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'completed')
  db.identificationEnqueue(request, 86402000)
  db.metadataFinish(db.metadataClaim(86402000)!, { state: 'identified', ...recalled() }, 86402001)
  const again = db.identificationCandidates({ entityId }).items[0]
  assert.equal(again.id, c.id)
  assert.equal(again.suppressed, true)
  assert.equal(again.state, 'rejected')
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'completed')
})

test('start accepts only an indexed entity and stable demand ID with write permission', () => {
  const request = {
    kind: 'command',
    name: 'identification.start',
    requestId: '1',
    epoch: 'core',
    payload: { entityId: 'one', batchId: 'batch' }
  }
  assert.equal(isCoreRequest(request), true)
  assert.equal(coreOperation('identification.start')!.permission, 'library:write')
  for (const extra of [
    { providers: ['ncm'] },
    { references: [] },
    { url: 'https://example.com' },
    { all: true }
  ])
    assert.equal(isCoreRequest({ ...request, payload: { ...request.payload, ...extra } }), false)
  assert.equal(isCoreRequest({ ...request, payload: { entityId: 'one' } }), false)
})

for (const failure of [
  'claim_after_commit',
  'finish_before_commit',
  'finish_after_commit'
] as const) {
  test(`Core reconciles ${failure} without replaying a write or waiting for a window`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const entityId = seed(db)
    const database = asyncDb(db),
      errors: unknown[] = []
    let failed = false,
      calls = 0
    const transport = new Proxy(database, {
      get: (target, key: keyof EntityMetadataDatabaseApi) => {
        if (key === 'metadataClaim' && failure === 'claim_after_commit')
          return async (now: number) => {
            const result = await target.metadataClaim(now)
            if (result && !failed) {
              failed = true
              throw new Error('claim acknowledgement lost')
            }
            return result
          }
        if (key === 'metadataFinish' && failure !== 'claim_after_commit')
          return async (...args: Parameters<EntityMetadataDatabaseApi['metadataFinish']>) => {
            if (!failed) {
              failed = true
              if (failure === 'finish_after_commit') await target.metadataFinish(...args)
              throw new Error('finish outcome unknown')
            }
            return target.metadataFinish(...args)
          }
        return target[key]
      }
    })
    const s = new CoreEntityMetadataService({
      database: transport,
      provider: new MusicBrainzWikiProvider(() => policy),
      policy: () => policy,
      identificationProviders: () => [
        fixtureProvider(async () => {
          calls++
          return recalled()
        })
      ],
      now: () => 1000,
      changed: () => {},
      failed: (e) => errors.push(e)
    })
    t.after(() => s.shutdown())
    s.activate()
    const {
      jobs: [job]
    } = await s.startIdentification({ entityId, batchId: 'durable' })
    await until(() => errors.length === 1)
    t.mock.timers.tick(1000)
    await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'needs_review')
    assert.equal(db.identificationCandidates({ entityId }).total, 1)
    assert.equal(db.identificationCandidates({ entityId }).items[0].revision, 1)
    assert.equal(calls, failure === 'finish_before_commit' ? 2 : 1)
    assert.equal(
      db.metadataJobs({ jobId: job.id }).items[0].generation,
      job.generation + (failure === 'finish_after_commit' ? 0 : 1)
    )
  })
}

test('a lost start acknowledgement is reported to its caller while committed demands still run', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  const database = asyncDb(db)
  let enqueueCalls = 0
  const transport = new Proxy(database, {
    get: (target, key: keyof EntityMetadataDatabaseApi) =>
      key === 'identificationEnqueue'
        ? async (...args: Parameters<EntityMetadataDatabaseApi['identificationEnqueue']>) => {
            enqueueCalls++
            await target.identificationEnqueue(...args)
            throw new Error('enqueue acknowledgement lost')
          }
        : target[key]
  })
  const s = new CoreEntityMetadataService({
    database: transport,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    identificationProviders: () => [fixtureProvider()],
    now: () => 1000,
    changed: () => {},
    failed: (e) => assert.fail(String(e))
  })
  t.after(() => s.shutdown())
  s.activate()
  await assert.rejects(
    s.startIdentification({ entityId, batchId: 'durable' }),
    /acknowledgement lost/
  )
  await until(() => db.metadataJobs({ entityId }).items[0]?.state === 'needs_review')
  assert.equal(enqueueCalls, 1)
  assert.equal(db.identificationCandidates({ entityId }).total, 1)
})
