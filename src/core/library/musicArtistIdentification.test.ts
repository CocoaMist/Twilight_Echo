import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type {
  IdentificationInput,
  IdentificationArtistRecording
} from '../../shared/musicIdentification.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'
import type { TrackData } from '../../shared/track.ts'
import { MusicBrainzIdentificationProvider } from './musicIdentificationProvider.ts'
import { MusicBrainzWikiProvider, MusicBrainzDetailsProvider } from './entityMetadataProvider.ts'
import { PublicArtworkProvider } from './publicArtworkProvider.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { verifyArtistRecordings } from '../../shared/musicArtistRecordingVerification.ts'

const ARTIST = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const RECORDING = '00000000-0000-4000-8000-000000000003'
const policy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: true,
  contact: 'https://example.org/player',
  commonsImages: true,
  caaUsage: null
}
const json = (value: unknown) => new Response(JSON.stringify(value))
function source(id = 'one', title = 'Song') {
  return {
    sourceId: id,
    provider: 'local',
    trackId: id,
    title,
    artist: 'Artist',
    album: 'Album',
    albumArtist: '',
    artists: [{ name: 'Artist' }],
    artistIndexes: [0],
    duration: 200.25,
    tags: {
      version: 1 as const,
      scope: 'audio_file' as const,
      title: { value: title, origin: 'audio_tag' as const },
      artist: { value: 'Artist', origin: 'audio_tag' as const },
      album: { value: 'Album', origin: 'audio_tag' as const },
      durationSeconds: { value: 200.25, origin: 'audio_tag' as const }
    }
  }
}
const input = (): IdentificationInput => ({
  entityId: 'artist',
  kind: 'artist',
  name: 'Artist',
  artist: '',
  version: '1',
  linkRevision: 0,
  sources: [source()]
})
const recording = (artist = ARTIST, title = 'Song'): IdentificationArtistRecording => ({
  id: RECORDING,
  title,
  duration: 200.25,
  artists: [{ id: artist, name: 'Artist' }],
  albums: ['Album']
})
const row = (r = recording()) => ({
  id: r.id,
  title: r.title,
  length: r.duration * 1000,
  'artist-credit': r.artists.map((a) => ({ name: a.name, artist: a })),
  releases: r.albums.map((title) => ({ title }))
})
const proof = (recordings = [recording()]) => ({
  method: 'artist_recordings' as const,
  reference: { provider: 'musicbrainz', kind: 'artist' as const, idType: 'mbid', value: ARTIST },
  sourceIds: ['one'],
  samples: [{ sourceId: 'one', recordings }],
  toleranceSeconds: 2 as const
})

test('one raw song corroborates an artist only with exact album, title, duration and all credits', () => {
  assert.equal(verifyArtistRecordings(input(), proof()), true)
  for (const changed of [
    { title: 'Other song' },
    { duration: 203 },
    { albums: ['Other album'] },
    { artists: [{ id: ARTIST, name: 'Other name' }] },
    {
      artists: [
        { id: ARTIST, name: 'Artist' },
        { id: OTHER, name: 'Guest' }
      ]
    }
  ])
    assert.equal(verifyArtistRecordings(input(), proof([{ ...recording(), ...changed }])), false)
  assert.equal(
    verifyArtistRecordings(input(), proof([recording(), { ...recording(OTHER), id: OTHER }])),
    false
  )
})

test('two distinct songs can corroborate an artist without album tags, but duplicate files cannot', () => {
  const local = input()
  local.sources!.push(source('two', 'Another song'))
  local.sources!.forEach((s) => delete s.tags.album)
  const p = proof()
  p.sourceIds.push('two')
  p.samples.push({
    sourceId: 'two',
    recordings: [{ ...recording(ARTIST, 'Another song'), id: OTHER }]
  })
  assert.equal(verifyArtistRecordings(local, p), true)
  p.samples[1].recordings[0].artists[0].id = OTHER
  assert.equal(verifyArtistRecordings(local, p), false)
  local.sources![1].tags.title!.value = 'Song'
  assert.equal(verifyArtistRecordings(local, p), false)
})

