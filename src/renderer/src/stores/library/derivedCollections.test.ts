import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../../shared/track.ts'
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

test('artist collections use individual credits, count each song once and retain literal band names', () => {
  const solo = track('solo', { artist: 'Alice' })
  const duet = track('duet', { artist: 'Alice/Bob', artists: [{ name: 'Alice' }, { name: 'Bob' }, { name: ' Alice ' }] })
  const band = track('band', { artist: 'AC/DC' })
  const literal = track('literal', { artist: 'Earth, Wind & Fire', artists: [{ name: 'Earth, Wind & Fire' }] })
  const artists = buildDerivedCollections([solo, duet, band, literal], [], '').artists
  assert.equal(artists.length, 4)
  assert.deepEqual(artists.find(a => a.name === 'Alice')!.tracks.map(t => t.id), ['solo', 'duet'])
  assert.deepEqual(artists.find(a => a.name === 'Bob')!.tracks.map(t => t.id), ['duet'])
  assert.equal(artists.some(a => a.name === 'Alice/Bob'), false)
  assert.equal(artists.find(a => a.name === 'Alice')!.trackCount, 2)
  assert.ok(artists.some(a => a.name === 'AC/DC'))
  assert.ok(artists.some(a => a.name === literal.artist))
  assert.equal(duet.artist, 'Alice/Bob')
})
