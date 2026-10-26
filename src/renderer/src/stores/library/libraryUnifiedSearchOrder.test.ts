import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'
import { createLogicalTrackModel } from '../../../../shared/logicalTrackModel.ts'
import { createUnifiedSearchSources } from '../../../../shared/musicSearchSources.ts'
import { versionSourceKey } from '../../../../shared/trackSourceIdentity.ts'
import type { RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'

let preferredVersions = new Map<string, RecordingVersion>(),
  preferenceRevision = 0
const identity = createLogicalTrackModel((key) => preferredVersions.get(key))
const { searchUnifiedLocalPage } = createUnifiedSearchSources(identity, () => preferenceRevision)

function preferences(t: TestContext, selected: Track[]) {
  t.after(() => {
    preferredVersions = new Map()
    preferenceRevision++
  })
  function set(tracks: Track[]) {
    preferredVersions = new Map(
      tracks.map((track, i) => {
        const key = versionSourceKey(track)
        return [key, { id: String(i), sources: [key], preferredSource: key }]
      })
    )
    preferenceRevision++
  }
  set(selected)
  return set
}

function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks: Track[] = Array.from({ length: 415 }, (_, i) => ({
    id: `local:${i}`,
    filePath: `D:/Music/${i}.flac`,
    fileName: `文件-${i}.flac`,
    title: i % 7 ? `晴天 ${i}` : ` 晴天 ${i} `,
    artist: i % 4 ? '周杰伦' : '阿歌手',
    album: `唱片 ${i % 20}`,
    format: i % 3 ? 'flac' : 'mp3',
    duration: 180,
    size: 1,
    lyrics: null,
    cover: null,
    source: 'local'
  }))
  tracks[1] = {
    ...tracks[1],
    filePath: 'D:/Music/disc.flac',
    subTrack: '1',
    cueRange: { startSeconds: 0, endSeconds: 60, pregapSeconds: 0 }
  }
  tracks[2] = {
    ...tracks[2],
    filePath: 'D:/Music/disc.flac',
    subTrack: '2',
    cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 }
  }
  tracks[3] = { ...tracks[3], title: '阿', artist: '中', album: '文' }
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  return { db, tracks }
}

test('SQLite unified search matches complete legacy ordering before paging, including preferences, CUE, Chinese, initials and filenames', (t) => {
  const { db, tracks } = fixture(t)
  const setPreferences = preferences(t, [tracks[399], tracks[2]])
  const assertParity = (query: string, preferred: Track[]) => {
    for (const offset of [0, 1, 100, 200, 400, 800]) {
      const expected = searchUnifiedLocalPage(tracks, query, 100, offset)
      const actual = db.queryTracks({
        sort: 'unifiedSearch',
        search: query,
        searchFileName: true,
        preferredSources: preferred.map(versionSourceKey),
        limit: 100,
        offset
      })
      assert.equal(actual.total, expected.total, `total: ${query}`)
      assert.deepEqual(
        actual.tracks.map((track) => track.id),
        expected.items.map((item) => item.track.id),
        `${query} at ${offset}`
      )
    }
  }
  for (const query of ['晴天', 'zjl', 'qt', '文件-414', '唱片', '阿中', 'impossible'])
    assertParity(query, [tracks[399], tracks[2]])
  const first = db.queryTracks({
    sort: 'unifiedSearch',
    search: '晴天',
    preferredSources: [versionSourceKey(tracks[399])],
    limit: 1
  })
  assert.equal(
    first.tracks[0].id,
    'local:399',
    'lossy preferred source ranks before all lossless entries, even outside the first page'
  )
  // Same array/content revision, new version preference: neither order cache may remain stale.
  setPreferences([tracks[414]])
  assertParity('晴天', [tracks[414]])
  assert.equal(searchUnifiedLocalPage(tracks, '晴天', 1, 0).items[0].track.id, 'local:414')
})

test('unified search accepts the existing bounded preferences config, rejects malformed input, and keeps normal sorting unchanged', (t) => {
  const { db, tracks } = fixture(t)
  const legacy = db.queryTracks({ sort: 'duration', limit: 1 })
  const keys = Array.from({ length: 20000 }, (_, i) => `unloaded:${i}`)
  assert.equal(
    db.queryTracks({ sort: 'unifiedSearch', preferredSources: keys, limit: 1 }).tracks.length,
    1
  )
  for (const preferredSources of [
    Array(20001).fill('key'),
    [null],
    [''],
    ['x'.repeat(8193)],
    Array(1025).fill('x'.repeat(8192))
  ])
    assert.throws(
      () => db.queryTracks({ sort: 'unifiedSearch', preferredSources } as never),
      /preferences/
    )
  assert.deepEqual(
    db.queryTracks({
      sort: 'duration',
      preferredSources: [versionSourceKey(tracks[414])],
      limit: 1
    }),
    legacy
  )
})

