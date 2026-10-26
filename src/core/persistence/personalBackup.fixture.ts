import type { PersonalBackup } from '../../shared/personalBackup.ts'
const timestamp = '2026-10-03T00:00:00.000Z'
const track = {
  id: 'song',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  filePath: 'C:/Old/song.flac',
  duration: 30
}
const savedTrack = { ...track, source: 'local', queueEntryId: 'entry' }
export function personalBackupFixture(): PersonalBackup {
  return {
    format: 'twilight-personal-data',
    version: 1,
    createdAt: timestamp,
    data: {
      library: { version: 2, revision: 0, tracks: [track], folders: ['C:/Old'], exclusions: [] },
      playlists: [
        {
          id: 'favorites',
          name: '收藏',
          trackIds: ['song'],
          trackSnapshots: { song: track },
          createdAt: timestamp
        }
      ],
      queue: {
        version: 1,
        sessions: [
          {
            id: 'session',
            name: '夜间队列',
            createdAt: timestamp,
            updatedAt: timestamp,
            playMode: 'sequential',
            entries: [savedTrack],
            originalEntryIds: ['entry'],
            currentEntryId: 'entry',
            position: 12
          }
        ],
        history: [{ id: 'history', playedAt: timestamp, track: savedTrack, playMode: 'sequential' }]
      },
      playback: {
        version: 1,
        savedAt: timestamp,
        mode: 'trackAndPosition',
        track,
        queue: [track],
        queueIndex: 0,
        position: 12
      },
      lyrics: {
        schemaVersion: 1,
        globalOffsetMs: 0,
        showOriginal: true,
        showTranslation: true,
        showRomanization: false,
        tracks: {
          song: {
            offsetMs: 300,
            source: 'manual',
            original: '[00:01.00]编辑过的歌词',
            translation: '译文',
            romanization: null,
            updatedAt: timestamp
          }
        }
      },
      bookmarks: {
        schemaVersion: 1,
        longTrackResumeSeconds: 1200,
        bookmarks: [
          {
            id: 'bookmark',
            trackKey: 'local:song',
            positionSeconds: 12,
            label: '喜欢的片段',
            createdAt: timestamp,
            updatedAt: timestamp,
            kind: 'manual'
          }
        ]
      },
      radio: {
        schemaVersion: 1,
        stations: [
          {
            id: 'radio',
            name: '收藏电台',
            streamUrl: 'https://example.test/live',
            allowInsecureHttp: false,
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ]
      },
      podcasts: {
        schemaVersion: 1,
        subscriptions: [
          {
            id: 'podcast',
            title: '订阅节目',
            feedUrl: 'https://example.test/feed',
            createdAt: timestamp,
            updatedAt: timestamp,
            episodes: [
              {
                guid: 'episode',
                title: '已听节目',
                mediaUrl: 'https://example.test/episode.mp3',
                durationSeconds: 1800,
                progressSeconds: 900
              }
            ]
          }
        ]
      },
      statistics: {
        days: { '2026-10-03': 20 },
        tracks: { song: { title: 'Song', artist: 'Artist', seconds: 20, plays: 1 } }
      },
      versions: {
        version: 1,
        tracks: {
          versions: [
            {
              id: 'version',
              label: '无损版本',
              sources: ['local:song'],
              preferredSource: 'local:song'
            }
          ],
          families: []
        },
        albums: { versions: [], families: [] }
      }
    }
  }
}
