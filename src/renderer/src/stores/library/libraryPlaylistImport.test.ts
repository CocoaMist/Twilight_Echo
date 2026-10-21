import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import { resolveLibraryPlaylistImportPaths } from './libraryPlaylistImport.ts'
import { createPlaylistController } from './playlistController.ts'
import type { Playlist, PlaylistPersistenceNotice } from './musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../playlistPersistence.ts'

function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      ...Array.from({ length: 2500 }, (_, i) => ({
        id: `track:${i}`,
        filePath: `D:/Music/${i}.flac`,
        title: `Song ${i}`,
        lyrics: 'large lyrics',
        translatedLyrics: 'translation',
        romanizedLyrics: 'romaji',
        bpmAnalysis: { tempoMap: [{ bpm: 120 }] },
        metadataMatch: { original: 'analysis' }
      })),
      {
        id: 'cue:1',
        filePath: 'D:/Music/cue.flac',
        subTrack: 1,
        cueRange: { startSeconds: 0, endSeconds: 30 }
      },
      {
        id: 'cue:2',
        filePath: 'D:/Music/cue.flac',
        subTrack: 2,
        cueRange: { startSeconds: 30, endSeconds: 60 }
      }
    ]
  })
  let active = 0,
    maximumActive = 0,
    maximumRecords = 0
  const requests: string[][] = []
  const api: Pick<LibraryDatabaseApi, 'lookupTracksByPaths' | 'getTracksByIds' | 'getMetadata'> = {
    lookupTracksByPaths: async (paths, revision) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      try {
        requests.push(paths)
        return db.lookupTracksByPaths(paths, revision)
      } finally {
        active--
      }
    },
    getTracksByIds: async (ids, revision) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      try {
        const page = db.getTracksByIds(ids, revision)
        maximumRecords = Math.max(maximumRecords, page.tracks.length)
        return page
      } finally {
        active--
      }
    },
    getMetadata: async () => db.getMetadata()
  }
  return {
    db,
    api,
    requests,
    get maximumActive() {
      return maximumActive
    },
    get maximumRecords() {
      return maximumRecords
    }
  }
}

test('authoritative import keeps requested order, duplicates, deep IDs and CUE while bounding full records to 200', async (t) => {
  const f = fixture(t)
  const paths = [
    ...Array.from({ length: 405 }, (_, i) => `D:/Music/${i}.flac`),
    '2499.flac',
    'D:/Music/0.flac',
    'D:/Music/cue.flac',
    'cue.flac',
    'missing.flac'
  ]
  const matched = await resolveLibraryPlaylistImportPaths(paths, f.api)
  assert.deepEqual(
    matched.map((track) => track?.id ?? null),
    [
      ...Array.from({ length: 405 }, (_, i) => `track:${i}`),
      'track:2499',
      'track:0',
      'cue:2',
      null,
      null
    ]
  )
  assert.deepEqual(
    f.requests.map((paths) => paths.length),
    [200, 200, 10]
  )
  assert.equal(f.maximumActive, 1)
  assert.equal(f.maximumRecords, 200)
  assert.deepEqual(matched[407]?.cueRange, { startSeconds: 30, endSeconds: 60 })
  for (const track of matched.filter((track) => track !== null)) {
    assert.equal(track.lyrics, null)
    for (const heavy of ['translatedLyrics', 'romanizedLyrics', 'bpmAnalysis', 'metadataMatch'])
      assert.equal(heavy in track, false)
  }
})

for (const phase of ['lookup', 'later-batch', 'final-check'] as const)
  test(`import fails rather than mixing revisions when content changes at ${phase}`, async (t) => {
    const f = fixture(t),
      paths = Array.from({ length: 201 }, (_, i) => `${i}.flac`)
    const lookup = f.api.lookupTracksByPaths
    const mutate = () =>
      f.db.patchTracks([{ id: 'track:0', expectedVersion: 1, patch: { title: 'Changed' } }])
    if (phase === 'final-check')
      f.api.getMetadata = async () => {
        mutate()
        return f.db.getMetadata()
      }
    else if (phase === 'lookup')
      f.api.lookupTracksByPaths = async (...args) => {
        const response = await lookup(...args)
        mutate()
        return response
      }
    else {
      const read = f.api.getTracksByIds
      f.api.getTracksByIds = async (...args) => {
        const page = await read(...args)
        mutate()
        return page
      }
    }
    const playlists = shallowRef<Playlist[]>([
      { id: 'existing', name: 'Mix', trackIds: ['keep'], createdAt: '2026-01-01' }
    ])
    const original = structuredClone(playlists.value)
    const persistence = ref<PlaylistPersistenceStatus>({
      state: 'idle',
      dirty: false,
      failureCount: 0,
      lastError: null
    })
    const controller = createPlaylistController({
      playlists,
      tracks: shallowRef([]),
      trackById: new Map(),
      getTracksRevision: () => 0,
      playlistPersistenceStatus: persistence,
      playlistPersistenceNotice: ref<PlaylistPersistenceNotice | null>(null),
      resolveImportPaths: (paths) => resolveLibraryPlaylistImportPaths(paths, f.api)
    })
    await assert.rejects(
      controller.importPlaylistPathBatchAsync([
        { name: 'Mix', paths: paths.slice(0, 100) },
        { name: 'New', paths: paths.slice(100) }
      ]),
      /发生变化/
    )
    assert.deepEqual(playlists.value, original)
    assert.equal(persistence.value.dirty, false)
    await controller.flushPlaylists()
  })

test('incomplete lookup or record responses reject; empty input performs no database reads', async (t) => {
  const f = fixture(t)
  assert.deepEqual(await resolveLibraryPlaylistImportPaths([], f.api), [])
  assert.deepEqual(f.requests, [])
  const revision = f.db.getMetadata().revision
  f.api.lookupTracksByPaths = async () => ({ ids: [], revision })
  await assert.rejects(resolveLibraryPlaylistImportPaths(['0.flac'], f.api), /不完整/)
  f.api.lookupTracksByPaths = async () => ({ ids: ['track:0'], revision })
  f.api.getTracksByIds = async () => ({
    tracks: [{ id: 'wrong-id', filePath: 'x' }],
    versions: {},
    total: 1,
    offset: 0,
    revision
  })
  await assert.rejects(resolveLibraryPlaylistImportPaths(['0.flac'], f.api), /不完整/)
})
