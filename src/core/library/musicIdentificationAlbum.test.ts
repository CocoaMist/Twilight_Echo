import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_IDENTIFICATION_ALBUM_FENCE_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import type { TrackData } from '../../shared/track.ts'
import type {
  IdentificationInput,
  IdentificationProposal
} from '../../shared/musicIdentification.ts'
import { localAlbumLayout, validateAlbumTracks } from '../../shared/musicAlbumValidation.ts'
import { musicBrainzAlbum } from './musicIdentificationAlbum.ts'
import type { PlatformAlbumIdentity } from '../../shared/musicPlatformAlbum.ts'
import type { PlatformIdentificationOptions } from './musicIdentificationProvider.ts'
import {
  MusicBrainzIdentificationProvider,
  PlatformIdentificationProvider,
  type IdentificationProvider
} from './musicIdentificationProvider.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ARTIST = id(1),
  PROJECT = id(2),
  RELEASE = id(3),
  PRESSING = id(4)
const policy = {
  enabled: true,
  publicServiceApproved: true,
  contact: 'https://example.com/app',
  wikipediaText: false
}
const json = (v: unknown) => new Response(JSON.stringify(v))
const credit = (name = 'Artist', artist = ARTIST) => [{ name, artist: { name, id: artist } }]
const mb = (extra: Record<string, unknown> = {}) => ({
  artistIds: [],
  albumArtistIds: [],
  ...extra
})
function track(n = 1, extra: Partial<TrackData> = {}): TrackData {
  return {
    id: `local-${n}`,
    source: 'local',
    filePath: `D:/music/album/${n}.flac`,
    fileName: `${n}.flac`,
    title: `Song ${n}`,
    artist: 'Artist',
    album: 'Album',
    duration: 200,
    size: 0,
    cover: null,
    lyrics: null,
    identityTags: {
      version: 1,
      scope: 'audio_file',
      title: { value: `Song ${n}`, origin: 'audio_tag' },
      artists: { value: ['Artist'], origin: 'audio_tag' },
      album: { value: 'Album', origin: 'audio_tag' },
      trackNumber: { value: n, origin: 'audio_tag' },
      trackTotal: { value: 2, origin: 'audio_tag' },
      discNumber: { value: 1, origin: 'audio_tag' },
      discTotal: { value: 1, origin: 'audio_tag' },
      durationSeconds: { value: 200.25, origin: 'audio_tag' }
    },
    ...extra
  }
}
function seed(db: LibraryDatabase, tracks = [track(1), track(2)]) {
  db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return (kind: IdentificationInput['kind']) => db.catalogQuery({ kind }).items[0].id
}
const remote = (release = RELEASE, project = PROJECT) => ({
  id: release,
  title: 'Album',
  status: 'Official',
  'artist-credit': credit(),
  'release-group': { id: project },
  media: [
    {
      position: 1,
      'track-count': 2,
      tracks: [1, 2].map((n) => ({
        position: n,
        title: `Song ${n}`,
        id: id(100 + n),
        length: 200250,
        'artist-credit': credit(),
        recording: { id: id(200 + n) }
      }))
    }
  ]
})
function provider(
  options: {
    kind?: 'album_project' | 'release'
    projects?: string[]
    releases?: string[]
    searchCount?: number
    releaseCount?: number
    edit?: (r: ReturnType<typeof remote>, release: string) => Record<string, unknown>
  } = {}
) {
  const calls: URL[] = [],
    kind = options.kind ?? 'album_project',
    projects = options.projects ?? [PROJECT],
    releases = options.releases ?? [RELEASE]
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      const u = new URL(String(url))
      calls.push(u)
      if (u.searchParams.has('query')) {
        const items =
          kind === 'release'
            ? releases.map((r) => remote(r))
            : projects.map((p) => ({
                id: p,
                title: 'Album',
                'primary-type': 'Album',
                'artist-credit': credit()
              }))
        return json({
          count: options.searchCount ?? items.length,
          [kind === 'release' ? 'releases' : 'release-groups']: items
        })
      }
      if (u.searchParams.has('release-group')) {
        const project = u.searchParams.get('release-group')!
        const rs = projects.length > 1 ? [releases[projects.indexOf(project)]] : releases
        return json({
          'release-count': options.releaseCount ?? rs.length,
          releases: rs.map((r) => ({ id: r }))
        })
      }
      const release = u.pathname.split('/').pop()!,
        project = projects.length > 1 ? projects[releases.indexOf(release)] : PROJECT
      const r = remote(release, project)
      return json(options.edit?.(r, release) ?? r)
    },
    () => 1000
  )
  return { p, calls }
}
async function run(
  db: LibraryDatabase,
  entityId: string,
  p: IdentificationProvider,
  batchId = 'batch'
) {
  db.identificationEnqueue(
    { entityId, batchId, providers: [{ id: p.id, matcherVersion: p.matcherVersion }] },
    1000
  )
  const work = db.metadataClaim(1000)!
  assert.ok(work?.identification)
  const result = await p.recall(work.identification, new AbortController().signal)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1001), true)
  return {
    result,
    work,
    link: db.identificationDetail(entityId).link!,
    job: db.metadataJobs({ jobId: work.job.id }).items[0]
  }
}

for (const kind of ['artist', 'recording', 'album_project', 'release'] as const) {
  test(`verified typed ${kind} ID confirms only its own layer in the finish transaction`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const item = track(1)
    item.identityTags!.musicbrainz = mb(
      kind === 'artist'
        ? { artistIds: [ARTIST] }
        : kind === 'recording'
          ? { recordingId: ARTIST }
          : kind === 'release'
            ? { releaseId: ARTIST }
            : { releaseGroupId: ARTIST }
    )
    const entity = seed(db, [item])
    const p = new MusicBrainzIdentificationProvider(
      () => policy,
      async () =>
        json(
          kind === 'artist'
            ? { id: ARTIST, name: 'Artist', type: 'Person' }
            : kind === 'recording'
              ? { id: ARTIST, title: 'Song 1', length: 200250, 'artist-credit': credit() }
              : {
                  id: ARTIST,
                  title: 'Album',
                  status: 'Official',
                  'primary-type': 'Album',
                  'artist-credit': credit()
                }
        )
    )
    const { link, job } = await run(db, entity(kind), p)
    assert.equal(link.state, 'confirmed')
    assert.deepEqual(link.confirmation, { mode: 'automatic', rule: 'typed_id' })
    assert.equal(job.state, 'completed')
    assert.equal(job.reason, 'identity_confirmed_automatically')
    assert.equal(
      db.identificationCandidates({ entityId: entity(kind) }).items[0].state,
      'confirmed'
    )
    for (const other of ['artist', 'recording', 'album_project', 'release'] as const)
      if (other !== kind) assert.equal(db.identificationDetail(entity(other)).link, null)
  })
}

for (const kind of ['artist', 'recording', 'release'] as const) {
  test(`indexed native ${kind} confirms its platform namespace without MB or search`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    let batch = db.catalogSync({ kind: 'begin', revision: 1 })
    batch = db.catalogSync({
      kind: 'append',
      ...batch,
      tracks: [
        track(1, {
          id: 'ncm:7',
          source: 'ncm',
          filePath: '',
          albumId: '42',
          artists: [{ id: 9, name: 'Artist' }]
        })
      ]
    })
    db.catalogSync({ kind: 'commit', ...batch })
    const entityId = db.catalogQuery({ kind, source: 'ncm' }).items[0].id
    const p = new PlatformIdentificationProvider('ncm', {
      inventory: () => [
        {
          id: 'ncm',
          enabled: true,
          configuration: '1',
          supportedMethods: ['searchArtists', 'searchSongs', 'searchAlbums']
        }
      ],
      search: async () => assert.fail('native identity must not issue a search')
    })
    const { link } = await run(db, entityId, p)
    assert.deepEqual(link.confirmation, { mode: 'automatic', rule: 'provider_native' })
    assert.equal(db.identificationDetail(entityId).references[0].provider, 'ncm')
  })
}