test('legacy, filename, truncated, unaligned or wrong-source observations cannot become automatic proof', () => {
  for (const origin of ['legacy', 'filename'] as const) {
    const local = input()
    local.sources![0].tags.title!.origin = origin
    assert.equal(verifyArtistRecordings(local, proof()), false)
  }
  for (const change of [
    (i: IdentificationInput) => {
      i.sourcesTruncated = true
    },
    (i: IdentificationInput) => {
      i.sources![0].artistIndexes = [1]
    },
    (i: IdentificationInput) => {
      i.sources![0].tags.truncated = true
    },
    (i: IdentificationInput) => {
      i.sources![0].tags.artist!.value = 'Other'
    },
    (i: IdentificationInput) => {
      i.sources![0].sourceId = 'replacement'
    },
    (i: IdentificationInput) => {
      i.sources![0].tags.musicbrainz = { artistIds: [], albumArtistIds: [], recordingId: OTHER }
    }
  ]) {
    const local = input()
    change(local)
    assert.equal(verifyArtistRecordings(local, proof()), false)
  }
})

test('artist recall corroborates the right same-name artist and preserves the other as a candidate', async () => {
  const calls: URL[] = []
  const provider = new MusicBrainzIdentificationProvider(
    () => policy,
    async (input) => {
      const url = new URL(String(input))
      calls.push(url)
      return json(
        url.pathname.endsWith('/artist')
          ? {
              count: 2,
              artists: [ARTIST, OTHER].map((id) => ({ id, name: 'Artist', type: 'Person' }))
            }
          : { count: 1, recordings: [row()] }
      )
    }
  )
  const result = await provider.recall(input(), new AbortController().signal)
  assert.equal(calls.length, 2)
  assert.equal(result.incomplete, false)
  assert.equal(result.proposals[0].evidence.verification?.method, 'artist_recordings')
  assert.equal(result.proposals[1].evidence.verification, undefined)
  assert.match(calls[1].searchParams.get('query')!, /recording:"Song" AND artist:"Artist"/)
})

test('truncated recording results and singleton name-only matches remain reviewable instead of auto-adopted', async () => {
  for (const truncated of [false, true]) {
    let calls = 0
    const provider = new MusicBrainzIdentificationProvider(
      () => policy,
      async (url) => {
        calls++
        return json(
          new URL(String(url)).pathname.endsWith('/artist')
            ? { count: 1, artists: [{ id: ARTIST, name: 'Artist', type: 'Person' }] }
            : { count: 11, recordings: [row()] }
        )
      }
    )
    const local = input()
    if (!truncated) local.sources![0].tags = { version: 1, scope: 'audio_file' }
    const result = await provider.recall(local, new AbortController().signal)
    assert.equal(result.proposals[0].evidence.verification, undefined)
    assert.equal(calls, truncated ? 2 : 1)
    assert.equal(result.incomplete, truncated)
  }
})

