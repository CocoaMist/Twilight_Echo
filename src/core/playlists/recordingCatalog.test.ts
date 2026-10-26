import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { LibraryQuery } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { CoreRecordingCatalog } from './recordingCatalog.ts'

const song = (i: number): TrackData => ({
  id: `local:${i}`, source: 'local', title: `Song ${i}`, artist: 'Singer', album: 'Album',
  filePath: `D:/Private/${i}.flac`, fileName: `${i}.flac`, duration: 180, size: 1,
  cover: null, lyrics: null
})

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [],
    tracks: Array.from({ length: 405 }, (_, i) => song(i)) })
  const provider = (i: number) => ({ ...song(i), id: `ncm:${i}`, source: 'ncm',
    albumId: 'remote-album', filePath: `ncm:${i}`, streamUrl: 'https://private.invalid/?token=secret' })
  let revision = 2, playlistsRevision = 3
  const tracks = [song(1), provider(1), provider(2), provider(2)]
  const queries: LibraryQuery[] = []
  const catalog = new CoreRecordingCatalog({
    database: {
      getMetadata: async () => db.getMetadata(),
      queryTracks: async (query) => { queries.push(query!); return db.queryTracks(query) },
      queryCollections: async (...args) => db.queryCollections(...args)
    },
    versions: { getRevision: () => revision },
    playlists: { getRevision: () => playlistsRevision, sourceTracks: () => tracks }
  })
  t.after(() => db.close())
  return { db, catalog, queries, tracks,
    changeVersions: () => revision++, changePlaylists: () => playlistsRevision++ }
}

test('recording source pages keep complete Core identities while returning only bounded display rows', async (t) => {
  const f = fixture(t)
  const first = await f.catalog.page({ limit: 200 })
  assert.equal(first.total, 407)
  assert.equal(first.items.length, 200)
  const last = await f.catalog.page({ offset: 400, limit: 200, revision: first.revision,
    playlistsRevision: first.playlistsRevision, contentRevision: first.contentRevision })
  assert.equal(last.items.length, 7)
  assert.equal(last.items[5].key, versionSourceKey(f.tracks[1]))
  assert.ok(f.queries.every((query) => query.limit! <= 200))
  assert.doesNotMatch(JSON.stringify(last.items.map((item) => item.track)), /filePath|fileName|streamUrl|token=secret/)
  const located = await f.catalog.page({ trackId: 'local:401' })
  assert.equal(located.total, 1)
  assert.equal(located.items[0].key, versionSourceKey(song(401)))
  assert.equal((await f.catalog.page({ search: 'Song 404' })).total, 1)
})

test('album location returns the complete release count for both local and provider sources', async (t) => {
  const f = fixture(t)
  const local = await f.catalog.page({ scope: 'albums', trackId: 'local:401' })
  assert.equal(local.total, 1)
  assert.equal(local.items[0].trackCount, 405)
  const provider = await f.catalog.page({ scope: 'albums', trackId: 'ncm:2' })
  assert.equal(provider.total, 1)
  assert.equal(provider.items[0].trackCount, 2, 'playlist copies do not multiply source count')
  const all = await f.catalog.page({ scope: 'albums' })
  assert.equal(all.total, 2)
  assert.deepEqual((await f.catalog.page({ scope: 'albums', key: provider.items[0].key })).items, provider.items)
})

test('catalog rejects every stale owner revision and cancellation instead of merging pages', async (t) => {
  const f = fixture(t)
  const page = await f.catalog.page({})
  const stale = { code: 'STALE_REVISION' }
  f.changeVersions()
  await assert.rejects(f.catalog.page({ revision: page.revision }), stale)
  f.changePlaylists()
  await assert.rejects(f.catalog.page({ playlistsRevision: page.playlistsRevision }), stale)
  f.db.patchTracks([{ id: 'local:1', expectedVersion: 1, patch: { title: 'Changed' } }])
  await assert.rejects(f.catalog.page({ contentRevision: page.contentRevision }), stale)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.catalog.page({}, abort.signal), { name: 'AbortError' })
})
