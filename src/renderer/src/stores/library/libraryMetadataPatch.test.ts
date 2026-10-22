import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { patchLibraryMetadata } from './libraryMetadataPatch.ts'
import type { Track } from '../../types/music'

const source: Track = {
  id: 'local:a',
  filePath: 'D:/Music/a.flac',
  title: 'Moon',
  artist: 'Audrey',
  album: '',
  duration: 180,
  cover: null,
  lyrics: null,
  fileName: 'a.flac',
  size: 1,
  source: 'local'
}
const update = { source, track: { ...source, album: 'Online Album', lyrics: 'Provider lyrics' } }

test('enrichment patches current versions, preserves unrelated extensions and never exports a library', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ ...source, custom: 'before' }]
  })
  db.patchTracks([{ id: source.id, expectedVersion: 1, patch: { custom: 'after' } }])
  const api = {
    getTracksByIds: async (ids: string[]) => db.getTracksByIds(ids),
    patchTracks: async (patches: Parameters<typeof db.patchTracks>[0]) => db.patchTracks(patches)
  }
  const saved = await patchLibraryMetadata(api, update, () => true)
  assert.equal(saved!.versions[source.id], 3)
  assert.equal(saved!.tracks[0].custom, 'after')
  assert.equal(saved!.tracks[0].album, 'Online Album')
  assert.equal(saved!.tracks[0].lyrics, 'Provider lyrics')
})

test('changed search identity, edited target fields, removal and cancellation reject stale provider results', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const api = {
    getTracksByIds: async (ids: string[]) => db.getTracksByIds(ids),
    patchTracks: async () => {
      throw new Error('must not write')
    }
  }
  for (const patch of [
    { title: 'New title' },
    { album: 'Manual album' },
    { lyrics: 'Local lyrics' },
    { cueRange: { startSeconds: 10, endSeconds: 180 } }
  ]) {
    db.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: [{ ...source, ...patch }]
    })
    assert.equal(await patchLibraryMetadata(api, update, () => true), null)
  }
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [] })
  assert.equal(await patchLibraryMetadata(api, update, () => true), null)
  let current = true
  const cancelled = {
    ...api,
    getTracksByIds: async (ids: string[]) => {
      current = false
      return db.getTracksByIds(ids)
    }
  }
  assert.equal(await patchLibraryMetadata(cancelled, update, () => current), null)
})

test('a concurrent edit after the authority read is rejected without replaying the patch', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [source] })
  let writes = 0
  const api = {
    getTracksByIds: async (ids: string[]) => db.getTracksByIds(ids),
    patchTracks: async (patches: Parameters<typeof db.patchTracks>[0]) => {
      writes++
      db.patchTracks([{ id: source.id, expectedVersion: 1, patch: { lyrics: 'New edit' } }])
      return db.patchTracks(patches)
    }
  }
  await assert.rejects(
    patchLibraryMetadata(api, update, () => true),
    /changed concurrently/
  )
  assert.equal(writes, 1)
  assert.equal(db.getTracksByIds([source.id]).tracks[0].lyrics, 'New edit')
})