test('identical complete tracks across two pressings confirm the project, not a release', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entity = seed(db),
    { p, calls } = provider({ releases: [RELEASE, PRESSING] })
  const { link, result } = await run(db, entity('album_project'), p)
  assert.equal(link.state, 'confirmed')
  assert.deepEqual(link.confirmation, { mode: 'automatic', rule: 'album_tracks' })
  assert.equal(db.identificationDetail(entity('release')).link, null)
  assert.equal(calls.length, 4)
  assert.equal(result.proposals[0].evidence.verification?.method, 'album_tracks')
  const proof = result.proposals[0].evidence.verification!
  assert.ok(proof.method === 'album_tracks')
  assert.deepEqual(proof.matchedReleaseIds, [RELEASE, PRESSING])
})

for (const releases of [[RELEASE], [RELEASE, PRESSING]]) {
  test(`${releases.length} complete pressing candidates without distinguishing tags remain reviewable`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const entity = seed(db),
      { p } = provider({ kind: 'release', releases })
    const { link, job, result } = await run(db, entity('release'), p)
    assert.equal(link.state, 'unresolved')
    assert.equal(job.state, 'needs_review')
    assert.ok(result.proposals.every((p) => p.evidence.missing.includes('pressing_disambiguation')))
    assert.ok(result.proposals.every((p) => !p.evidence.verification))
  })
}

test('complete tracks and a uniquely matching barcode can confirm the release', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks = [track(1), track(2)]
  tracks.forEach((t) => {
    t.identityTags!.barcode = '123'
  })
  const entity = seed(db, tracks),
    { p } = provider({
      kind: 'release',
      releases: [RELEASE, PRESSING],
      edit: (r, release) => ({ ...r, barcode: release === RELEASE ? '123' : '456' })
    })
  const { link } = await run(db, entity('release'), p)
  assert.equal(link.state, 'confirmed')
  assert.equal(db.identificationDetail(entity('release')).references[0].value, RELEASE)
})

test('two projects with indistinguishable full tracks are not resolved by search ranking', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entity = seed(db),
    { p } = provider({ projects: [PROJECT, id(5)], releases: [RELEASE, PRESSING] })
  const { link, job } = await run(db, entity('album_project'), p)
  assert.equal(link.state, 'unresolved')
  assert.equal(job.state, 'needs_review')
})

for (const variant of [
  'partial',
  'unknown_total',
  'duplicate_position',
  'legacy',
  'mixed_folder',
  'cue_without_totals'
] as const) {
  test(`local ${variant} never claims full-album evidence; usable partial imports prove only the project`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const tracks = variant === 'partial' ? [track(1)] : [track(1), track(2)]
    if (variant === 'unknown_total') delete tracks[0].identityTags!.trackTotal
    if (variant === 'duplicate_position') tracks[1].identityTags!.trackNumber!.value = 1
    if (variant === 'legacy') tracks[0].identityTags!.title!.origin = 'legacy'
    if (variant === 'mixed_folder') {
      tracks.forEach((t) => {
        t.albumArtist = 'Band'
        t.identityTags!.albumArtist = { value: 'Band', origin: 'audio_tag' }
      })
      tracks[1].filePath = 'D:/other/album/2.flac'
    }
    if (variant === 'cue_without_totals') {
      tracks.forEach((t) => {
        t.identityTags!.scope = 'cue_track'
        delete t.identityTags!.trackTotal
      })
    }
    const entity = seed(db, tracks),
      { p, calls } = provider()
    const { link } = await run(db, entity('album_project'), p)
    const subset = ['partial', 'unknown_total', 'cue_without_totals'].includes(variant)
    assert.equal(link.state, subset ? 'confirmed' : 'unresolved')
    assert.equal(link.confirmation?.rule, subset ? 'album_subset' : undefined)
    assert.equal(calls.length, subset ? 3 : 1)
    assert.notEqual(db.identificationDetail(entity('release')).link?.state, 'confirmed')
  })
}

for (const variant of [
  'title_version',
  'all_artists',
  'fractional_duration',
  'recording_id',
  'release_track_id',
  'isrc'
] as const) {
  test(`full-track ${variant} contradiction prevents album confirmation`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const tracks = [track(1), track(2)],
      tags = tracks[0].identityTags!
    if (variant === 'title_version') tags.title!.value = 'Song 1 (Live)'
    if (variant === 'all_artists') tags.artists!.value.push('Guest')
    if (variant === 'fractional_duration') tags.durationSeconds!.value = 202.251
    if (variant === 'recording_id') tags.musicbrainz = mb({ recordingId: id(999) })
    if (variant === 'release_track_id') tags.musicbrainz = mb({ releaseTrackId: id(999) })
    if (variant === 'isrc') tags.isrcs = ['USXXX0000001']
    const entity = seed(db, tracks),
      { p } = provider({
        edit: (r) => ({
          ...r,
          media: r.media.map((m) => ({
            ...m,
            tracks: m.tracks.map((t) => ({
              ...t,
              recording: { ...t.recording, isrcs: ['USXXX0000002'] }
            }))
          }))
        })
      })
    const { link, result } = await run(db, entity('album_project'), p)
    assert.equal(link.state, 'unresolved')
    assert.ok(result.proposals[0].evidence.conflicts.length)
  })
}

for (const variant of [
  'search_count',
  'browse_count',
  'missing_remote_track',
  'missing_remote_duration',
  'wrong_release_id',
  'unvalidated_pregap'
] as const) {
  test(`remote ${variant} leaves the candidate set incomplete`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const entity = seed(db),
      { p } = provider({
        ...(variant === 'search_count' ? { searchCount: 2 } : {}),
        ...(variant === 'browse_count' ? { releaseCount: 5 } : {}),
        edit: (r) => {
          if (variant === 'missing_remote_track') r.media[0].tracks.pop()
          if (variant === 'missing_remote_duration') r.media[0].tracks[0].length = 0
          if (variant === 'wrong_release_id') r.id = id(999)
          if (variant === 'unvalidated_pregap')
            return { ...r, media: [{ ...r.media[0], pregap: { title: 'Hidden audio' } }] }
          return r
        }
      })
    const { link, result } = await run(db, entity('album_project'), p)
    assert.equal(link.state, 'unresolved')
    assert.equal(result.incomplete, true)
  })
}

test('multi-disc layout checks every disc total and uses the original CUE interval precision', () => {
  const sources = [track(1), track(2)].map((t, i) => ({
    sourceId: t.id,
    provider: 'local',
    trackId: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumArtist: '',
    artists: [{ name: 'Artist' }],
    artistIndexes: [],
    duration: 202,
    albumCohort: '1',
    tags: {
      ...t.identityTags!,
      scope: 'cue_track' as const,
      discNumber: { value: i + 1, origin: 'cue' as const },
      trackNumber: { value: 1, origin: 'cue' as const },
      trackTotal: { value: 1, origin: 'audio_tag' as const },
      discTotal: { value: 2, origin: 'audio_tag' as const }
    }
  }))
  const input: IdentificationInput = {
    entityId: 'e',
    kind: 'album_project',
    name: 'Album',
    artist: 'Artist',
    version: 'v',
    linkRevision: 0,
    sources
  }
  const r = remote()
  r.media.push({
    position: 2,
    'track-count': 1,
    tracks: [{ ...r.media[0].tracks[1], position: 1 }]
  })
  r.media[0].tracks.pop()
  r.media[0]['track-count'] = 1
  const parsed = musicBrainzAlbum(r)!
  assert.deepEqual(localAlbumLayout(input), { missing: [], conflicts: [] })
  assert.deepEqual(validateAlbumTracks(input, parsed), {
    missing: [],
    conflicts: [],
    pressing: false
  })
  sources[1].tags.discTotal.value = 3
  assert.ok(localAlbumLayout(input).missing.includes('complete_local_positions'))
})

