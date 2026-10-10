import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, ref } from 'vue'
import { useLibraryFavoritePlaylist } from './useLibraryFavoritePlaylist.ts'
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider.ts'
import { movePlaylistEntry, orderPlaylistEntries } from './playlistLibraryView.ts'

test('saved ordering tolerates removed playlists and appends newly discovered playlists', () => {
  const entries = [{ id: 1 }, { id: 2 }, { id: 3 }]
  assert.deepEqual(
    orderPlaylistEntries(entries, ['deleted', '2', '1']).map((p) => p.id),
    [2, 1, 3]
  )
  assert.deepEqual(
    entries.map((p) => p.id),
    [1, 2, 3]
  )
})

test('dragging and keyboard moves preserve other groups and reject stale ids', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepEqual(movePlaylistEntry(order, 'a', 'c'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(movePlaylistEntry(order, 'd', 'b'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(movePlaylistEntry(order, 'missing', 'b'), order)
})

test('pinned playlists keep priority over locally saved ordering', () => {
  const entries = [{ id: 1 }, { id: 2, pinned: true }, { id: 3 }]
  assert.deepEqual(
    orderPlaylistEntries(entries, ['1', '3', '2'], new Set(['3'])).map((p) => p.id),
    [3, 2, 1]
  )
})

test('libraries without pin controls respect manual order despite legacy provider pins', () => {
  const entries = [{ id: '101', pinned: true }, { id: '102' }, { id: '103' }]
  const pinnedIds = new Set(['101'])
  assert.deepEqual(
    orderPlaylistEntries(entries, [], pinnedIds, false).map((p) => p.id),
    ['101', '102', '103']
  )
  const moved = movePlaylistEntry(['101', '102', '103'], '101', '103')
  assert.deepEqual(
    orderPlaylistEntries(entries, moved, pinnedIds, false).map((p) => p.id),
    ['102', '103', '101']
  )
})

function favoriteFixture() {
  const account = ref('bili:123')
  const fallback = ref<MediaProviderPlaylistSummary | null>({
    id: 101,
    name: '默认收藏夹',
    cover: null,
    trackCount: 135
  })
  const playlists = ref<MediaProviderPlaylistSummary[]>([
    { ...fallback.value!, id: '101' },
    { id: '102', name: '音乐收藏', cover: 'cover-102', trackCount: 42 }
  ])
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    }
  }
  let scope = effectScope()
  function mount() {
    return scope.run(() =>
      useLibraryFavoritePlaylist(
        () => account.value,
        () => fallback.value,
        () => playlists.value,
        () => storage
      )
    )!
  }
  let selection = mount()
  return {
    account,
    fallback,
    playlists,
    storage,
    get selection() {
      return selection
    },
    remount() {
      scope.stop()
      scope = effectScope()
      selection = mount()
    },
    stop: () => scope.stop()
  }
}

test('library favorite selection updates all summary fields and survives remount', () => {
  const f = favoriteFixture()
  try {
    assert.equal(f.selection.selectedPlaylist.value?.id, 101)
    assert.deepEqual(
      f.selection.options.value.map((p) => String(p.id)),
      ['101', '102']
    )
    f.selection.select('102')
    assert.deepEqual(f.selection.selectedPlaylist.value, f.playlists.value[1])
    f.remount()
    assert.equal(f.selection.selectedPlaylist.value?.name, '音乐收藏')
    assert.equal(f.selection.selectedPlaylist.value?.cover, 'cover-102')
    assert.equal(f.selection.selectedPlaylist.value?.trackCount, 42)
  } finally {
    f.stop()
  }
})

test('library favorite choices are isolated by provider and account immediately', () => {
  const f = favoriteFixture()
  try {
    f.selection.select('102')
    for (const account of ['other:123', 'bili:456']) {
      f.account.value = account
      assert.equal(f.selection.selectedPlaylist.value?.id, 101)
    }
    f.account.value = 'bili:123'
    assert.equal(f.selection.selectedPlaylist.value?.id, '102')
  } finally {
    f.stop()
  }
})

test('library refresh uses fresh summaries and falls back when the selected folder disappears', () => {
  const f = favoriteFixture()
  try {
    f.selection.select('102')
    f.playlists.value = [{ ...f.playlists.value[1], name: '改名后的收藏夹', trackCount: 43 }]
    assert.equal(f.selection.selectedPlaylist.value?.name, '改名后的收藏夹')
    assert.equal(f.selection.selectedPlaylist.value?.trackCount, 43)
    f.playlists.value = []
    assert.equal(f.selection.selectedPlaylist.value?.id, 101)
    f.selection.select('unknown-folder')
    assert.equal(f.selection.selectedPlaylist.value?.id, 101)
    f.fallback.value = null
    assert.equal(f.selection.selectedPlaylist.value, null)
    assert.equal(f.selection.options.value.length, 0)
  } finally {
    f.stop()
  }
})

test('storage failure keeps the selected folder usable and reports that it was not saved', () => {
  const f = favoriteFixture()
  try {
    f.storage.setItem = () => {
      throw new Error('storage full')
    }
    f.selection.select('102')
    assert.equal(f.selection.selectedPlaylist.value?.id, '102')
    assert.match(f.selection.storageError.value, /无法保存/)
    f.storage.getItem = () => {
      throw new Error('storage unavailable')
    }
    f.remount()
    assert.equal(f.selection.selectedPlaylist.value?.id, 101)
    assert.match(f.selection.storageError.value, /无法读取/)
  } finally {
    f.stop()
  }
})
