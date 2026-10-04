import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyPendingPersonalRestore,
  createPersonalBackup,
  parsePersonalBackup,
  readPersonalData,
  readRendererRestore,
  stagePersonalRestore,
  acknowledgeRendererRestore,
  buildRestoreData,
  writePersonalBackupFile,
  readBackupFile
} from './personalBackup.ts'
import {
  PERSONAL_DOMAINS,
  remapPersonalPaths,
  previewPersonalBackup,
  type PersonalBackup,
  type PersonalRestoreOptions
} from '../../shared/personalBackup.ts'

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
function backup(): PersonalBackup {
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
const options = (): PersonalRestoreOptions => ({
  conflict: 'keep-local',
  mappings: [{ from: 'C:/Old', to: 'D:/Music' }],
  domains: [...PERSONAL_DOMAINS]
})
function fixture(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'twilight-personal-test-'))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('all ten data domains round-trip through an empty profile with mapped paths and queue revisions', () =>
  fixture((root) => {
    const source = parsePersonalBackup(JSON.stringify(backup()))
    stagePersonalRestore(root, source, options(), ['D:/Music'])
    assert.deepEqual(readPersonalData(root), {}, 'staging must not change live data')
    applyPendingPersonalRestore(root)
    const data = readPersonalData(root)
    assert.equal(
      (data.library as { tracks: (typeof track)[] }).tracks[0].filePath,
      'D:/Music/song.flac'
    )
    assert.equal((data.playback as { queue: (typeof track)[] }).queue[0].id, 'song')
    assert.equal((data.playback as { position: number }).position, 12)
    const renderer = readRendererRestore(root) as { id: string; data: Record<string, unknown> }
    assert.deepEqual(renderer.data.statistics, source.data.statistics)
    const exported = createPersonalBackup(root, renderer.data)
    assert.equal(Object.keys(exported.data).length, 10)
    fixture((destination) => {
      // Import the actual serializer output into a second empty profile.
      const backupFile = join(root, 'exported-personal.json')
      writePersonalBackupFile(backupFile, exported)
      const imported = readBackupFile(backupFile)
      stagePersonalRestore(destination, imported, { ...options(), mappings: [] })
      applyPendingPersonalRestore(destination)
      const restored = readPersonalData(destination)
      for (const domain of [
        'playlists',
        'queue',
        'playback',
        'lyrics',
        'bookmarks',
        'radio',
        'podcasts'
      ] as const)
        assert.deepEqual(
          restored[domain],
          exported.data[domain],
          `${domain} did not survive an actual export/import`
        )
      const rendererRestored = readRendererRestore(destination) as { data: Record<string, unknown> }
      assert.deepEqual(rendererRestored.data.statistics, exported.data.statistics)
      assert.deepEqual(rendererRestored.data.versions, exported.data.versions)
    })
    assert.deepEqual(
      exported.data.playlists,
      remapPersonalPaths(source.data.playlists, options().mappings)
    )
    const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
    assert.deepEqual(settings.libraryFolders, ['D:/Music'])
    acknowledgeRendererRestore(root, 'wrong-id')
    assert.ok(readRendererRestore(root))
    acknowledgeRendererRestore(root, renderer.id)
    assert.equal(readRendererRestore(root), null)
  }))
test('a crash between writes is replayed from the durable journal before startup', () =>
  fixture((root) => {
    stagePersonalRestore(root, backup(), options())
    let writes = 0
    assert.throws(
      () =>
        applyPendingPersonalRestore(root, () => {
          if (++writes === 3) throw new Error('disk unavailable')
        }),
      /disk unavailable/
    )
    assert.ok(existsSync(join(root, 'personal-restore-journal.json')))
    applyPendingPersonalRestore(root)
    assert.equal(Object.keys(readPersonalData(root)).length, 8)
    assert.ok(existsSync(join(root, 'personal-restore-previous.json')))
    assert.equal(existsSync(join(root, 'personal-restore-journal.json')), false)
    applyPendingPersonalRestore(root)
    assert.equal((readPersonalData(root).playlists as unknown[]).length, 1)
  }))