test('automatic confirmation is atomic, replay-safe and survives a database reopen', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'album-confirm-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const entity = seed(db),
    entityId = entity('album_project'),
    { p } = provider()
  db.identificationEnqueue(
    { entityId, batchId: 'batch', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] },
    1000
  )
  const work = db.metadataClaim(1000)!,
    recall = await p.recall(work.identification!, new AbortController().signal)
  db.sql.exec(
    "CREATE TRIGGER fail_confirm BEFORE INSERT ON metadata_identity_history WHEN new.state='confirmed' BEGIN SELECT RAISE(ABORT,'test failure'); END;"
  )
  assert.throws(
    () => db.metadataFinish(work, { state: 'identified', ...recall }, 1001),
    /test failure/
  )
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
  assert.equal(db.identificationDetail(entityId).link, null)
  assert.equal(db.metadataJobs({ entityId }).items[0].state, 'running')
  db.sql.exec('DROP TRIGGER fail_confirm')
  assert.equal(db.metadataFinish(work, { state: 'identified', ...recall }, 1002), true)
  const target = db.identificationDetail(entityId).link!.targetId
  assert.equal(db.metadataFinish(work, { state: 'identified', ...recall }, 1003), false)
  db.close()
  db = new LibraryDatabase(path)
  db.metadataRecover(2000)
  assert.equal(db.metadataClaim(2000), null)
  assert.equal(db.identificationDetail(entityId).link!.targetId, target)
  assert.equal(db.identificationDetail(entityId).link!.confirmation!.mode, 'automatic')
  assert.equal(
    db.sql
      .prepare("SELECT count(*) n FROM metadata_identity_history WHERE state='confirmed' AND link_id=?")
      .get(db.identificationDetail(entityId).link!.id)!.n,
    1
  )
})

for (const manual of ['reject', 'detach', 'confirm_other'] as const) {
  test(`automatic evidence cannot override a prior manual ${manual}`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const entity = seed(db),
      entityId = entity('album_project'),
      { p } = provider()
    const recall = await p.recall(db.identificationInput(entityId), new AbortController().signal)
    const proposal = structuredClone(recall.proposals[0])
    if (manual === 'confirm_other') {
      proposal.references[0].value = id(999)
      delete proposal.evidence.verification
    }
    const [candidate] = db.identificationPublish(db.identificationInput(entityId), [proposal], 500)
    db.identificationDecide(
      {
        candidateId: candidate.id,
        revision: candidate.revision,
        linkRevision: candidate.linkRevision,
        decision: manual === 'reject' ? 'reject' : 'confirm'
      },
      501
    )
    if (manual === 'detach') {
      const link = db.identificationDetail(entityId).link!
      db.identificationDetach(link.id, link.revision, 502)
    }
    const before = db.identificationDetail(entityId),
      { link } = await run(db, entityId, p)
    assert.deepEqual(db.identificationDetail(entityId), before)
    assert.notEqual(link.confirmation?.mode, 'automatic')
  })
}

test('match labels alone are not a proof, and changing input cancels late verified results', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entity = seed(db),
    entityId = entity('album_project'),
    { p } = provider()
  const result = await p.recall(db.identificationInput(entityId), new AbortController().signal)
  const unverified: IdentificationProposal = structuredClone(result.proposals[0])
  delete unverified.evidence.verification
  const fake: IdentificationProvider = {
    ...p,
    id: p.id,
    matcherVersion: p.matcherVersion,
    supports: () => true,
    blockedReason: () => null,
    context: () => '1',
    recall: async () => ({ ...result, proposals: [unverified] })
  }
  const { link } = await run(db, entityId, fake)
  assert.equal(link.state, 'unresolved')
  db.identificationEnqueue(
    { entityId, batchId: 'late', providers: [{ id: p.id, matcherVersion: 'changed' }] },
    2000
  )
  const work = db.metadataClaim(2000)!
  db.sql
    .prepare(
      "UPDATE catalog_sources SET payload=json_set(payload,'$.identityTags.durationSeconds.value',210) WHERE id=?"
    )
    .run(work.identification!.sources![0].sourceId)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 2001), false)
  assert.equal(db.identificationDetail(entityId).link!.state, 'unresolved')
})

test('v15 migration backs up identities and adds monotonic folder-cohort fences', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'album-v15-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const entityId = seed(db)('album_project'),
    before = db.identificationInput(entityId)
  db.sql.exec(LEGACY_IDENTIFICATION_ALBUM_FENCE_SQL + 'PRAGMA user_version=15;')
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  assert.equal(db.identificationInput(entityId).version, before.version)
  const sourceId = before.sources![0].sourceId
  const oldKey = String(
    db.sql.prepare('SELECT source_key FROM catalog_sources WHERE id=?').get(sourceId)!.source_key
  )
  const update = db.sql.prepare('UPDATE catalog_sources SET source_key=? WHERE id=?')
  update.run(JSON.stringify(['local', 'd:/different/1.flac', null, null]), sourceId)
  assert.ok(
    localAlbumLayout(db.identificationInput(entityId)).missing.includes('single_album_cohort')
  )
  update.run(oldKey, sourceId)
  assert.notEqual(db.identificationInput(entityId).version, before.version)
  const backup = new DatabaseSync(
    join(root, readdirSync(root).find((f) => f.includes('.v15-backup-'))!)
  )
  assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 15)
  backup.close()
})

test('album candidate and release lookup budgets never turn the inspected subset into a unique result', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)('album_project'),
    { p, calls } = provider({
      projects: [PROJECT, id(5), id(6), id(7), id(8)],
      releases: [RELEASE, PRESSING, id(9), id(10), id(11)]
    })
  const { link, result } = await run(db, entityId, p)
  assert.equal(link.state, 'unresolved')
  assert.equal(result.incomplete, true)
  assert.ok(result.reasons.includes('album_candidate_limit'))
  assert.equal(calls.filter((u) => /\/release\//.test(u.pathname)).length, 4)
  assert.equal(calls.length, 9)
})

test('Various Artists stays at album level while every actual track performer is compared', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks = [track(1), track(2)]
  for (const [i, item] of tracks.entries()) {
    item.artist = `Artist ${i + 1}`
    item.albumArtist = 'Various Artists'
    item.identityTags!.artists!.value = [item.artist]
    item.identityTags!.albumArtist = { value: 'Various Artists', origin: 'audio_tag' }
  }
  const entityId = seed(db, tracks)('album_project')
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      const u = new URL(String(url))
      if (u.searchParams.has('query'))
        return json({
          count: 1,
          'release-groups': [
            {
              id: PROJECT,
              title: 'Album',
              'primary-type': 'Album',
              'artist-credit': credit('Various Artists', id(20))
            }
          ]
        })
      if (u.searchParams.has('release-group'))
        return json({ 'release-count': 1, releases: [{ id: RELEASE }] })
      const r = remote()
      r['artist-credit'] = credit('Various Artists', id(20))
      r.media[0].tracks.forEach((t, i) => {
        t['artist-credit'] = credit(`Artist ${i + 1}`, id(30 + i))
      })
      return json(r)
    }
  )
  assert.equal((await run(db, entityId, p)).link.state, 'confirmed')
  for (const artist of db.catalogQuery({ kind: 'artist' }).items) {
    assert.notEqual(artist.title, 'Various Artists')
    assert.equal(db.identificationDetail(artist.id).link!.confirmation?.rule, 'album_member')
    assert.equal(db.identificationDetail(artist.id).references[0].value,
      artist.title === 'Artist 1' ? id(30) : id(31))
  }
})