function database(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const s = source()
  const track: TrackData = {
    id: s.trackId,
    source: 'local',
    filePath: 'D:/Music/one.flac',
    fileName: 'one.flac',
    size: 0,
    cover: null,
    lyrics: null,
    title: s.title,
    artist: s.artist,
    album: s.album,
    duration: s.duration,
    identityTags: s.tags
  }
  db.replaceDocument({ version: 2, revision: 1, tracks: [track], folders: [], exclusions: [] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return { db, entityId: db.catalogQuery({ kind: 'artist' }).items[0].id }
}

test('the database rejects forged recording proof even if the adapter labels it verified', (t) => {
  const { db, entityId } = database(t)
  const provider = new MusicBrainzIdentificationProvider(() => policy)
  db.identificationEnqueue(
    {
      entityId,
      batchId: 'test',
      providers: [{ id: 'musicbrainz', matcherVersion: provider.matcherVersion }]
    },
    1000
  )
  const work = db.metadataClaim(1000)!
  const p = proof([{ ...recording(), duration: 999 }])
  p.sourceIds[0] = work.identification!.sources![0].sourceId
  p.samples[0].sourceId = p.sourceIds[0]
  db.metadataFinish(
    work,
    {
      state: 'identified',
      incomplete: false,
      reasons: [],
      proposals: [
        {
          provider: 'musicbrainz',
          name: 'Artist',
          summary: '',
          matcherVersion: provider.matcherVersion,
          references: [p.reference],
          evidence: {
            origin: 'cross_reference',
            matches: ['name'],
            missing: [],
            conflicts: [],
            incomplete: false,
            provenance: 'fixture',
            verification: p
          }
        }
      ]
    },
    1001
  )
  assert.equal(db.identificationDetail(entityId).link?.state, 'unresolved')
  assert.equal(db.metadataJobs({ jobId: work.job.id }).items[0].state, 'needs_review')
})

test('new local import automatically gets artist identity, name, introduction and licensed avatar without manual review', async (t) => {
  const { db, entityId } = database(t)
  const fetcher: typeof fetch = async (raw) => {
    const url = new URL(String(raw))
    let value: unknown
    if (url.pathname === '/ws/2/artist')
      value = { count: 1, artists: [{ id: ARTIST, name: 'Artist', type: 'Person' }] }
    else if (url.pathname === '/ws/2/recording')
      value = url.searchParams.has('query')
        ? { count: 1, recordings: [row()] }
        : { count: 0, recordings: [] }
    else if (url.pathname === `/ws/2/artist/${ARTIST}`)
      value = {
        id: ARTIST,
        name: 'Artist',
        type: 'Person',
        relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q1' } }]
      }
    else if (url.hostname === 'www.wikidata.org')
      value = {
        entities: {
          Q1: {
            id: 'Q1',
            lastrevid: 3,
            claims: {
              P434: [{ mainsnak: { datavalue: { value: ARTIST } } }],
              P18: [{ mainsnak: { datavalue: { value: 'Artist.jpg' } } }]
            },
            sitelinks: { zhwiki: { title: 'Artist' } }
          }
        }
      }
    else if (url.hostname === 'zh.wikipedia.org')
      value = {
        query: {
          pages: [
            {
              pageid: 4,
              title: 'Artist',
              pageprops: { wikibase_item: 'Q1' },
              extract: '歌手中文简介',
              revisions: [{ revid: 9 }]
            }
          ]
        }
      }
    else if (url.hostname === 'commons.wikimedia.org')
      value = {
        query: {
          pages: [
            {
              ns: 6,
              title: 'File:Artist.jpg',
              imageinfo: [
                {
                  thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
                  timestamp: '2026-01-01',
                  extmetadata: {
                    Artist: { value: 'Photographer' },
                    LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
                  }
                }
              ]
            }
          ]
        }
      }
    else
      value = {
        count: 0,
        [url.pathname.endsWith('/release-group') ? 'release-groups' : 'releases']: []
      }
    return json(value)
  }
  const databaseApi = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        Promise.resolve(Reflect.apply(Reflect.get(db, key), db, args))
  })
  const failures: unknown[] = []
  const wiki = new MusicBrainzWikiProvider(
    () => policy,
    fetcher,
    () => 2000
  )
  const service = new CoreEntityMetadataService({
    database: databaseApi,
    provider: wiki,
    policy: () => policy,
    identificationProviders: () => [new MusicBrainzIdentificationProvider(() => policy, fetcher)],
    enrichmentProviders: () => [
      new MusicBrainzDetailsProvider(() => policy, wiki),
      new PublicArtworkProvider(() => policy, fetcher)
    ],
    automation: () => ({
      newImports: true,
      history: false,
      sources: ['musicbrainz'],
      language: 'zh-Hans'
    }),
    artwork: async () => 'cached-avatar',
    now: () => 2000,
    changed() {},
    failed: (error) => failures.push(error)
  })
  service.activate()
  try {
    for (let i = 0; i < 200; i++) {
      const detail = await service.detail(entityId, 'zh-Hans')
      if (detail.introduction && detail.artwork?.length) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const detail = await service.detail(entityId, 'zh-Hans')
    assert.equal(db.identificationDetail(entityId).link?.confirmation?.rule, 'artist_recordings')
    assert.equal(detail.name, 'Artist')
    assert.equal(detail.introduction?.value, '歌手中文简介')
    assert.equal(detail.artwork?.[0].handle, 'cached-avatar')
    assert.deepEqual(failures, [])
  } finally {
    await service.shutdown()
  }
})
