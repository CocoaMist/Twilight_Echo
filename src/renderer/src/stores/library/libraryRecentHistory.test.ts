import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { CoreRecentLibraryEntry } from '../../../../shared/coreLibrary.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
import { coreLibraryPage } from '../coreTestFixtures.ts'
import { readLibraryRecentHistoryTracks } from './libraryRecentHistory.ts'

test('history ranking resolves local identities, retains remote snapshots and deduplicates preferred recordings', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'local:1',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        filePath: 'D:/Music/song.flac',
        duration: 180
      }
    ]
  })
  const remote: Track = {
    id: 'ncm:1',
    source: 'ncm',
    title: 'Other song',
    artist: 'Other artist',
    album: 'Other album',
    filePath: '',
    fileName: 'Other song',
    duration: 120,
    size: 0,
    cover: null,
    lyrics: null
  }
  const localStat = (id: string): UnifiedRecentStat => ({
    id,
    title: 'Song',
    artist: 'Artist',
    cover: null,
    seconds: 300,
    plays: 3,
    lastPlayed: 10,
    skips: 0,
    completions: 2,
    sourceIds: [{ source: 'ncm', trackId: 'local:1' }],
    track: remote
  })
  const history = [
    localStat('ncm:recent-a'),
    localStat('ncm:recent-b'),
    {
      ...localStat('ncm:remote'),
      title: remote.title,
      artist: remote.artist,
      sourceIds: [],
      track: remote
    }
  ]
  const revision = db.getMetadata().revision
  const tracks = await readLibraryRecentHistoryTracks(
    history,
    revision,
    {
      getPreferences: () => ({ revision: 0, versions: [] }),
      api: {
        resolveRecentTracks: async (entries, expected, versionsRevision) => ({
          ...db.lookupPlaylistTracks({ entries, versions: [], resolution: 'recent' }, expected),
          versionsRevision
        }),
        getTracksByIds: (ids, expected) =>
          Promise.resolve(coreLibraryPage(db.getTracksByIds(ids, expected)))
      }
    },
    () => {}
  )

  assert.deepEqual(
    tracks.map((track) => track.id),
    ['local:1', 'ncm:1']
  )
})

test('Core history lookup preserves source matches and CUE identity while keeping remote snapshots', async (t) => {
  const cueTrack: Track = {
    id: 'cue:2',
    source: 'local',
    title: 'Cue Track',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:/Music/disc.flac',
    fileName: 'disc.flac',
    subTrack: '2',
    cueRange: { startSeconds: 30, endSeconds: 60, pregapSeconds: 0 },
    duration: 30,
    size: 1,
    cover: null,
    lyrics: null
  }
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'local:1',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        filePath: 'D:/Music/song.flac',
        duration: 180
      },
      cueTrack
    ]
  })
  const remote: Track = {
    id: 'ncm:remote',
    source: 'ncm',
    title: 'Remote song',
    artist: 'Remote artist',
    album: 'Remote album',
    filePath: '',
    fileName: 'Remote song',
    duration: 120,
    size: 0,
    cover: null,
    lyrics: null
  }
  const recent = (id: string, track: Track, sourceIds: string[] = []): UnifiedRecentStat => ({
    id,
    title: track.title,
    artist: track.artist,
    cover: null,
    seconds: 30,
    plays: 1,
    lastPlayed: 10,
    skips: 0,
    completions: 1,
    sourceIds: sourceIds.map((trackId) => ({ source: 'ncm', trackId })),
    track
  })
  const history = [
    recent('ncm:history-local', remote, ['local:1']),
    recent('local:cue-history', cueTrack),
    recent('ncm:history-remote', remote)
  ]
  const revision = db.getMetadata().revision
  let receivedEntries: CoreRecentLibraryEntry[] = []
  const tracks = await readLibraryRecentHistoryTracks(
    history,
    revision,
    {
      getPreferences: () => ({ revision: 7, versions: [] }),
      api: {
        resolveRecentTracks: async (entries, expectedRevision, versionsRevision) => {
          receivedEntries = entries
          assert.equal(expectedRevision, revision)
          assert.equal(versionsRevision, 7)
          const result = db.lookupPlaylistTracks(
            { entries, versions: [], resolution: 'recent' },
            expectedRevision
          )
          return { ...result, versionsRevision }
        },
        getTracksByIds: (ids, expected) =>
          Promise.resolve(coreLibraryPage(db.getTracksByIds(ids, expected)))
      }
    },
    () => {}
  )

  assert.equal(receivedEntries[0].sourceIds?.[0], 'local:1')
  assert.equal(receivedEntries[1].snapshot?.subTrack, '2')
  assert.deepEqual(receivedEntries[1].snapshot?.cueRange, cueTrack.cueRange)
  assert.deepEqual(
    tracks.map((track) => track.id),
    ['local:1', 'cue:2', 'ncm:remote']
  )
})

test('Core recent history rejects a version preference change during resolution', async () => {
  let preferenceRevision = 3
  await assert.rejects(
    readLibraryRecentHistoryTracks(
      [
        {
          id: 'history',
          title: 'Song',
          artist: 'Artist',
          cover: null,
          seconds: 30,
          plays: 1,
          lastPlayed: 10,
          skips: 0,
          completions: 1
        }
      ],
      1,
      {
        getPreferences: () => ({ revision: preferenceRevision, versions: [] }),
        api: {
          resolveRecentTracks: async (_entries, revision, versionsRevision) => {
            preferenceRevision++
            return { ids: [null], revision, versionsRevision }
          },
          getTracksByIds: async () => ({ revision: 1, tracks: [] })
        }
      },
      () => {}
    ),
    /录音版本偏好已变化/
  )
})