test('automatic adoption invalidates other queued adapters before they can use the old link revision', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)('album_project'),
    { p } = provider()
  db.identificationEnqueue(
    { entityId, batchId: 'mb', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] },
    1000
  )
  const work = db.metadataClaim(1000)!
  const [other] = db.identificationEnqueue(
    {
      entityId,
      batchId: 'other',
      providers: [{ id: 'platform.fixture', matcherVersion: 'fixture' }]
    },
    1000
  )
  const recall = await p.recall(work.identification!, new AbortController().signal)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...recall }, 1001), true)
  assert.equal(db.metadataClaim(1002), null)
  const stale = db.metadataJobs({ jobId: other.id }).items[0]
  assert.equal(stale.state, 'cancelled')
  assert.equal(stale.reason, 'input_changed')
})

test('database rechecks a typed ID proof against the real source rather than trusting its label', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)('artist'),
    input = db.identificationInput(entityId)
  const result: IdentificationProposal = {
    provider: 'musicbrainz',
    name: 'Artist',
    summary: '',
    matcherVersion: 'forged-v1',
    references: [{ provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: ARTIST }],
    evidence: {
      origin: 'explicit_id',
      matches: ['artist_mbid'],
      missing: [],
      conflicts: [],
      incomplete: false,
      provenance: '{}',
      verification: {
        method: 'typed_id',
        reference: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: ARTIST },
        sourceIds: input.sources!.map((s) => s.sourceId)
      }
    }
  }
  const p: IdentificationProvider = {
    id: 'musicbrainz',
    matcherVersion: result.matcherVersion,
    supports: () => true,
    blockedReason: () => null,
    context: () => '1',
    recall: async () => ({ proposals: [result], incomplete: false, reasons: [] })
  }
  assert.equal((await run(db, entityId, p)).link.state, 'unresolved')
})

test('existing conflicting target references block otherwise verified automatic adoption', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)('album_project'),
    { p } = provider()
  db.sql
    .prepare(
      "INSERT INTO metadata_entities VALUES('target','internal','album_project','target','Album')"
    )
    .run()
  for (const value of [PROJECT, id(999)])
    db.sql
      .prepare(
        "INSERT INTO metadata_identity_refs VALUES('musicbrainz','album_project','mbid',?,'target')"
      )
      .run(value)
  const { link, job } = await run(db, entityId, p)
  assert.equal(link.state, 'unresolved')
  assert.equal(job.state, 'needs_review')
  const c = db.identificationCandidates({ entityId }).items[0]
  assert.ok(
    db
      .identificationPreview({
        candidateId: c.id,
        revision: c.revision,
        linkRevision: c.linkRevision
      })
      .conflicts.includes('conflicting_ids_in_same_namespace')
  )
})

test('a cancellation during full release retrieval cannot publish a late album proof', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)('album_project'),
    controller = new AbortController()
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async (url) => {
      const u = new URL(String(url))
      if (u.searchParams.has('query'))
        return json({
          count: 1,
          'release-groups': [
            { id: PROJECT, title: 'Album', 'primary-type': 'Album', 'artist-credit': credit() }
          ]
        })
      if (u.searchParams.has('release-group'))
        return json({ 'release-count': 1, releases: [{ id: RELEASE }] })
      controller.abort()
      return json(remote())
    }
  )
  await assert.rejects(p.recall(db.identificationInput(entityId), controller.signal), {
    name: 'AbortError'
  })
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
})

test('case-distinct POSIX directories cannot become one local completeness cohort', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks = [track(1), track(2)]
  tracks.forEach((item, i) => {
    item.albumArtist = 'Band'
    item.filePath = `/music/${i ? 'a' : 'A'}/${i}.flac`
  })
  const entityId = seed(db, tracks)('album_project')
  assert.ok(
    localAlbumLayout(db.identificationInput(entityId)).missing.includes('single_album_cohort')
  )
})

test('v16 DDL failure rolls back its index and keeps the v15 database and backup usable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'album-v16-rollback-')),
    path = join(root, 'library.sqlite')
  const db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(db)
  db.sql.exec(LEGACY_IDENTIFICATION_ALBUM_FENCE_SQL + 'PRAGMA user_version=15;')
  const exec = DatabaseSync.prototype.exec
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TRIGGER metadata_identification_album_cohort')) {
        exec.call(
          this,
          sql.slice(0, sql.indexOf('CREATE TRIGGER metadata_identification_album_cohort'))
        )
        throw new Error('Injected album fence failure')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /Injected album fence failure/)
  failure.mock.restore()
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 15)
  assert.equal(
    db.sql
      .prepare("SELECT name FROM sqlite_master WHERE name='metadata_identity_history_link'")
      .get(),
    undefined
  )
  assert.equal(db.getMetadata().trackCount, 2)
  const backup = new DatabaseSync(
    join(root, readdirSync(root).find((f) => f.includes('.v15-backup-'))!)
  )
  assert.equal(backup.prepare('SELECT count(*) n FROM tracks').get()!.n, 2)
  backup.close()
})

test('truncated remote names cannot turn a matching prefix into verified typed identity', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const item = track(1),
    name = 'A'.repeat(2048)
  item.artist = name
  item.identityTags!.artists!.value = [name]
  item.identityTags!.musicbrainz = mb({ artistIds: [ARTIST] })
  const entityId = seed(db, [item])('artist')
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => json({ id: ARTIST, name: name + 'B', type: 'Person' })
  )
  const { link, result } = await run(db, entityId, p)
  assert.equal(link.state, 'unresolved')
  assert.equal(result.incomplete, true)
  assert.ok(!result.proposals[0].evidence.verification)
})

test('a malformed extra remote credit cannot be filtered away before automatic confirmation', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const item = track(1)
  item.identityTags!.musicbrainz = mb({ recordingId: ARTIST })
  const entityId = seed(db, [item])('recording')
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async () =>
      json({ id: ARTIST, title: 'Song 1', length: 200250, 'artist-credit': [...credit(), {}] })
  )
  const { link, result } = await run(db, entityId, p)
  assert.equal(link.state, 'unresolved')
  assert.equal(result.incomplete, true)
  assert.ok(result.proposals[0].evidence.missing.includes('complete_remote_metadata'))
})

const platformAlbum = (id = '42'): PlatformAlbumIdentity => ({
  schemaVersion: 1, provider: 'ncm', id, title: 'Album', artists: [{ name: 'Artist', id: '7' }],
  complete: true, trackCount: 2,
  tracks: [1, 2].map(n => ({
    id: String(100 + n), title: `Song ${n}`, artists: [{ name: 'Artist', id: '7' }],
    durationSeconds: 200.25, disc: 1, position: n, isrcs: []
  }))
})
function platformAlbums(options: {
  ids?: string[]; total?: number | null; incomplete?: boolean; methods?: string[]
  edit?: (album: PlatformAlbumIdentity) => unknown
  load?: PlatformIdentificationOptions['albumIdentity']
} = {}) {
  const calls: string[] = [], ids = options.ids ?? ['42']
  const inventory = [{ id: 'ncm', enabled: true, configuration: '1',
    supportedMethods: options.methods ?? ['searchAlbums', 'fetchAlbumIdentity'] }]
  const p = new PlatformIdentificationProvider('ncm', {
    inventory: () => inventory,
    search: async (_provider, method, _query, limit, offset, signal) => {
      signal.throwIfAborted()
      assert.equal(method, 'searchAlbums'); assert.equal(limit, 10); assert.equal(offset, 0)
      calls.push('search')
      return { items: ids.map(id => ({ id, name: 'Album', artist: 'Artist' })),
        total: options.total === undefined ? ids.length : options.total, incomplete: options.incomplete }
    },
    albumIdentity: async (provider, id, signal) => {
      calls.push(id)
      assert.equal(provider, 'ncm')
      signal.throwIfAborted()
      if (options.load) return options.load(provider, id, signal)
      const album = platformAlbum(id)
      return options.edit ? options.edit(album) : album
    }
  })
  return { p, calls, inventory }
}

