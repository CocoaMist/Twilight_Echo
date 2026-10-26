import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import type { TrackData } from '../../shared/track.ts'

test('private playback source pages retain exact source identity and membership, never reuse stale local snapshots', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const track: TrackData = {
    id: 'one',
    source: 'local',
    title: 'One',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:/music/one.flac',
    fileName: 'one.flac',
    size: 1,
    duration: 10,
    cover: null,
    lyrics: null,
    addedAt: Date.parse('2026-10-01T00:00:00Z')
  }
  const seed = (tracks: TrackData[]) => {
    db.replaceDocument({ version: 2, revision: 1, tracks, folders: ['D:/music'], exclusions: [] })
    while (db.catalogStatus().localPending) db.catalogAdvance()
  }
  seed([track])
  const recording = db.catalogQuery({ kind: 'recording' }).items[0]
  const id = db.catalogSources({ entityId: recording.id }).items[0].id
  const revision = db.catalogStatus().revision
  const page = db.catalogPlaybackSources({ sourceId: id, revision })
  assert.equal(page.items[0].sourceKey, versionSourceKey(track))
  assert.equal(page.items[0].inLibrary, true)
  assert.ok(page.items[0].addedAt! > track.addedAt!)
  assert.equal(page.items[0].track?.filePath, track.filePath)
  assert.deepEqual(
    db.catalogPlaybackSources({ sourceKeys: [versionSourceKey(track)], revision }),
    page
  )
  seed([])
  assert.throws(() => db.catalogPlaybackSources({ sourceId: id, revision }), {
    code: 'STALE_REVISION'
  })
  const removed = db.catalogPlaybackSources({ sourceId: id, revision: db.catalogStatus().revision })
    .items[0]
  assert.equal(removed.inLibrary, false)
  assert.equal(removed.track, null)
})

test('private playback query bounds keys and rejects ambiguous lookups', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const revision = db.catalogStatus().revision
  for (const invalid of [
    {},
    { sourceId: 'id', sourceKeys: ['key'] },
    { sourceKeys: Array(201).fill('key') },
    { sourceId: 'id', limit: 201 },
    { sourceId: 'id', offset: -1 }
  ])
    assert.throws(() => db.catalogPlaybackSources({ ...invalid, revision }))
  assert.deepEqual(db.catalogPlaybackSources({ sourceKeys: [], revision }).items, [])
})
