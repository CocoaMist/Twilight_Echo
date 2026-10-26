import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../shared/track.ts'
import { createLogicalTrackModel } from '../../../shared/logicalTrackModel.ts'
import { getTrackSource } from '../../../shared/trackSourceIdentity.ts'

const { buildLogicalTracks, canShareTrackIdentity } = createLogicalTrackModel(() => undefined)

function track(overrides: Partial<Track> & Pick<Track, 'id' | 'title' | 'artist'>): Track {
  return {
    album: 'Album',
    filePath: overrides.id,
    fileName: `${overrides.title || 'Unknown'}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    ...overrides
  }
}

test('canShareTrackIdentity keeps two provider songs with one title apart', () => {
  const base = { title: 'Moon River', artist: 'Audrey', source: 'ncm' as const }

  // Same title and artist, same length, two different NetEase song ids: two
  // different recordings, so they must not collapse into one favorite.
  assert.equal(
    canShareTrackIdentity(
      track({ id: 'ncm:123', ncmSongId: 123, ...base }),
      track({ id: 'ncm:456', ncmSongId: 456, ...base })
    ),
    false
  )
  assert.equal(
    canShareTrackIdentity(track({ id: 'ncm:123', ...base }), track({ id: 'ncm:456', ...base })),
    false
  )
  // One remote id seen twice is one song.
  assert.equal(
    canShareTrackIdentity(
      track({ id: 'ncm:123', ncmSongId: 123, ...base }),
      track({ id: 'ncm:123', ncmSongId: 123, ...base, album: 'Other tag' })
    ),
    true
  )
  // A local file carries no remote id, so it can still stand in for the
  // streaming entry of the same song.
  assert.equal(
    canShareTrackIdentity(
      track({ id: 'ncm:123', ncmSongId: 123, ...base }),
      track({
        id: 'local:moon',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'local',
        duration: 181
      })
    ),
    true
  )
  // Different providers stay comparable by duration rather than by id.
  assert.equal(
    canShareTrackIdentity(
      track({ id: 'ncm:123', ncmSongId: 123, ...base }),
      track({ id: 'qq:abc', title: 'Moon River', artist: 'Audrey', source: 'qq', duration: 180 })
    ),
    true
  )
  assert.equal(
    canShareTrackIdentity(
      track({ id: 'ncm:123', ncmSongId: 123, ...base }),
      track({ id: 'qq:abc', title: 'Moon River', artist: 'Audrey', source: 'qq', duration: 420 })
    ),
    false
  )
})

test('buildLogicalTracks groups source variants and prefers local lossless tracks', () => {
  const logicalTracks = buildLogicalTracks([
    {
      track: track({
        id: 'ncm:moon',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'ncm',
        format: 'aac'
      }),
      source: 'ncm',
      sourceName: 'NetEase',
      providerAvailable: true,
      providerReliability: 1
    },
    {
      track: track({
        id: 'local:moon',
        title: ' moon river ',
        artist: 'AUDREY',
        source: 'local',
        duration: 181,
        format: 'flac',
        bitDepth: 24
      }),
      source: 'local',
      sourceName: '本地音乐',
      providerAvailable: true,
      providerReliability: 0.3
    }
  ])

  assert.equal(logicalTracks.length, 1)
  assert.equal(logicalTracks[0].id, 'logic:moon river::audrey')
  assert.equal(logicalTracks[0].preferredTrack.id, 'local:moon')
  assert.deepEqual(
    logicalTracks[0].variants.map((variant) => variant.track.id),
    ['local:moon', 'ncm:moon']
  )
})

test('buildLogicalTracks keeps different performances separate by duration', () => {
  const logicalTracks = buildLogicalTracks([
    {
      track: track({
        id: 'ncm:studio',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'ncm',
        duration: 180
      }),
      source: 'ncm',
      sourceName: 'NetEase',
      providerAvailable: true
    },
    {
      track: track({
        id: 'bili:live',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'bili',
        duration: 260
      }),
      source: 'bili',
      sourceName: 'Bilibili',
      providerAvailable: true
    }
  ])

  assert.equal(logicalTracks.length, 2)
  assert.deepEqual(
    logicalTracks.map((item) => item.preferredTrack.id),
    ['ncm:studio', 'bili:live']
  )
})

test('buildLogicalTracks prefers healthier provider variants when local is absent', () => {
  const logicalTracks = buildLogicalTracks([
    {
      track: track({
        id: 'unstable:moon',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'unstable'
      }),
      source: 'unstable',
      sourceName: 'Unstable',
      providerAvailable: true,
      providerReliability: 0.2
    },
    {
      track: track({
        id: 'healthy:moon',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'healthy'
      }),
      source: 'healthy',
      sourceName: 'Healthy',
      providerAvailable: true,
      providerReliability: 1
    }
  ])

  assert.equal(logicalTracks[0].preferredTrack.id, 'healthy:moon')
  assert.deepEqual(
    logicalTracks[0].variants.map((variant) => variant.track.id),
    ['healthy:moon', 'unstable:moon']
  )
})

test('buildLogicalTracks does not merge incomplete logical identities', () => {
  const logicalTracks = buildLogicalTracks([
    {
      track: track({
        id: 'ncm:unknown-artist',
        title: 'Moon River',
        artist: '',
        source: 'ncm'
      }),
      source: 'ncm',
      sourceName: 'NetEase',
      providerAvailable: true
    },
    {
      track: track({
        id: 'bili:unknown-artist',
        title: 'Moon River',
        artist: '',
        source: 'bili'
      }),
      source: 'bili',
      sourceName: 'Bilibili',
      providerAvailable: true
    }
  ])

  assert.equal(logicalTracks.length, 2)
  assert.deepEqual(
    logicalTracks.map((item) => item.id),
    ['ncm:unknown-artist', 'bili:unknown-artist']
  )
})

test('getTrackSource normalizes explicit source and provider-prefixed ids', () => {
  assert.equal(getTrackSource({ id: 'ignored:1', source: ' NCM ' }), 'ncm')
  assert.equal(getTrackSource({ id: ' BILI:BV1 ', source: undefined }), 'bili')
  assert.equal(getTrackSource({ id: 'D:\\Music\\Track.flac', source: undefined }), 'local')
})

test('buildLogicalTracks groups large unique result sets without quadratic scans', () => {
  const inputs = Array.from({ length: 8000 }, (_, index) => ({
    track: track({
      id: `provider:${index}`,
      title: `Track ${index}`,
      artist: `Artist ${index}`,
      source: 'provider'
    }),
    source: 'provider',
    sourceName: 'Provider',
    providerAvailable: true
  }))

  const start = performance.now()
  const logicalTracks = buildLogicalTracks(inputs)
  const elapsed = performance.now() - start

  assert.equal(logicalTracks.length, inputs.length)
  assert.ok(elapsed < 250, `buildLogicalTracks took ${elapsed.toFixed(2)}ms, expected < 250ms`)
})