test('a unique complete local album confirms its platform scope and supported members, without a pressing ID', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entity = seed(db), entityId = entity('release'), { p, calls } = platformAlbums()
  const { link, result } = await run(db, entityId, p)
  assert.equal(link.state, 'confirmed')
  assert.deepEqual(link.confirmation, { mode: 'automatic', rule: 'platform_album_tracks' })
  assert.deepEqual(db.identificationDetail(entityId).references,
    [{ provider: 'ncm', kind: 'release', idType: 'native', value: '42' }])
  assert.equal(result.proposals[0].evidence.origin, 'album_tracks')
  assert.deepEqual(result.proposals[0].evidence.missing, [])
  assert.deepEqual(calls, ['search', '42'])
  assert.equal(db.identificationDetail(entity('album_project')).link, null)
  for (const kind of ['artist', 'recording'] as const) {
    assert.equal(db.identificationDetail(entity(kind)).link!.confirmation?.rule, 'album_member')
    assert.equal(db.identificationDetail(entity(kind)).references[0].provider, 'ncm')
  }
  assert.ok(db.identificationInput(entityId).sources!.every(s => s.provider === 'local'))
})

for (const variant of ['old_plugin', 'native_id', 'partial_local', 'unknown_local_totals'] as const) {
  test(`platform ${variant} preserves its original contract without an album lookup`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const tracks = variant === 'partial_local' ? [track(1)] : [track(1), track(2)]
    if (variant === 'unknown_local_totals') delete tracks[0].identityTags!.trackTotal
    let entityId: string
    if (variant === 'native_id') {
      let batch = db.catalogSync({ kind: 'begin', revision: 1 })
      batch = db.catalogSync({ kind: 'append', ...batch, tracks: tracks.map((t, i) => ({
        ...t, source: 'ncm', albumId: '42', id: `ncm:${i + 1}`, filePath: ''
      })) })
      db.catalogSync({ kind: 'commit', ...batch })
      entityId = db.catalogQuery({ kind: 'release', source: 'ncm' }).items[0].id
    } else entityId = seed(db, tracks)('release')
    const { p, calls } = platformAlbums({
      ...(variant === 'old_plugin' ? { methods: ['searchAlbums', 'fetchAlbumTracks'] } : {})
    })
    const { link } = await run(db, entityId, p)
    assert.deepEqual(calls, variant === 'native_id' ? [] : ['search'])
    assert.equal(link.state, variant === 'native_id' ? 'confirmed' : 'unresolved')
    if (variant === 'native_id') assert.equal(link.confirmation?.rule, 'provider_native')
  })
}

const invalidPlatformAlbums: Record<string, (a: PlatformAlbumIdentity) => unknown> = {
  schema: a => ({ ...a, schemaVersion: 2 }),
  provider: a => ({ ...a, provider: 'other' }),
  id: a => ({ ...a, id: 'other' }),
  extra_payload: a => ({ ...a, filePath: 'private/path' }),
  missing_count: a => ({ ...a, trackCount: null }),
  wrong_count: a => ({ ...a, trackCount: 3 }),
  partial: a => ({ ...a, complete: false }),
  missing_track: a => ({ ...a, tracks: a.tracks.slice(0, 1) }),
  missing_disc: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, disc: null })) }),
  missing_position: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, position: null })) }),
  missing_duration: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, durationSeconds: null })) }),
  no_artists: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, artists: [] })) }),
  nameless_credit: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, artists: [...t.artists, { name: '' }] })) }),
  no_album_artists: a => ({ ...a, artists: [] }),
  duplicate_track: a => ({ ...a, tracks: [a.tracks[0], { ...a.tracks[1], id: a.tracks[0].id }] }),
  duplicate_position: a => ({ ...a, tracks: [a.tracks[0], { ...a.tracks[1], position: 1 }] }),
  position_gap: a => ({ ...a, tracks: [a.tracks[0], { ...a.tracks[1], position: 3 }] }),
  title_version: a => ({ ...a, tracks: [{ ...a.tracks[0], title: 'Song 1 (Live)' }, a.tracks[1]] }),
  album_version: a => ({ ...a, title: 'Album (Deluxe)' }),
  guest_artist: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, artists: [...t.artists, { name: 'Guest' }] })) }),
  duration_precision: a => ({ ...a, tracks: a.tracks.map(t => ({ ...t, durationSeconds: 202.251 })) })
}
for (const [variant, edit] of Object.entries(invalidPlatformAlbums)) {
  test(`platform album ${variant} cannot automatically confirm a local album`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const entityId = seed(db)('release'), { p } = platformAlbums({ edit })
    const { link, result } = await run(db, entityId, p)
    assert.equal(link.state, 'unresolved')
    assert.ok(!result.proposals[0].evidence.verification)
    assert.ok(result.incomplete || result.proposals[0].evidence.conflicts.length)
  })
}

for (const variant of ['isrc_missing', 'isrc_conflict', 'album_artist_conflict'] as const) {
  test(`known local ${variant} remains a platform comparison constraint`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const tracks = [track(1), track(2)]
    if (variant === 'album_artist_conflict') tracks[0].identityTags!.albumArtists = { value: ['Other'], origin: 'audio_tag' }
    else tracks[0].identityTags!.isrcs = ['USXXX0000001']
    const entityId = seed(db, tracks)('release'), { p } = platformAlbums({ edit: a => {
      if (variant === 'isrc_conflict') a.tracks[0].isrcs = ['USXXX0000002']
      return a
    } })
    assert.equal((await run(db, entityId, p)).link.state, 'unresolved')
  })
}

test('platform albums compare every disc and retain the exact two-second tolerance', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const tracks = [track(1), track(2)]
  tracks.forEach((track, i) => Object.assign(track.identityTags!, {
    discNumber: { value: i + 1, origin: 'audio_tag' }, trackNumber: { value: 1, origin: 'audio_tag' },
    trackTotal: { value: 1, origin: 'audio_tag' }, discTotal: { value: 2, origin: 'audio_tag' }
  }))
  const entityId = seed(db, tracks)('release'), { p } = platformAlbums({ edit: a => ({ ...a,
    tracks: a.tracks.map((t, i) => ({ ...t, disc: i + 1, position: 1, durationSeconds: 202.25 })) }) })
  assert.equal((await run(db, entityId, p)).link.state, 'confirmed')
})

test('a platform compilation keeps album artists separate from each actual track performer', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const tracks = [track(1), track(2)]
  tracks.forEach((track, i) => {
    track.artist = `Artist ${i + 1}`; track.albumArtist = 'Various Artists'
    track.identityTags!.artists = { value: [track.artist], origin: 'audio_tag' }
    track.identityTags!.albumArtists = { value: ['Various Artists'], origin: 'audio_tag' }
  })
  const entityId = seed(db, tracks)('release'), { p } = platformAlbums({ edit: a => ({ ...a,
    artists: [{ name: 'Various Artists' }],
    tracks: a.tracks.map((t, i) => ({ ...t, artists: [{ name: `Artist ${i + 1}` }] })) }) })
  const { link, result } = await run(db, entityId, p)
  assert.equal(link.state, 'confirmed')
  assert.deepEqual(result.proposals[0].evidence.conflicts, [])
})

