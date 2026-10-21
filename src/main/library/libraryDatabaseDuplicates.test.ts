import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { toDuplicateCandidate } from './duplicateDetection.ts'

function fixture(t: test.TestContext, count = 3) {
  const db = new LibraryDatabase(':memory:')
  const tracks = Array.from({ length: count }, (_, i) => ({
    id: `id:${i}`,
    filePath: `D:/Music/${i}.flac`,
    title: `Song ${i}`,
    artist: 'Singer',
    album: 'Album',
    duration: 180,
    size: i + 1,
    sampleRate: 44100,
    bitrate: 960,
    format: 'flac'
  }))
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  return { db, tracks }
}

test('duplicate projection preserves all existing evidence fields without returning full Track data', (t) => {
  const { db, tracks } = fixture(t)
  const extended = {
    ...tracks[0],
    subTrack: '2',
    cueRange: { startSeconds: 30, endSeconds: 60, pregapSeconds: 0 },
    contentHash: 'A'.repeat(64),
    audioFingerprint: {
      algorithm: 'chromaprint-v1',
      value: 'verified',
      evidence: 'verifiedAcoustic'
    },
    cover: `data:image/png;base64,${'a'.repeat(1024 * 1024)}`,
    lyrics: 'x'.repeat(1024 * 1024),
    analysis: { large: 'x'.repeat(1024 * 1024) },
    custom: { keep: true }
  }
  const legacy = {
    ...tracks[1],
    title: '  Exact title  ',
    artist: ' Artist ',
    duration: '181',
    size: '42',
    sampleRate: '48000'
  }
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: [extended, legacy],
    folders: [],
    exclusions: []
  })
  const page = db.readDuplicateCandidates()
  assert.deepEqual(page.items, [extended, legacy].map(toDuplicateCandidate))
  assert.equal(page.revision, db.getMetadata().revision)
  assert.equal(page.nextCursor, null)
  assert.ok(JSON.stringify(page).length < 1024)
  assert.equal(db.getTracksByIds([extended.id]).tracks[0].lyrics, extended.lyrics)
})

test('seek pagination covers the complete library with row gaps, exact-page boundaries and no duplicate IDs', (t) => {
  const { db, tracks } = fixture(t, 1002)
  tracks.splice(1, 2)
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  let cursor = 0,
    revision: number | undefined
  const ids: string[] = [],
    lengths: number[] = []
  for (;;) {
    const page = db.readDuplicateCandidates(cursor, 200, revision)
    revision = page.revision
    ids.push(...page.items.map((item) => item.id))
    lengths.push(page.items.length)
    if (page.nextCursor === null) break
    assert.ok(page.nextCursor > cursor)
    cursor = page.nextCursor
  }
  assert.deepEqual(lengths, [200, 200, 200, 200, 200, 0])
  assert.deepEqual(
    ids,
    tracks.map((track) => track.id)
  )
  assert.equal(new Set(ids).size, 1000)
  for (const [after, limit] of [
    [-1, 200],
    [0.5, 200],
    [0, 1001],
    [0, 0],
    [0, Infinity]
  ])
    assert.throws(() => db.readDuplicateCandidates(after, limit), /Invalid library page/)
})

test('metadata changes reject a mixed-version projection, while listening ticks do not invalidate the read snapshot', (t) => {
  const { db } = fixture(t)
  const first = db.readDuplicateCandidates(0, 1)
  db.syncListeningHistory({ kind: 'begin', id: 'history', mode: 'replace' })
  db.syncListeningHistory({
    kind: 'append',
    id: 'history',
    sequence: 1,
    entries: [{ id: 'id:2', lastPlayed: 100 }]
  })
  db.syncListeningHistory({ kind: 'commit', id: 'history', sequence: 2 })
  const second = db.readDuplicateCandidates(first.nextCursor!, 1, first.revision)
  assert.equal(second.items[0].id, 'id:1')
  db.patchTracks([{ id: 'id:2', expectedVersion: 1, patch: { title: 'Edited' } }])
  assert.throws(
    () => db.readDuplicateCandidates(second.nextCursor!, 1, first.revision),
    /读取期间发生变化/
  )
  assert.equal(db.readDuplicateCandidates().items.at(-1)!.title, 'Edited')
})
