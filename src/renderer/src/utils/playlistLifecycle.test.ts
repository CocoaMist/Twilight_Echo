import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../shared/track.ts'
import {
  exportPlaylistDocument,
  findPlaylistRelocations,
  parsePlaylistDocument,
  reorderStableIds
} from './playlistLifecycle.ts'

function track(id: string, filePath: string, title = id): Track {
  return {
    id,
    title,
    artist: 'Artist',
    album: 'Album',
    filePath,
    fileName: filePath.split(/[\\/]/).at(-1) ?? filePath,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

test('M3U8 export and import retain order and metadata safely', () => {
  const source = [
    track('one', 'D:\\Music\\One.flac', 'One'),
    track('two', 'D:\\Music\\Two.flac', 'Two')
  ]
  const text = exportPlaylistDocument(source, 'm3u8')
  const parsed = parsePlaylistDocument(text, 'favorites.m3u8')
  assert.equal(parsed.format, 'm3u8')
  assert.deepEqual(
    parsed.entries.map((entry) => entry.path),
    ['D:/Music/One.flac', 'D:/Music/Two.flac']
  )
  assert.equal(parsed.entries[0].title, 'Artist - One')
})

test('M3U and PLS exports produce their respective portable playlist documents', () => {
  const source = [track('one', 'D:\\Music\\One.flac', 'One')]

  const m3u = exportPlaylistDocument(source, 'm3u')
  assert.match(m3u, /^#EXTM3U\r\n#EXTINF:180,Artist - One\r\nD:\/Music\/One\.flac\r\n$/)

  const pls = exportPlaylistDocument(source, 'pls')
  assert.equal(
    pls,
    '[playlist]\r\nFile1=D:/Music/One.flac\r\nTitle1=Artist - One\r\nLength1=180\r\nNumberOfEntries=1\r\nVersion=2\r\n'
  )
})

test('PLS parser ignores malformed keys and preserves numeric entry order', () => {
  const parsed = parsePlaylistDocument(
    '[playlist]\nFile2=C:\\B.flac\nTitle2=B\nLength2=42\nFile1=C:\\A.flac\nBogus1=no\nVersion=2',
    'mix.pls'
  )
  assert.deepEqual(
    parsed.entries.map((entry) => entry.path),
    ['C:\\A.flac', 'C:\\B.flac']
  )
  assert.equal(parsed.entries[1].durationSeconds, 42)
})

test('stable batch move calculates insertion against the remaining list', () => {
  assert.deepEqual(reorderStableIds(['a', 'b', 'c', 'd', 'e'], ['b', 'd'], 4), [
    'a',
    'c',
    'b',
    'd',
    'e'
  ])
})

test('relocation only accepts a unique filename or metadata candidate', () => {
  const result = findPlaylistRelocations(
    [
      track('old', 'D:\\Old\\song.flac', 'Song'),
      track('ambiguous', 'D:\\Old\\other.flac', 'Other')
    ],
    [
      track('new', 'E:\\New\\song.flac', 'Song'),
      track('first', 'E:\\New\\other.flac', 'Other'),
      track('second', 'F:\\New\\other.flac', 'Other')
    ]
  )
  assert.equal(result.relocations[0]?.toTrack.id, 'new')
  assert.deepEqual(result.ambiguousTrackIds, ['ambiguous'])
})