test('platform confirmation and its evidence roll back together and input changes reject a late proof', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entityId = seed(db)('release'), { p } = platformAlbums()
  db.identificationEnqueue({ entityId, batchId: 'atomic', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] }, 1000)
  const work = db.metadataClaim(1000)!, result = await p.recall(work.identification!, new AbortController().signal)
  db.sql.exec("CREATE TRIGGER fail_platform_confirm BEFORE INSERT ON metadata_identity_history WHEN new.state='confirmed' BEGIN SELECT RAISE(ABORT,'platform rollback'); END;")
  assert.throws(() => db.metadataFinish(work, { state: 'identified', ...result }, 1001), /platform rollback/)
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
  assert.equal(db.identificationDetail(entityId).link, null)
  db.sql.exec('DROP TRIGGER fail_platform_confirm')
  db.sql.prepare("UPDATE catalog_entities SET title='Album (Live)' WHERE id=?").run(entityId)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1002), false)
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
})

for (const variant of ['ambiguous', 'missing_other', 'unique', 'duplicates', 'budget', 'unknown_total', 'truncated_page', 'adapter_incomplete'] as const) {
  test(`platform search ${variant} respects the full candidate set and lookup bound`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const entityId = seed(db)('release'), { p, calls } = platformAlbums({
      ids: variant === 'budget' ? ['42', '43', '44', '45', '46'] : variant === 'duplicates' ? ['42', '42'] : ['42', '43'],
      ...(variant === 'unknown_total' ? { total: null } : {}),
      ...(variant === 'truncated_page' ? { total: 20 } : {}),
      ...(variant === 'adapter_incomplete' ? { incomplete: true } : {}),
      edit: a => {
        if (variant === 'missing_other' && a.id === '43') a.tracks[0].durationSeconds = null
        if (variant === 'unique' && a.id === '43') a.tracks[0].title += ' (Live)'
        return a
      }
    })
    const { link, result } = await run(db, entityId, p)
    assert.equal(link.state, variant === 'unique' ? 'confirmed' : 'unresolved')
    assert.ok(calls.length <= 5)
    if (variant === 'ambiguous') assert.ok(result.proposals.every(p => p.evidence.missing.includes('unique_platform_album')))
    if (variant === 'budget') { assert.equal(calls.length, 5); assert.equal(result.incomplete, true) }
  })
}

