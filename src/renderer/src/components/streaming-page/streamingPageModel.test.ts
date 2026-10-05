import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendUniqueTracks,
  getPersonalizedStreamKey,
  getSharedLibraryProviderId,
  getSidebarItemsSignature,
  mergePlaylistSummaries,
  resolveExternalProviderName,
  resolveStreamingTabIndex,
  timeGreeting
} from './streamingPageModel.ts'
import { streamingFavoriteLabel } from './streamingPageModel.ts'

test('favorite action labels name their existing application or platform destination', () => {
  assert.equal(streamingFavoriteLabel([{}], false), '加入应用收藏')
  assert.equal(streamingFavoriteLabel([{ ncmSongId: 1 }], true), '在网易云取消喜欢')
  assert.equal(streamingFavoriteLabel([{}, { ncmSongId: 1 }], false), '加入网易云喜欢与应用收藏')
})

test('getPersonalizedStreamKey maps only fm and radar sections', () => {
  assert.equal(getPersonalizedStreamKey({ key: 'fm' }), 'fm')
  assert.equal(getPersonalizedStreamKey({ key: 'radar' }), 'radar')
  assert.equal(getPersonalizedStreamKey({ key: 'daily' }), null)
  assert.equal(getPersonalizedStreamKey(null), null)
})

test('appendUniqueTracks preserves current order and appends only new ids', () => {
  const current = [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 }
  ]
  const incoming = [
    { id: 'b', value: 20 },
    { id: '', value: 30 },
    { id: 'c', value: 3 },
    { id: 'a', value: 40 }
  ]

  assert.deepEqual(appendUniqueTracks(current, incoming), [{ id: 'c', value: 3 }])
  assert.deepEqual(appendUniqueTracks([], incoming), [
    { id: 'b', value: 20 },
    { id: 'c', value: 3 },
    { id: 'a', value: 40 }
  ])
})

test('mergePlaylistSummaries dedupes by stringified id and keeps first occurrence', () => {
  const first = { id: 1, name: 'first' }
  const second = { id: '1', name: 'second' }
  const third = { id: 2, name: 'third' }

  assert.deepEqual(mergePlaylistSummaries([first], [second, third], [second]), [first, third])
  assert.deepEqual(mergePlaylistSummaries([]), [])
})

test('resolveStreamingTabIndex returns the matching index or zero', () => {
  const tabs = [{ tab: 'home' }, { tab: 'library' }, { tab: 'cloud' }]
  assert.equal(resolveStreamingTabIndex(tabs, 'library'), 1)
  assert.equal(resolveStreamingTabIndex(tabs, 'missing'), 0)
  assert.equal(resolveStreamingTabIndex([], 'missing'), 0)
})

test('getSharedLibraryProviderId prefers the active provider and falls back', () => {
  assert.equal(getSharedLibraryProviderId('ncm', ['ncm', 'bili'], 'fallback'), 'ncm')
  assert.equal(getSharedLibraryProviderId('yt', ['ncm', 'bili'], 'fallback'), 'ncm')
  assert.equal(getSharedLibraryProviderId('yt', [], 'fallback'), 'fallback')
})

test('getSidebarItemsSignature produces a stable external fallback signature', () => {
  const items = [
    { key: 'home', provider: 'ncm', tab: 'home' },
    { key: 'library', provider: 'bili', tab: null },
    { key: 'library', provider: 'yt', tab: undefined }
  ]

  assert.equal(
    getSidebarItemsSignature(items),
    'home:ncm:home|library:bili:external|library:yt:external'
  )
  assert.equal(getSidebarItemsSignature([]), '')
})

test('resolveExternalProviderName resolves names and falls back to provider id', () => {
  assert.equal(
    resolveExternalProviderName('bili', (id) => (id === 'bili' ? 'Bilibili' : null)),
    'Bilibili'
  )
  assert.equal(
    resolveExternalProviderName('missing', () => null),
    'missing'
  )
  assert.equal(
    resolveExternalProviderName('missing', () => undefined),
    'missing'
  )
  assert.equal(
    resolveExternalProviderName('missing', () => ''),
    ''
  )
})

test('timeGreeting follows every hour boundary', () => {
  const cases: Array<[number, string]> = [
    [0, '夜深了'],
    [4, '夜深了'],
    [5, '早上好'],
    [10, '早上好'],
    [11, '中午好'],
    [13, '中午好'],
    [14, '下午好'],
    [17, '下午好'],
    [18, '晚上好'],
    [21, '晚上好'],
    [22, '夜深了'],
    [23, '夜深了']
  ]

  for (const [hour, expected] of cases) {
    assert.equal(timeGreeting(hour), expected)
  }
})