test('legacy source-less records use canonical local CUE preferences without requiring a subTrack field', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'track:0:0',
        filePath: 'D:/Music/a.flac',
        title: '阿歌',
        artist: '周杰伦',
        format: 'flac'
      },
      {
        id: 'track:10:2',
        filePath: 'D:/Music/Z.flac',
        title: '最后',
        artist: '周杰伦',
        format: 'mp3',
        cueRange: { startSeconds: 60, endSeconds: 120 }
      }
    ]
  })
  const selected = libraryTrack(db.getTracksByIds(['track:10:2']).tracks[0])
  const page = db.queryTracks({
    sort: 'unifiedSearch',
    search: 'zjl',
    limit: 1,
    preferredSources: [versionSourceKey(selected)]
  })
  assert.equal(page.total, 2)
  assert.equal(page.tracks[0].id, selected.id)
})

test('SQLite unified search ranks multi-feature relevance (Exact Title > Prefix Title > Substring Title > Album > Filename) while keeping preferredSources #1', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks: Track[] = [
    {
      id: 'local:filename',
      filePath: 'D:/Music/晴天_demo.flac',
      fileName: '晴天_demo.flac',
      title: '无名曲',
      artist: '路人甲',
      album: '测试集',
      format: 'flac',
      duration: 180,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    },
    {
      id: 'local:album',
      filePath: 'D:/Music/album.flac',
      fileName: 'album.flac',
      title: '序曲',
      artist: '路人甲',
      album: '晴天纪念辑',
      format: 'flac',
      duration: 180,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    },
    {
      id: 'local:substring',
      filePath: 'D:/Music/sub.flac',
      fileName: 'sub.flac',
      title: '等一个晴天吧',
      artist: '路人甲',
      album: '测试集',
      format: 'flac',
      duration: 180,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    },
    {
      id: 'local:prefix',
      filePath: 'D:/Music/prefix.flac',
      fileName: 'prefix.flac',
      title: '晴天娃娃',
      artist: '路人甲',
      album: '测试集',
      format: 'flac',
      duration: 180,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    },
    {
      id: 'local:exact',
      filePath: 'D:/Music/exact.mp3',
      fileName: 'exact.mp3',
      title: '晴天',
      artist: '路人甲',
      album: '测试集',
      format: 'mp3',
      duration: 180,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    }
  ]
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })

  const unpreferred = db.queryTracks({
    sort: 'unifiedSearch',
    search: '晴天',
    searchFileName: true,
    limit: 10
  })
  assert.deepEqual(
    unpreferred.tracks.map((tr) => tr.id),
    ['local:exact', 'local:prefix', 'local:substring', 'local:album', 'local:filename']
  )

  const withPreferred = db.queryTracks({
    sort: 'unifiedSearch',
    search: '晴天',
    searchFileName: true,
    preferredSources: [versionSourceKey(tracks[0])],
    limit: 10
  })
  assert.deepEqual(
    withPreferred.tracks.map((tr) => tr.id),
    ['local:filename', 'local:exact', 'local:prefix', 'local:substring', 'local:album']
  )
})

test('SQLite unified search supports multi-token cross-field queries and SymSpell typo correction', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks: Track[] = [
    {
      id: 'local:jay-qt',
      filePath: 'D:/Music/qt.flac',
      fileName: 'qt.flac',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      format: 'flac',
      duration: 269,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    },
    {
      id: 'local:jay-dyx',
      filePath: 'D:/Music/dyx.flac',
      fileName: 'dyx.flac',
      title: '稻香',
      artist: '周杰伦',
      album: '魔杰座',
      format: 'flac',
      duration: 223,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    },
    {
      id: 'local:beethoven',
      filePath: 'D:/Music/sym5.flac',
      fileName: 'sym5.flac',
      title: 'Symphony No. 5',
      artist: 'Beethoven',
      album: 'Classical Masterpieces',
      format: 'flac',
      duration: 420,
      size: 1,
      lyrics: null,
      cover: null,
      source: 'local'
    }
  ]
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })

  const crossField = db.queryTracks({
    sort: 'unifiedSearch',
    search: '周杰伦 晴天',
    searchFileName: true,
    limit: 10
  })
  assert.equal(crossField.total, 1)
  assert.equal(crossField.tracks[0].id, 'local:jay-qt')

  const typoCorrected = db.queryTracks({
    sort: 'unifiedSearch',
    search: 'beethovn',
    searchFileName: true,
    limit: 10
  })
  assert.equal(typoCorrected.total, 1)
  assert.equal(typoCorrected.tracks[0].id, 'local:beethoven')
})
