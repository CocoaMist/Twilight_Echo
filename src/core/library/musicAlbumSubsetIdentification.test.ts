import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'
import type { TrackData } from '../../shared/track.ts'
import { MusicBrainzIdentificationProvider } from './musicIdentificationProvider.ts'
import { MusicBrainzDetailsProvider, MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'

const PROJECT = '00000000-0000-4000-8000-000000000001'
const RELEASE = '00000000-0000-4000-8000-000000000002'
const ARTIST = '00000000-0000-4000-8000-000000000003'
const RECORDING = '00000000-0000-4000-8000-000000000004'
const credit = [{ name: 'Artist', artist: { id: ARTIST, name: 'Artist' } }]
const policy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: true,
  contact: 'https://example.org/player'
}
const track = (): TrackData => ({
  id: 'song',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  filePath: 'D:/music/song.flac',
  fileName: 'song.flac',
  source: 'local',
  duration: 200,
  size: 0,
  lyrics: null,
  cover: null,
  identityTags: {
    version: 1,
    scope: 'audio_file',
    title: { value: 'Song', origin: 'audio_tag' },
    artists: { value: ['Artist'], origin: 'audio_tag' },
    album: { value: 'Album', origin: 'audio_tag' },
    durationSeconds: { value: 200, origin: 'audio_tag' }
  }
})
const release = () => ({
  id: RELEASE,
  title: 'Album',
  'artist-credit': credit,
  'release-group': { id: PROJECT },
  media: [
    {
      position: 1,
      'track-count': 2,
      tracks: [0, 1].map((i) => ({
        position: i + 1,
        title: i ? 'Another song' : 'Song',
        length: 200000,
        'artist-credit': credit,
        recording: { id: RECORDING }
      }))
    }
  ]
})

function fixture(t: test.TestContext, local = track()) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 1, tracks: [local], folders: [], exclusions: [] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entityId = db.catalogQuery({ kind: 'album_project' }).items[0].id
  return { db, entityId }
}
function fetcher(options: { projects?: number; duration?: number } = {}) {
  const calls: URL[] = []
  const fetch: typeof globalThis.fetch = async (raw) => {
    const url = new URL(String(raw))
    calls.push(url)
    let data: unknown
    if (url.pathname === '/ws/2/release-group')
      data = {
        count: options.projects ?? 1,
        'release-groups': Array.from({ length: Math.min(2, options.projects ?? 1) }, (_, i) => ({
          id: i ? RECORDING : PROJECT,
          title: 'Album',
          'primary-type': 'Album',
          'artist-credit': credit
        }))
      }
    else if (url.pathname === '/ws/2/release')
      data = { 'release-count': 300, releases: [{ id: RELEASE }] }
    else if (url.pathname === `/ws/2/release/${RELEASE}`) {
      const r = release()
      r.media[0].tracks[0].length = (options.duration ?? 200) * 1000
      data = r
    } else if (url.pathname === `/ws/2/release-group/${PROJECT}`)
      data = {
        id: PROJECT,
        title: 'Album',
        relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q1' } }]
      }
    else if (url.hostname === 'www.wikidata.org')
      data = {
        entities: {
          Q1: {
            id: 'Q1',
            lastrevid: 2,
            claims: { P436: [{ mainsnak: { datavalue: { value: PROJECT } } }] },
            sitelinks: { zhwiki: { title: 'Album' } }
          }
        }
      }
    else if (url.hostname === 'zh.wikipedia.org')
      data = {
        query: {
          pages: [
            {
              pageid: 3,
              title: 'Album',
              pageprops: { wikibase_item: 'Q1' },
              extract: '专辑中文简介',
              revisions: [{ revid: 4 }]
            }
          ]
        }
      }
    else
      data = {
        count: 0,
        [url.pathname.endsWith('/artist')
          ? 'artists'
          : url.pathname.endsWith('/recording')
            ? 'recordings'
            : 'releases']: []
      }
    return new Response(JSON.stringify(data))
  }
  return { fetch, calls }
}
async function identify(db: LibraryDatabase, entityId: string, options = {}) {
  const remote = fetcher(options)
  const provider = new MusicBrainzIdentificationProvider(() => policy, remote.fetch)
  db.identificationEnqueue(
    {
      entityId,
      batchId: 'import',
      providers: [{ id: provider.id, matcherVersion: provider.matcherVersion }]
    },
    1000
  )
  const work = db.metadataClaim(1000)!
  const result = await provider.recall(work.identification!, new AbortController().signal)
  db.metadataFinish(work, { state: 'identified', ...result }, 1001)
  return { ...remote, work, result }
}