for (const manual of ['reject', 'detach', 'confirm_other'] as const) {
  test(`platform full-album proof preserves manual ${manual} through reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'platform-album-')), path = join(root, 'library.sqlite')
    let db = new LibraryDatabase(path)
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
    const entityId = seed(db)('release'), { p } = platformAlbums()
    const result = await p.recall(db.identificationInput(entityId), new AbortController().signal)
    const proposal = structuredClone(result.proposals[0])
    if (manual === 'confirm_other') { proposal.references[0].value = 'other'; delete proposal.evidence.verification }
    const [c] = db.identificationPublish(db.identificationInput(entityId), [proposal], 500)
    db.identificationDecide({ candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision,
      decision: manual === 'reject' ? 'reject' : 'confirm' }, 501)
    if (manual === 'detach') {
      const link = db.identificationDetail(entityId).link!
      db.identificationDetach(link.id, link.revision, 502)
    }
    const before = db.identificationDetail(entityId)
    db.close(); db = new LibraryDatabase(path)
    await run(db, entityId, p)
    assert.deepEqual(db.identificationDetail(entityId), before)
  })
}

test('database rechecks platform album proof instead of trusting labels or a valid wire shape', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entityId = seed(db)('release'), { p } = platformAlbums()
  const result = await p.recall(db.identificationInput(entityId), new AbortController().signal)
  const proof = result.proposals[0].evidence.verification!
  assert.equal(proof.method, 'platform_album_tracks')
  if (proof.method !== 'platform_album_tracks') throw new Error('missing proof')
  proof.album.tracks[0].title += ' (Live)'
  const fake: IdentificationProvider = { id: p.id, matcherVersion: p.matcherVersion, supports: () => true,
    blockedReason: () => null, context: () => '1', recall: async () => result }
  assert.equal((await run(db, entityId, fake)).link.state, 'unresolved')
})

test('cancelling an active platform album lookup stops recall before publication', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entityId = seed(db)('release'), controller = new AbortController()
  let lookupSignal: AbortSignal | undefined
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const { p, calls } = platformAlbums({ load: async (_provider, _id, signal) => {
    lookupSignal = signal
    assert.equal(signal.aborted, false)
    entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const pending = p.recall(db.identificationInput(entityId), controller.signal)
  await ready
  controller.abort(new Error('cancel platform album'))
  await assert.rejects(pending, /cancel platform album/)
  assert.equal(lookupSignal?.aborted, true)
  await assert.rejects(p.recall(db.identificationInput(entityId), controller.signal), /cancel platform album/)
  assert.deepEqual(calls, ['search', '42'])
  assert.equal(db.identificationCandidates({ entityId }).total, 0)
})

const memberIds = (db: LibraryDatabase, kind: 'artist' | 'recording') =>
  db.catalogQuery({ kind }).items
const membersOf = (db: LibraryDatabase, entityId: string) => db.metadataJobs({ entityId }).items[0].identification!.members!

test('full MB album confirmation derives source-scoped recordings and performers in the same transaction', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entity = seed(db), { p, calls } = provider(), entityId = entity('album_project')
  const { job } = await run(db, entityId, p)
  assert.equal(calls.length, 3) // no per-song/artist HTTP lookups
  assert.equal(job.identification!.members!.length, 4)
  for (const recording of memberIds(db, 'recording')) {
    const detail = db.identificationDetail(recording.id)
    assert.equal(detail.references[0].value, recording.title === 'Song 1' ? id(201) : id(202))
    assert.deepEqual(detail.link!.confirmation, { mode: 'automatic', rule: 'album_member' })
    const c = db.identificationCandidates({ entityId: recording.id }).items[0]
    assert.equal(c.evidence.origin, 'cross_reference')
    assert.equal(c.evidence.verification?.method, 'album_member')
  }
  const artists = memberIds(db, 'artist').map(a => db.identificationDetail(a.id))
  assert.equal(new Set(artists.map(a => a.link!.targetId)).size, 1)
  assert.ok(artists.every(a => a.references[0].value === ARTIST))
  assert.equal(db.identificationDetail(entity('release')).link, null)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM catalog_sources').get()!.n, 2)
})

for (const variant of ['agreed', 'recording_conflict', 'artist_conflict', 'missing_other_recording', 'old_receipt'] as const) {
  test(`multiple MB pressings ${variant} propagate only identities established across every match`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const entityId = seed(db)('album_project'), { p } = provider({ releases: [RELEASE, PRESSING], edit: (r, release) => {
      if (release === PRESSING) {
        if (variant === 'recording_conflict') r.media[0].tracks[0].recording.id = id(999)
        if (variant === 'missing_other_recording') delete (r.media[0].tracks[0].recording as { id?: string }).id
        if (variant === 'artist_conflict') r.media[0].tracks.forEach(t => { t['artist-credit'] = credit('Artist', id(999)) })
      }
      return r
    } })
    const recall = await p.recall(db.identificationInput(entityId), new AbortController().signal)
    if (variant === 'old_receipt') {
      const proof = recall.proposals[0].evidence.verification!
      if (proof.method !== 'album_tracks') throw new Error('expected album proof')
      delete proof.matchedReleases
    }
    const fake: IdentificationProvider = { id: p.id, matcherVersion: p.matcherVersion, supports: () => true,
      blockedReason: () => null, context: () => '1', recall: async () => recall }
    assert.equal((await run(db, entityId, fake)).link.state, 'confirmed')
    for (const child of [...memberIds(db, 'recording'), ...memberIds(db, 'artist')]) {
      const affected = variant === 'old_receipt' ||
        ((variant === 'recording_conflict' || variant === 'missing_other_recording') && child.title === 'Song 1') ||
        (variant === 'artist_conflict' && child.kind === 'artist')
      const detail = db.identificationDetail(child.id)
      assert.equal(detail.link?.state === 'confirmed', !affected)
      if (affected && variant !== 'old_receipt') {
        const candidates = db.identificationCandidates({ entityId: child.id }).items
        assert.equal(candidates.length, variant === 'missing_other_recording' ? 1 : 2)
        assert.ok(candidates.every(c => c.evidence.incomplete))
      }
    }
  })
}

test('a verified album never binds an unrelated source-scoped artist merely sharing the same name', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const extra = track(3, { album: 'Other', filePath: 'D:/music/other/3.flac' })
  extra.identityTags!.album!.value = 'Other'
  seed(db, [track(1), track(2), extra])
  const entityId = db.catalogQuery({ kind: 'album_project' }).items.find(a => a.title === 'Album')!.id
  const unaffected = db.sql.prepare(`SELECT a.artist_id id FROM catalog_source_artists a
    JOIN catalog_sources s ON s.id=a.source_id WHERE s.track_id='local-3'`).get()!.id as string
  await run(db, entityId, provider().p)
  assert.equal(db.identificationDetail(unaffected).link, null)
  assert.equal(memberIds(db, 'artist').filter(a => db.identificationDetail(a.id).link?.state === 'confirmed').length, 2)
})

for (const variant of ['structured', 'structured_tags', 'combined_only', 'homonyms'] as const) {
  test(`cooperative artist ${variant} uses full credits without splitting text or pairing tag ID arrays`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const names = variant === 'homonyms' ? ['Artist', 'Artist'] : ['Artist', 'Guest']
    const tracks = [track(1), track(2)]
    for (const item of tracks) {
      item.artist = names.join(' / ')
      item.albumArtist = 'Artist'
      item.identityTags!.albumArtist = { value: 'Artist', origin: 'audio_tag' }
      // A single combined tag is not the independent audio-tag name array.
      item.identityTags!.artists!.value = variant === 'combined_only' ? [names.join(' / ')] : names
      if (variant === 'structured' || variant === 'homonyms') item.artists = names.map(name => ({ name }))
      // These are set observations, not a parallel ordered name→ID mapping.
      item.identityTags!.musicbrainz = mb({ artistIds: [id(9), ARTIST] })
    }
    const entityId = seed(db, tracks)('album_project'), { p } = provider({ edit: r => {
      r.media[0].tracks.forEach(t => { t['artist-credit'] = names.map((name, i) => ({ name, artist: { name, id: i ? id(9) : ARTIST } })) })
      return r
    } })
    const { link } = await run(db, entityId, p)
    assert.equal(link.state, variant === 'combined_only' ? 'unresolved' : 'confirmed')
    assert.ok(memberIds(db, 'recording').every(r =>
      (db.identificationDetail(r.id).link?.state === 'confirmed') === (variant !== 'combined_only')))
    const independentNames = variant === 'structured' || variant === 'structured_tags'
    for (const artist of memberIds(db, 'artist')) {
      const detail = db.identificationDetail(artist.id)
      assert.equal(detail.link?.state === 'confirmed', independentNames)
      if (independentNames) assert.equal(detail.references[0].value, artist.title === 'Artist' ? ARTIST : id(9))
    }
  })
}

test('an existing local artist ID covering sources outside the album remains reviewable instead of becoming a native proof', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const tracks = [track(1), track(2), track(3, { album: 'Other', filePath: 'D:/music/other/3.flac' })]
  tracks[2].identityTags!.album!.value = 'Other'
  tracks.forEach(t => { t.artists = [{ id: 7, name: 'Artist' }] })
  seed(db, tracks)
  const entityId = db.catalogQuery({ kind: 'release' }).items.find(a => a.title === 'Album')!.id
  await run(db, entityId, platformAlbums().p)
  const artist = memberIds(db, 'artist')[0], c = db.identificationCandidates({ entityId: artist.id }).items[0]
  assert.equal(db.identificationDetail(artist.id).link!.state, 'unresolved')
  assert.ok(c.evidence.missing.includes('member_sources_outside_album'))
  assert.equal(membersOf(db, entityId).find(m => m.entityId === artist.id)!.state, 'needs_review')
})

for (const kind of ['artist', 'recording'] as const) for (const decision of ['reject', 'detach', 'confirm_other'] as const) {
  test(`album members preserve a ${kind} manual ${decision} made while the album request runs`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const entity = seed(db), entityId = entity('release'), childId = entity(kind), { p } = platformAlbums()
    db.identificationEnqueue({ entityId, batchId: 'members', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] }, 1000)
    const work = db.metadataClaim(1000)!, recall = await p.recall(work.identification!, new AbortController().signal)
    const child = db.identificationInput(childId)
    const [candidate] = db.identificationPublish(child, [{ provider: 'ncm', name: child.name, summary: '',
      references: [{ provider: 'ncm', kind, idType: 'native', value: decision === 'confirm_other' ? 'other' : kind === 'artist' ? '7' : child.name === 'Song 1' ? 'ncm:101' : 'ncm:102' }],
      matcherVersion: 'manual-test', evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'manual-test' }
    }], 1001)
    db.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision,
      decision: decision === 'reject' ? 'reject' : 'confirm' }, 1002)
    if (decision === 'detach') {
      const link = db.identificationDetail(childId).link!
      db.identificationDetach(link.id, link.revision, 1003)
    }
    const before = db.identificationDetail(childId)
    assert.equal(db.metadataFinish(work, { state: 'identified', ...recall }, 1004), true)
    assert.deepEqual(db.identificationDetail(childId), before)
    assert.equal(db.identificationDetail(entityId).link!.state, 'confirmed')
    assert.equal(membersOf(db, entityId).find(m => m.entityId === childId)!.state, 'skipped')
  })
}

test('a child name changed and restored during HTTP invalidates only that child snapshot', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entity = seed(db), entityId = entity('album_project'), childId = entity('artist'), { p } = provider()
  db.identificationEnqueue({ entityId, batchId: 'members', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] }, 1000)
  const work = db.metadataClaim(1000)!, recall = await p.recall(work.identification!, new AbortController().signal)
  db.sql.prepare("UPDATE catalog_entities SET title='Other' WHERE id=?").run(childId)
  db.sql.prepare("UPDATE catalog_entities SET title='Artist' WHERE id=?").run(childId)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...recall }, 1001), true)
  assert.equal(db.identificationDetail(entityId).link!.state, 'confirmed')
  assert.equal(db.identificationDetail(childId).link, null)
  assert.equal(membersOf(db, entityId).find(m => m.entityId === childId)!.reason, 'member_input_changed')
  assert.ok(membersOf(db, entityId).some(m => m.state === 'confirmed'))
})

for (const change of ['detach_parent', 'change_parent_input'] as const) {
  test(`pending child review cannot use a stale parent receipt after ${change}`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const entityId = seed(db)('album_project'), { p } = provider({ releases: [RELEASE, PRESSING], edit: (r, release) => {
      if (release === PRESSING) r.media[0].tracks[0].recording.id = id(999)
      return r
    } })
    await run(db, entityId, p)
    const childId = memberIds(db, 'recording').find(r => r.title === 'Song 1')!.id
    const c = db.identificationCandidates({ entityId: childId }).items[0]
    const review = { candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision }
    assert.equal(db.identificationPreview(review).canConfirm, true)
    if (change === 'detach_parent') {
      const link = db.identificationDetail(entityId).link!
      db.identificationDetach(link.id, link.revision, 1002)
    } else db.sql.prepare("UPDATE catalog_entities SET title='Different album' WHERE id=?").run(entityId)
    assert.equal(db.identificationPreview(review).stale, true)
    assert.throws(() => db.identificationDecide({ ...review, decision: 'confirm' }, 1003), /识别依据或关联已变化/)
  })
}

test('a failure on a derived member rolls back the parent, every child and the task acknowledgment', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entityId = seed(db)('release'), { p } = platformAlbums()
  db.identificationEnqueue({ entityId, batchId: 'members', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] }, 1000)
  const work = db.metadataClaim(1000)!, result = await p.recall(work.identification!, new AbortController().signal)
  db.sql.exec(`CREATE TRIGGER fail_member BEFORE INSERT ON metadata_identity_history
    WHEN json_extract(new.evidence,'$.decision.rule')='album_member'
    BEGIN SELECT RAISE(ABORT,'member failed'); END;`)
  assert.throws(() => db.metadataFinish(work, { state: 'identified', ...result }, 1001), /member failed/)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_identity_candidates').get()!.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_identity_history').get()!.n, 0)
  assert.equal(db.metadataJobs({ entityId }).items[0].state, 'running')
  db.sql.exec('DROP TRIGGER fail_member')
  assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1002), true)
  assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1003), false)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_identity_history').get()!.n, 5)
})

test('a provider cannot manufacture an automatic album-member decision', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entity = seed(db), entityId = entity('recording'), sourceIds = db.identificationInput(entityId).sources!.map(s => s.sourceId)
  const ref = { provider: 'ncm', kind: 'recording' as const, idType: 'native', value: '101' }
  const fake: IdentificationProvider = { id: 'platform.ncm', matcherVersion: 'fake', supports: () => true,
    blockedReason: () => null, context: () => '1', recall: async () => ({ incomplete: false, reasons: [], proposals: [{
      provider: 'ncm', name: 'Song', summary: '', matcherVersion: 'fake', references: [ref], evidence: {
        origin: 'cross_reference', matches: ['validated_album_member'], missing: [], conflicts: [], incomplete: false, provenance: 'fake',
        verification: { method: 'album_member', reference: ref, sourceIds, parent: {
          entityId: entity('release'), candidateId: 'fake', historySeq: 999, linkRevision: 1
        } }
      }
    }] }) }
  assert.equal((await run(db, entityId, fake)).link.state, 'unresolved')
})

test('missing platform performer IDs leave only performers unidentified, not the complete album or recordings', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entityId = seed(db)('release'), { p } = platformAlbums({ edit: album => {
    album.tracks.forEach(t => { t.artists = t.artists.map(a => ({ name: a.name })) })
    return album
  } })
  assert.equal((await run(db, entityId, p)).link.state, 'confirmed')
  assert.ok(memberIds(db, 'recording').every(r => db.identificationDetail(r.id).link!.state === 'confirmed'))
  for (const artist of memberIds(db, 'artist')) {
    assert.equal(db.identificationDetail(artist.id).link, null)
    assert.equal(membersOf(db, entityId).find(m => m.entityId === artist.id)!.reason, 'artist_identity')
  }
})

test('member target namespace conflicts remain reviewable without preventing other valid members', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entityId = seed(db)('release'), { p } = platformAlbums()
  db.sql.prepare("INSERT INTO metadata_entities VALUES('target','internal','artist','target','Artist')").run()
  for (const value of ['7', 'other']) db.sql.prepare("INSERT INTO metadata_identity_refs VALUES('ncm','artist','native',?,'target')").run(value)
  assert.equal((await run(db, entityId, p)).link.state, 'confirmed')
  for (const artist of memberIds(db, 'artist')) {
    const c = db.identificationCandidates({ entityId: artist.id }).items[0]
    assert.equal(db.identificationDetail(artist.id).link!.state, 'unresolved')
    assert.ok(db.identificationPreview({ candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision })
      .conflicts.includes('conflicting_ids_in_same_namespace'))
  }
  assert.ok(memberIds(db, 'recording').every(r => db.identificationDetail(r.id).link!.state === 'confirmed'))
})

test('derived platform recordings reuse the established native Track.id namespace and an already confirmed streaming target', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const entity = seed(db), parentId = entity('release'), localId = memberIds(db, 'recording').find(r => r.title === 'Song 1')!.id
  let batch = db.catalogSync({ kind: 'begin', revision: 1 })
  batch = db.catalogSync({ kind: 'append', ...batch, tracks: [track(1, {
    id: 'ncm:101', source: 'ncm', filePath: '', albumId: '42', artists: [{ id: 7, name: 'Artist' }]
  })] })
  db.catalogSync({ kind: 'commit', ...batch })
  const streamingId = db.catalogQuery({ kind: 'recording', source: 'ncm' }).items[0].id
  const native = new PlatformIdentificationProvider('ncm', {
    inventory: () => [{ id: 'ncm', enabled: true, configuration: '1', supportedMethods: ['searchSongs'] }],
    search: async () => assert.fail('native source requires no search')
  })
  await run(db, streamingId, native, 'native')
  const original = db.identificationDetail(streamingId)
  assert.equal(original.references[0].value, 'ncm:101')
  await run(db, parentId, platformAlbums().p, 'local-album')
  assert.equal(db.identificationDetail(localId).link!.targetId, original.link!.targetId)
  assert.deepEqual(db.identificationDetail(streamingId), original)
})

for (const length of [508, 512]) {
  test(`a ${length}-character platform service ID respects the established recording reference bound without blocking its album`, async t => {
    const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
    const entityId = seed(db)('release'), nativeId = 'x'.repeat(length), { p } = platformAlbums({ edit: album => {
      album.tracks[0].id = nativeId
      return album
    } })
    const { link } = await run(db, entityId, p)
    assert.equal(link.state, 'confirmed')
    const recording = memberIds(db, 'recording').find(r => r.title === 'Song 1')!
    const result = membersOf(db, entityId).find(m => m.entityId === recording.id)!
    if (length === 508) {
      assert.equal(result.state, 'confirmed')
      assert.equal(db.identificationDetail(recording.id).references[0].value, `ncm:${nativeId}`)
    } else {
      assert.equal(result.state, 'skipped')
      assert.equal(result.reason, 'member_reference_limit')
      assert.equal(db.identificationDetail(recording.id).link, null)
    }
    assert.ok(membersOf(db, entityId).filter(m => m.entityId !== recording.id).every(m => m.state === 'confirmed'))
  })
}

test('an album claim captures at most 200 child fences and reports the remaining scope explicitly', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const tracks = [1, 2, 3, 4].map(n => {
    const item = track(n), artists = Array.from({ length: 64 }, (_, i) => ({ name: `Performer ${n}-${i}` }))
    item.artist = artists.map(a => a.name).join(' / '); item.artists = artists; item.albumArtist = 'Artist'
    item.identityTags!.artists!.value = artists.map(a => a.name)
    item.identityTags!.trackTotal!.value = 4
    return item
  })
  const entityId = seed(db, tracks)('release'), { p } = platformAlbums({ edit: a => ({ ...a, trackCount: 4,
    tracks: tracks.map((t, i) => ({ id: String(101 + i), title: t.title,
      artists: t.artists!.map((a, j) => ({ name: a.name, id: `${i + 1}-${j}` })),
      disc: 1, position: i + 1, durationSeconds: 200.25, isrcs: [] })) }) })
  const { link, work, job } = await run(db, entityId, p)
  assert.equal(link.state, 'confirmed')
  assert.equal(work.identificationMembers!.items.length, 200)
  assert.equal(work.identificationMembers!.truncated, true)
  assert.equal(job.identification!.members!.length, 200)
  assert.equal(job.identification!.membersTruncated, true)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM metadata_identity_links WHERE state='confirmed'").get()!.n, 201)
})
