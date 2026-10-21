import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { Track } from '../../types/music.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
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
  const tracks = await readLibraryRecentHistoryTracks(history, revision, {
    getPreferences: () => ({ revision: 0, versions: [] }),
    api: {
      lookupPlaylistTracks: (request, expected) =>
        Promise.resolve(db.lookupPlaylistTracks(request, expected)),
      getTracksByIds: (ids, expected) => Promise.resolve(db.getTracksByIds(ids, expected))
    }
  }, () => {})

  assert.deepEqual(tracks.map((track) => track.id), ['local:1', 'ncm:1'])
})
