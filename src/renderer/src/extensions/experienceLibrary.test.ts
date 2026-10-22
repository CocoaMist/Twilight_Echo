import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import type {
  LibraryCollectionKind,
  LibraryDatabaseApi,
  LibraryQuery
} from '../../../shared/libraryDatabase.ts'
import {
  createExperienceLibraryReader,
  readExperiencePlaylistTrackDtos
} from './experienceLibrary.ts'

test('extension library reader pages SQLite summaries and album members with stable ids', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: ['D:/Music'],
    exclusions: [],
    tracks: [
      {
        id: 'track:1',
        filePath: 'D:/Music/Release/02.flac',
        fileName: '02.flac',
        title: 'Second Song',
        artist: 'Artist',
        album: 'Release',
        albumId: 'release-1',
        albumArtist: 'Artist',
        trackNumber: 2,
        genre: 'Rock',
        duration: 180,
        size: 1,
        cover: null,
        lyrics: null
      },
      {
        id: 'track:0',
        filePath: 'D:/Music/Release/01.flac',
        fileName: '01.flac',
        title: 'First Song',
        artist: 'Artist',
        album: 'Release',
        albumId: 'release-1',
        albumArtist: 'Artist',
        trackNumber: 1,
        genre: 'Rock',
        duration: 200,
        size: 1,
        cover: 'cover://release',
        coverSource: 'https://example.test/release.jpg',
        lyrics: null
      },
      {
        id: 'track:other',
        filePath: 'D:/Music/Other/01.flac',
        fileName: '01.flac',
        title: 'Quiet Song',
        artist: 'Another Artist',
        album: 'Other Album',
        albumId: 'release-2',
        albumArtist: 'Another Artist',
        trackNumber: 1,
        genre: 'Jazz',
        duration: 210,
        size: 1,
        cover: null,
        lyrics: null
      }
    ]
  })
  const trackCalls: LibraryQuery[] = []
  const collectionCalls: Array<{ kind: LibraryCollectionKind; query: LibraryQuery }> = []
  const api: Pick<
    LibraryDatabaseApi,
    'queryTracks' | 'queryCollections' | 'lookupPlaylistTracks' | 'getTracksByIds' | 'getMetadata'
  > = {
    queryTracks: async (query = {}) => {
      trackCalls.push(query)
      return db.queryTracks(query)
    },
    queryCollections: async (kind, query = {}) => {
      collectionCalls.push({ kind, query })
      return db.queryCollections(kind, query)
    },
    lookupPlaylistTracks: async (request, revision) => db.lookupPlaylistTracks(request, revision),
    getTracksByIds: async (ids, revision) => db.getTracksByIds(ids, revision),
    getMetadata: async () => db.getMetadata()
  }
  const reader = createExperienceLibraryReader(api)

  const first = await reader.albumPage(0, 1)
  assert.equal(first.total, 2)
  assert.equal(first.albums.length, 1)
  assert.equal(first.albums[0].name, 'Other Album')
  assert.equal(first.albums[0].genre, 'Jazz')
  assert.equal('tracks' in first.albums[0], false)
  assert.match(first.albums[0].extensionId, /^album-[a-f0-9]{64}$/)
  assert.equal(reader.databaseId(first.albums[0].extensionId), first.albums[0].id)

  const second = await reader.albumPage(1, 1, first.revision)
  assert.equal(second.albums[0].name, 'Release')
  const detail = await reader.detailedAlbum(second.albums[0].extensionId, second.revision)
  assert.ok(detail)
  assert.deepEqual(
    detail.album.tracks?.map((track) => [track.id, track.trackNumber]),
    [
      ['track:0', 1],
      ['track:1', 2]
    ]
  )
  assert.ok(
    trackCalls.some((query) => query.limit === 1000 && query.contentRevision === second.revision)
  )

  const results = await reader.search('release')
  assert.deepEqual(
    results.tracks.map((track) => track.id),
    ['track:1', 'track:0']
  )
  assert.ok(results.albums.some((album) => album.name === 'Release'))
  assert.equal(reader.trackAlbumId('track:0'), second.albums[0].extensionId)

  const playlist = await readExperiencePlaylistTrackDtos(
    { trackIds: ['track:other', 'track:0', 'deleted'] },
    api,
    reader,
    results.revision,
    () => ({ revision: 0, versions: [] }),
    (track) => ({ id: track.id, albumId: reader.trackAlbumId(track.id) })
  )
  assert.deepEqual(playlist, [
    { id: 'track:other', albumId: first.albums[0].extensionId },
    { id: 'track:0', albumId: second.albums[0].extensionId }
  ])

  const genres = await reader.allGenres(first.revision)
  assert.deepEqual(genres, ['Jazz', 'Rock'])
  assert.ok(collectionCalls.every(({ query }) => query.limit !== undefined))
})
