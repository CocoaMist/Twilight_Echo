/**
 * Performance regression baseline for local music library.
 *
 * Uses Node's built-in test runner (`node --experimental-strip-types --test`).
 * Only pure-logic assertions are tested here; store ownership and component
 * behavior now live in Core integration tests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// Dynamic import of the pure-logic search module (no Vue/window dependencies).
const { filterLocalGridItems } = (await import(
  new URL('../utils/localLibrarySearch.ts', import.meta.url).href
)) as typeof import('../utils/localLibrarySearch')

// Mock data generators are exported for reuse by performance fixtures.
export interface MockTrack {
  id: string
  title: string
  artist: string
  album: string
  filePath: string
  fileName: string
  dir: string
  duration: number
  size: number
  cover: string | null
  lyrics: string | null
  source: string
  format: string
  sampleRate: number
  bitrate: number
  bpmAnalysis?: {
    bpm: number
    confidence: number
    source: 'analyzed'
    analyzedAt: string
    algorithmVersion: number
  }
}

/** Generate `count` mock tracks spread across artists, albums, and folders. */
export function generateMockTracks(count: number): MockTrack[] {
  const tracks: MockTrack[] = []
  const artistCount = Math.max(50, Math.floor(count / 100))
  const albumCount = Math.max(100, Math.floor(count / 50))
  const folderCount = Math.max(20, Math.floor(count / 250))
  for (let i = 0; i < count; i++) {
    const ext = ['.mp3', '.flac', '.wav', '.m4a'][i % 4]
    const folder = `C:\\music\\folder${i % folderCount}`
    const fileName = `song${i}${ext}`
    tracks.push({
      id: `track_${i}`,
      title: `Song Title ${i}`,
      artist: `Artist ${i % artistCount}`,
      album: `Album ${i % albumCount}`,
      filePath: `${folder}\\${fileName}`,
      fileName,
      dir: folder,
      duration: 120 + (i % 300),
      size: 3_000_000 + i * 1000,
      cover: i % 3 === 0 ? `cover://hash${i}.jpg` : null,
      lyrics: null,
      source: 'local',
      format: ext.slice(1),
      sampleRate: 44100,
      bitrate: 320
    })
  }
  return tracks
}

/** Generate artist-like grid items containing slices of mock tracks. */
export function generateMockGridItems(trackCount: number): {
  name: string
  trackCount: number
  tracks: MockTrack[]
  cover: string | null
  artist: string
  path: string
}[] {
  const tracks = generateMockTracks(trackCount)
  const byArtist = new Map<string, MockTrack[]>()
  for (const track of tracks) {
    if (!byArtist.has(track.artist)) byArtist.set(track.artist, [])
    byArtist.get(track.artist)!.push(track)
  }
  return Array.from(byArtist.entries()).map(([name, items]) => ({
    name,
    trackCount: items.length,
    tracks: items,
    cover: items[0]?.cover ?? null,
    artist: name,
    path: items[0]?.dir ?? ''
  }))
}

test('mock track generator produces exactly the requested count', () => {
  const tracks = generateMockTracks(5000)
  assert.equal(tracks.length, 5000)
  assert.ok(new Set(tracks.map((track) => track.artist)).size >= 50)
  assert.ok(new Set(tracks.map((track) => track.album)).size >= 100)
  assert.ok(new Set(tracks.map((track) => track.dir)).size >= 20)
})

test('filterLocalGridItems returns the complete matching grid for a 5000-track library', (t) => {
  const items = generateMockGridItems(5000)
  const start = performance.now()
  const result = filterLocalGridItems(items, 'song 42')
  t.diagnostic(`5000-track cold search: ${(performance.now() - start).toFixed(2)}ms`)
  const expected = items.filter((item) =>
    item.tracks.some((track) => /^track_42\d*$/.test(track.id))
  )
  assert.deepEqual(result, expected)
})

test('filterLocalGridItems with empty query returns all items', () => {
  const items = generateMockGridItems(200)
  assert.equal(filterLocalGridItems(items, '').length, items.length)
})

test('filterLocalGridItems with non-matching query returns empty', () => {
  assert.equal(filterLocalGridItems(generateMockGridItems(200), 'zzz_nonexistent_zzz').length, 0)
})

test('searchQuery preprocessing is idempotent for trim and lowercase', () => {
  const items = generateMockGridItems(500)
  const query = '  Song TITLE 42  '
  assert.deepEqual(
    filterLocalGridItems(items, query),
    filterLocalGridItems(items, query.trim().toLowerCase())
  )
})