test('a single imported song proves an unambiguous album project without claiming a pressing or complete album', async (t) => {
  const { db, entityId } = fixture(t)
  const { result, calls } = await identify(db, entityId)
  assert.equal(result.proposals[0].evidence.verification?.method, 'album_subset')
  assert.equal(db.identificationDetail(entityId).link?.confirmation?.rule, 'album_subset')
  assert.equal(calls.length, 3, 'one positive witness suffices even with hundreds of pressings')
  for (const kind of ['release', 'artist', 'recording'] as const)
    assert.notEqual(
      db.identificationDetail(db.catalogQuery({ kind }).items[0].id).link?.state,
      'confirmed'
    )
})

test('ambiguous/truncated project recall cannot become partial-album automatic evidence', async (t) => {
  for (const projects of [2, 11]) {
    const { db, entityId } = fixture(t)
    const { calls, result } = await identify(db, entityId, { projects })
    assert.equal(db.identificationDetail(entityId).link?.state, 'unresolved')
    assert.equal(calls.length, 1)
    assert.ok(result.proposals.every((p) => !p.evidence.verification))
  }
})

test('wrong durations and legacy-only tags leave album identity unconfirmed', async (t) => {
  const local = track()
  local.identityTags!.title!.origin = 'legacy'
  const legacy = fixture(t, local)
  const result = await identify(legacy.db, legacy.entityId)
  assert.equal(result.calls.length, 1)
  assert.notEqual(legacy.db.identificationDetail(legacy.entityId).link?.state, 'confirmed')
  const wrong = fixture(t)
  await identify(wrong.db, wrong.entityId, { duration: 210 })
  assert.notEqual(wrong.db.identificationDetail(wrong.entityId).link?.state, 'confirmed')
})

test('the database rechecks partial-album evidence instead of trusting match labels', async (t) => {
  const { db, entityId } = fixture(t)
  const remote = fetcher()
  const p = new MusicBrainzIdentificationProvider(() => policy, remote.fetch)
  db.identificationEnqueue(
    { entityId, batchId: 'test', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] },
    1000
  )
  const work = db.metadataClaim(1000)!
  const result = await p.recall(work.identification!, new AbortController().signal)
  const proof = result.proposals[0].evidence.verification
  assert.ok(proof?.method === 'album_subset')
  proof.release.tracks[0].duration = 999
  db.metadataFinish(work, { state: 'identified', ...result }, 1001)
  assert.equal(db.identificationDetail(entityId).link?.state, 'unresolved')
})

test('known local identity and pressing tags constrain the partial-project witness too', async (t) => {
  for (const field of [
    'releaseId',
    'releaseTrackId',
    'albumArtistIds',
    'barcode',
    'catalogNumbers',
    'isrcs'
  ] as const) {
    const local = track(),
      tags = local.identityTags!
    tags.musicbrainz = { artistIds: [], albumArtistIds: [] }
    if (field === 'releaseId' || field === 'releaseTrackId') tags.musicbrainz[field] = ARTIST
    else if (field === 'albumArtistIds') tags.musicbrainz.albumArtistIds = [RECORDING]
    else if (field === 'barcode') tags.barcode = '12345678'
    else if (field === 'catalogNumbers') tags.catalogNumbers = ['CAT-1']
    else tags.isrcs = ['USXXX0000001']
    const { db, entityId } = fixture(t, local)
    await identify(db, entityId)
    assert.notEqual(db.identificationDetail(entityId).link?.state, 'confirmed', field)
  }
})

test('new partial imports automatically retrieve and persist album-project introductions through Core', async (t) => {
  const { db, entityId } = fixture(t),
    remote = fetcher()
  const api = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        Promise.resolve(Reflect.apply(Reflect.get(db, key), db, args))
  })
  const wiki = new MusicBrainzWikiProvider(() => policy, remote.fetch)
  const failures: unknown[] = []
  const service = new CoreEntityMetadataService({
    database: api,
    provider: wiki,
    policy: () => policy,
    identificationProviders: () => [
      new MusicBrainzIdentificationProvider(() => policy, remote.fetch)
    ],
    enrichmentProviders: () => [new MusicBrainzDetailsProvider(() => policy, wiki)],
    automation: () => ({
      newImports: true,
      history: false,
      sources: ['musicbrainz'],
      language: 'zh-Hans'
    }),
    now: () => 2000,
    changed() {},
    failed: (error) => failures.push(error)
  })
  service.activate()
  try {
    for (let i = 0; i < 200; i++) {
      if ((await service.detail(entityId, 'zh-Hans')).introduction) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const detail = await service.detail(entityId, 'zh-Hans')
    assert.equal(detail.introduction?.value, '专辑中文简介')
    assert.equal(detail.introduction?.attribution?.provider, 'wikipedia')
    assert.equal(db.identificationDetail(entityId).link?.confirmation?.rule, 'album_subset')
    assert.deepEqual(failures, [])
  } finally {
    await service.shutdown()
  }
})
