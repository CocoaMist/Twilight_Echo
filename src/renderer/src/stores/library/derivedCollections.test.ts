import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../../types/music'
import { buildDerivedCollections } from './derivedCollections.ts'
import { isReleaseDateOnlyUpdate, toPlaylistTrackSnapshot } from './musicStoreData.ts'

const track = (id: string, fields: Partial<Track> = {}): Track => ({
  id,
  title: id,
  artist: 'Singer',
  album: 'Release',
  filePath: `C:\\Music\\Release\\${id}.flac`,
  dir: 'C:\\Music\\Release',
  fileName: `${id}.flac`,
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  ...fields
})

test('album projections preserve release identity, dates and durable cover source', () => {
  const tracks = [
    track('2', { trackNumber: 2, releaseDate: '2020', artist: 'Guest' }),
    track('1', {
      trackNumber: 1,
      releaseDate: '2020-05-12',
      cover: 'twilight-media://expired',
      coverSource: 'https://example.com/art.jpg'
    })
  ]
  const [album] = buildDerivedCollections(tracks, [], '').albums
  assert.equal(album.artist, '群星')
  assert.equal(album.releaseDate, '2020-05-12')
  assert.equal(album.coverSource, tracks[1].coverSource)
  assert.deepEqual(
    album.tracks.map((t) => t.id),
    ['1', '2']
  )
  assert.equal(
    album.id,
    buildDerivedCollections(
      tracks.map((t) => ({ ...t, releaseDate: '2021' })),
      [],
      ''
    ).albums[0].id
  )
  assert.equal(toPlaylistTrackSnapshot(tracks[1]).releaseDate, '2020-05-12')
})

test('album singers use actual owner tags and meaningful local artist names', () => {
  const artist = (tracks: Track[]): string | undefined =>
    buildDerivedCollections(tracks, [], '').albums[0].artist
  assert.equal(
    artist([
      track('1', { albumArtist: 'Owner' }),
      track('2', { albumArtist: 'Owner', artist: 'Guest' })
    ]),
    'Owner'
  )
  assert.equal(
    artist([
      track('1', { albumArtist: 'Singer' }),
      track('2', { albumArtist: 'Guest', artist: 'Guest' })
    ]),
    '群星'
  )
  assert.equal(
    artist([track('1', { artist: 'Unknown Artist' }), track('2', { artist: '' })]),
    '未知歌手'
  )
  assert.equal(artist([track('1'), track('2')]), 'Singer')
})

test('date-only updates do not request online enrichment, including JSON round trips', () => {
  const previous = track('1', {
    releaseDate: '2020',
    metadataMatch: { providerId: 'ncm', trackId: 'x' } as Track['metadataMatch']
  })
  const updated = JSON.parse(JSON.stringify({ ...previous, releaseDate: '2020-05-12' })) as Track
  assert.equal(isReleaseDateOnlyUpdate(previous, updated), true)
  assert.equal(isReleaseDateOnlyUpdate(previous, { ...updated, title: 'New title' }), false)
  assert.equal(isReleaseDateOnlyUpdate(undefined, updated), false)
})

test('collection projections retain mixed-label order, empty fallbacks and same-name ties', () => {
  const names = ['月亮', '晨光', 'Alice', 'alice', 'é', 'e\u0301', '2', '10', '', '同名', '同名']
  const tracks = names.map((name, index) => {
    const directory = `C:\\Music\\${names.length - index}\\${name || 'Empty'}`
    return track(`track-${index}`, {
      artist: name,
      album: name,
      albumId: `release-${names.length - index}`,
      genre: name,
      filePath: `${directory}\\song.flac`,
      dir: directory
    })
  })
  const before = [...tracks]
  const collections = buildDerivedCollections(tracks, [], '')
  assert.deepEqual(
    collections.artists.map((artist) => artist.name),
    [...new Set(names.map((name) => name || '未知艺术家'))].sort((a, b) => a.localeCompare(b, 'zh'))
  )
  assert.deepEqual(
    collections.genres.map((genre) => genre.name),
    [...new Set(names.map((name) => name || '未知流派'))].sort((a, b) => a.localeCompare(b, 'zh'))
  )
  const albums = tracks
    .map((item) => ({ id: `id:${item.albumId}`, name: item.album || '未知专辑' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id))
  assert.deepEqual(
    collections.albums.map(({ id, name }) => ({ id, name })),
    albums
  )
  const folders = tracks
    .map((item) => ({
      name: item.dir!.split('\\').pop()!.toLowerCase(),
      path: item.dir
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.path!.localeCompare(b.path!))
  assert.deepEqual(
    collections.folders.map(({ name, path }) => ({ name, path })),
    folders
  )
  assert.deepEqual(tracks, before)
})
