import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../shared/track.ts'
import { createAggregatePlaylistModel } from '../../../shared/aggregatePlaylistView.ts'
import { createLogicalTrackModel } from '../../../shared/logicalTrackModel.ts'

const {
  buildAggregateRows,
  collectAggregateSources,
  isAggregatePlaylist,
  resolveAggregateQueue,
  sortAggregatePlaylists,
  toggleHiddenSource
} = createAggregatePlaylistModel(createLogicalTrackModel(() => undefined))

function track(overrides: Partial<Track> & Pick<Track, 'id' | 'title' | 'artist'>): Track {
  return {
    album: 'Album',
    filePath: overrides.id,
    fileName: `${overrides.title || 'Unknown'}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    ...overrides
  }
}

const localMoon = track({
  id: 'D:/music/moon.flac',
  title: 'Moon River',
  artist: 'Audrey',
  source: 'local',
  format: 'flac'
})
const ncmMoon = track({
  id: 'ncm:123',
  title: 'Moon River',
  artist: 'Audrey',
  source: 'ncm',
  ncmSongId: 123,
  format: 'mp3'
})
const otherProviderMoon = track({
  id: 'qq:900',
  title: 'Moon River',
  artist: 'Audrey',
  source: 'qq'
})

test('one recording across sources collapses into a single row', () => {
  const rows = buildAggregateRows({ tracks: [ncmMoon, localMoon, otherProviderMoon] })

  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].allVariants.map((variant) => variant.source).sort(), [
    'local',
    'ncm',
    'qq'
  ])
  // 本地无损优先，所以默认播放的就是本地文件，即使它不是第一个加进来的。
  assert.equal(rows[0].selectedVariant.source, 'local')
  assert.equal(rows[0].variantPinned, false)
})

test('two provider ids with the same title stay two rows', () => {
  // 这是"同名同歌手的不同歌互相顶掉"那个回归的反向断言：分组必须按录音身份，
  // 不能只看标题歌手加时长。
  const otherNcmSong = track({
    id: 'ncm:456',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'ncm',
    ncmSongId: 456
  })
  const rows = buildAggregateRows({ tracks: [ncmMoon, otherNcmSong] })

  assert.equal(rows.length, 2)
})

test('the row anchor is the smallest track id and survives reordering', () => {
  const forward = buildAggregateRows({ tracks: [localMoon, ncmMoon, otherProviderMoon] })
  const reversed = buildAggregateRows({ tracks: [otherProviderMoon, ncmMoon, localMoon] })

  assert.equal(forward[0].anchorTrackId, 'D:/music/moon.flac')
  assert.equal(reversed[0].anchorTrackId, forward[0].anchorTrackId)
})

test('hiding a source drops it from the row but keeps the row playable', () => {
  const rows = buildAggregateRows({
    tracks: [localMoon, ncmMoon],
    hiddenSources: ['local']
  })

  assert.equal(rows.length, 1)
  assert.deepEqual(
    rows[0].visibleVariants.map((variant) => variant.source),
    ['ncm']
  )
  assert.equal(rows[0].selectedVariant.source, 'ncm')
  // 全部音源仍然留在 allVariants 里，切换菜单才能展示被隐藏的那些。
  assert.equal(rows[0].allVariants.length, 2)
})

test('a row whose every source is hidden disappears entirely', () => {
  const streamingOnly = track({
    id: 'ncm:777',
    title: 'Only Online',
    artist: 'Nobody',
    source: 'ncm'
  })
  const rows = buildAggregateRows({
    tracks: [localMoon, streamingOnly],
    hiddenSources: ['ncm']
  })

  assert.deepEqual(
    rows.map((row) => row.title),
    ['Moon River']
  )
})

test('a variant preference wins over the default priority', () => {
  const rows = buildAggregateRows({
    tracks: [localMoon, ncmMoon],
    variantPreferences: { [localMoon.id]: 'ncm' }
  })

  assert.equal(rows[0].selectedVariant.source, 'ncm')
  assert.equal(rows[0].variantPinned, true)
})

test('a preference pointing at a hidden or missing source falls back to the best visible one', () => {
  const hidden = buildAggregateRows({
    tracks: [localMoon, ncmMoon],
    hiddenSources: ['ncm'],
    variantPreferences: { [localMoon.id]: 'ncm' }
  })
  assert.equal(hidden[0].selectedVariant.source, 'local')
  assert.equal(hidden[0].variantPinned, false)

  const stale = buildAggregateRows({
    tracks: [localMoon, ncmMoon],
    variantPreferences: { [localMoon.id]: 'spotify' }
  })
  assert.equal(stale[0].selectedVariant.source, 'local')
  assert.equal(stale[0].variantPinned, false)
})

test('the playback queue takes each row current source', () => {
  const rows = buildAggregateRows({
    tracks: [localMoon, ncmMoon],
    variantPreferences: { [localMoon.id]: 'ncm' }
  })

  assert.deepEqual(
    resolveAggregateQueue(rows).map((queued) => queued.id),
    ['ncm:123']
  )
})

test('the source filter lists local first and keeps hidden sources visible at zero', () => {
  const sources = collectAggregateSources([localMoon, ncmMoon, otherProviderMoon], ['radio'])

  assert.deepEqual(sources, [
    { source: 'local', count: 1, hidden: false },
    { source: 'ncm', count: 1, hidden: false },
    { source: 'qq', count: 1, hidden: false },
    // 歌单里已经一首都不剩，但筛选条上仍要能点回来。
    { source: 'radio', count: 0, hidden: true }
  ])
})

test('toggleHiddenSource adds and removes without reordering the rest', () => {
  assert.deepEqual(toggleHiddenSource(['ncm'], 'qq'), ['ncm', 'qq'])
  assert.deepEqual(toggleHiddenSource(['ncm', 'qq'], 'ncm'), ['qq'])
})

test('pinned aggregate playlists sort ahead of recently updated ones', () => {
  const sorted = sortAggregatePlaylists([
    { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' },
    { createdAt: '2026-01-02T00:00:00.000Z', pinnedAt: '2026-02-01T00:00:00.000Z' },
    { createdAt: '2026-01-03T00:00:00.000Z', pinnedAt: '2026-03-01T00:00:00.000Z' },
    { createdAt: '2026-01-04T00:00:00.000Z', pinnedAt: null }
  ])

  assert.deepEqual(
    sorted.map((playlist) => playlist.createdAt),
    [
      // 置顶按置顶时间倒序，其余按最近更新倒序。
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z'
    ]
  )
})

test('only playlists marked aggregate are treated as aggregate', () => {
  assert.equal(isAggregatePlaylist({ kind: 'aggregate' }), true)
  assert.equal(isAggregatePlaylist({}), false)
  assert.equal(isAggregatePlaylist({ kind: 'something-else' }), false)
})