test('merge uses the selected conflict policy and repeated imports do not duplicate records', () =>
  fixture((root) => {
    const source = backup()
    stagePersonalRestore(root, source, options())
    applyPendingPersonalRestore(root)
    const playlistFile = join(root, 'playlists.json')
    const saved = JSON.parse(readFileSync(playlistFile, 'utf8'))
    saved.data[0].name = '本机新名字'
    saved.data.push({ id: 'new', name: '新歌单', trackIds: [], createdAt: timestamp })
    writeFileSync(playlistFile, JSON.stringify(saved))
    stagePersonalRestore(root, source, options())
    applyPendingPersonalRestore(root)
    assert.equal((readPersonalData(root).playlists as { name: string }[])[0].name, '本机新名字')
    assert.equal((readPersonalData(root).playlists as unknown[]).length, 2)
    stagePersonalRestore(root, source, { ...options(), conflict: 'use-backup' })
    applyPendingPersonalRestore(root)
    assert.equal((readPersonalData(root).playlists as { name: string }[])[0].name, '收藏')
    assert.equal((readPersonalData(root).playlists as unknown[]).length, 2)
  }))
test('invalid schemas, unknown domains, malformed data and excessive nesting fail before writing', () =>
  fixture((root) => {
    assert.throws(() => parsePersonalBackup('{'))
    assert.throws(() => parsePersonalBackup(JSON.stringify({ ...backup(), version: 999 })))
    assert.throws(() =>
      parsePersonalBackup(JSON.stringify({ ...backup(), data: { cookie: 'secret' } }))
    )
    assert.throws(() =>
      parsePersonalBackup(JSON.stringify({ ...backup(), data: { bookmarks: { bookmarks: [] } } }))
    )
    assert.throws(() => parsePersonalBackup('['.repeat(100) + ']'.repeat(100)))
    assert.throws(() => stagePersonalRestore(root, backup(), { ...options(), domains: [] }))
    assert.deepEqual(readPersonalData(root), {})
  }))
test('path mapping observes directory boundaries and leaves titles, lyrics and URLs intact', () => {
  const value = {
    filePath: 'C:\\Old\\song.flac',
    title: 'C:/Old/title',
    original: 'C:/Old/lyric',
    mediaUrl: 'https://example.test/C:/Old',
    dir: 'C:/Older',
    tracks: { 'local:C:/Old/song.flac': {} }
  }
  const mapped = remapPersonalPaths(value, options().mappings) as typeof value
  assert.equal(mapped.filePath, 'D:/Music/song.flac')
  assert.equal(mapped.dir, 'C:/Older')
  assert.equal(mapped.title, value.title)
  assert.equal(mapped.original, value.original)
  assert.ok('local:D:/Music/song.flac' in mapped.tracks)
  assert.deepEqual(
    remapPersonalPaths({ filePath: '/Music/song.flac' }, [{ from: '/music', to: '/new' }]),
    { filePath: '/Music/song.flac' }
  )
})
test('subscription conflicts match both stable identity and feed URL', () => {
  const source = backup()
  const current = structuredClone(source.data)
  const original = (current.podcasts as { subscriptions: Record<string, unknown>[] })
    .subscriptions[0]
  original.feedUrl = 'https://example.test/changed-feed'
  const local = buildRestoreData(source, { ...options(), domains: ['podcasts'] }, current)
  assert.equal((local.podcasts as { subscriptions: unknown[] }).subscriptions.length, 1)
  assert.deepEqual((local.podcasts as { subscriptions: unknown[] }).subscriptions[0], original)
  original.id = 'different-id'
  original.feedUrl = 'https://example.test/feed'
  const preferred = buildRestoreData(
    source,
    { ...options(), conflict: 'use-backup', domains: ['podcasts'] },
    current
  )
  assert.equal((preferred.podcasts as { subscriptions: unknown[] }).subscriptions.length, 1)
  assert.equal(
    (preferred.podcasts as { subscriptions: { id: string }[] }).subscriptions[0].id,
    'podcast'
  )
})
test('preview exposes record overlap; selected domains alone change; credentials are excluded', () =>
  fixture((root) => {
    const source = backup()
    const preview = previewPersonalBackup(source, source.data)
    assert.equal(preview.rows.find((r) => r.domain === 'playlists')?.conflicts, 1)
    assert.deepEqual(
      Object.keys(buildRestoreData(source, { ...options(), domains: ['bookmarks'] }, {})),
      ['bookmarks']
    )
    stagePersonalRestore(root, source, options())
    applyPendingPersonalRestore(root)
    writeFileSync(join(root, 'ncm-cookie.json'), JSON.stringify({ cookie: 'must-not-export' }))
    const exported = JSON.stringify(createPersonalBackup(root, {}))
    assert.equal(exported.includes('must-not-export'), false)
  }))
