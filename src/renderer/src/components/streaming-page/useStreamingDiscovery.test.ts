import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import type { NcmPlaylistSummary } from '../../stores/useNcmStore.ts'

const { useStreamingDiscovery, DISCOVERY_PAGE_SIZE } = (await import(
  new URL('./useStreamingDiscovery.ts', import.meta.url).href
)) as typeof import('./useStreamingDiscovery')

const catalogueFixture = {
  hotTags: ['华语', '流行'],
  groups: [
    {
      id: 0,
      name: '语种',
      tags: [
        { name: '华语', hot: true },
        { name: '欧美', hot: false }
      ]
    }
  ]
}

function playlist(id: number): NcmPlaylistSummary {
  return {
    id,
    name: `playlist-${id}`,
    cover: null,
    trackCount: id,
    playCount: id * 100
  }
}

function discoveryPage(ids: number[], offset = 0, total = 100) {
  return {
    items: ids.map(playlist),
    total,
    hasMore: offset + ids.length < total,
    offset,
    limit: DISCOVERY_PAGE_SIZE
  }
}

test('ensureLoaded fetches the catalogue and first page exactly once', async () => {
  let catalogueCalls = 0
  let listCalls = 0
  const discovery = useStreamingDiscovery({
    providerId: ref('ncm'),
    fetchPlaylistCategories: async () => {
      catalogueCalls++
      return catalogueFixture
    },
    fetchDiscoveryPlaylists: async (_providerId, _cat, _order, _limit, offset = 0) => {
      listCalls++
      return discoveryPage([1, 2], offset)
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  await discovery.ensureLoaded()
  await discovery.ensureLoaded()

  assert.equal(catalogueCalls, 1)
  assert.equal(listCalls, 1)
  assert.deepEqual(discovery.catalogue.value, catalogueFixture)
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [1, 2]
  )
})

test('selectTag resets the offset, refetches with the new tag, and collapses the panel', async () => {
  const requests: Array<{ cat?: string; order?: string; offset?: number }> = []
  const discovery = useStreamingDiscovery({
    providerId: ref('ncm'),
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (_providerId, cat, order, _limit, offset) => {
      requests.push({ cat, order, offset })
      return discoveryPage([10], offset ?? 0)
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  await discovery.ensureLoaded()
  discovery.onPageChange({ first: 60 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(discovery.offset.value, 60)

  discovery.panelExpanded.value = true
  discovery.selectTag('欧美')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const last = requests[requests.length - 1]
  assert.equal(last.cat, '欧美')
  assert.equal(last.offset, 0)
  assert.equal(discovery.offset.value, 0)
  assert.equal(discovery.selectedTag.value, '欧美')
  assert.equal(discovery.panelExpanded.value, false)
})

test('stale responses are discarded when a newer request resolves first', async () => {
  let resolveSlow: ((page: ReturnType<typeof discoveryPage>) => void) | null = null
  let call = 0
  const discovery = useStreamingDiscovery({
    providerId: ref('ncm'),
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (_providerId, cat) => {
      call++
      if (call === 1) {
        return new Promise((resolve) => {
          resolveSlow = resolve
        })
      }
      assert.equal(cat, '欧美')
      return discoveryPage([2])
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  const first = discovery.ensureLoaded()
  discovery.selectTag('欧美')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2]
  )
  ;(resolveSlow as ((page: ReturnType<typeof discoveryPage>) => void) | null)?.(discoveryPage([1]))
  await first
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2]
  )
  assert.equal(discovery.listLoading.value, false)
})

test('high-quality mode appends via loadMore threading lasttime as the cursor', async () => {
  const beforeValues: number[] = []
  const discovery = useStreamingDiscovery({
    providerId: ref('ncm'),
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async () => discoveryPage([1]),
    fetchHighQualityPlaylists: async (_providerId, _cat, _limit, before = 0) => {
      beforeValues.push(before)
      if (before === 0) {
        return { items: [playlist(11)], total: 2, hasMore: true, lasttime: 1800 }
      }
      return { items: [playlist(12)], total: 2, hasMore: false, lasttime: 1600 }
    }
  })

  await discovery.ensureLoaded()
  discovery.toggleHighQuality()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [11]
  )

  await discovery.loadMore()
  assert.deepEqual(beforeValues, [0, 1800])
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [11, 12]
  )
  assert.equal(discovery.hasMore.value, false)

  await discovery.loadMore()
  assert.deepEqual(beforeValues, [0, 1800])
})

test('list errors populate listError and retry refetches from the start', async () => {
  let fail = true
  let offsetSeen: number | undefined
  const discovery = useStreamingDiscovery({
    providerId: ref('ncm'),
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (_providerId, _cat, _order, _limit, offset) => {
      if (fail) throw new Error('网络异常')
      offsetSeen = offset
      return discoveryPage([5], offset ?? 0)
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  await discovery.ensureLoaded()
  assert.equal(discovery.listError.value, '网络异常')
  assert.deepEqual(discovery.playlists.value, [] as NcmPlaylistSummary[])

  fail = false
  discovery.retry()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(discovery.listError.value, '')
  assert.equal(offsetSeen, 0)
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [5]
  )
})

test('switching providers resets filters and loads the new provider without stale results', async () => {
  const providerId = ref('alpha')
  const calls: string[] = []
  const discovery = useStreamingDiscovery({
    providerId,
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (source) => {
      calls.push(source)
      return discoveryPage([source === 'alpha' ? 1 : 2])
    }
  })

  await discovery.ensureLoaded()
  discovery.selectedTag.value = '欧美'
  providerId.value = 'beta'
  await new Promise((resolve) => setTimeout(resolve, 0))
  await discovery.ensureLoaded()

  assert.deepEqual(calls, ['alpha', 'beta'])
  assert.equal(discovery.selectedTag.value, '全部')
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2]
  )
})

test('switching away and back cannot accept the first provider catalogue request', async () => {
  const providerId = ref('alpha')
  let resolveOld!: (value: typeof catalogueFixture) => void
  let alphaCalls = 0
  const current = { ...catalogueFixture, hotTags: ['new catalogue'] }
  const discovery = useStreamingDiscovery({
    providerId,
    fetchDiscoveryPlaylists: async () => discoveryPage([1]),
    fetchPlaylistCategories: async (provider) => {
      if (provider === 'alpha' && ++alphaCalls === 1) {
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      }
      return current
    }
  })
  await discovery.ensureLoaded()
  providerId.value = 'beta'
  await nextTick()
  await discovery.ensureLoaded()
  providerId.value = 'alpha'
  await nextTick()
  await discovery.ensureLoaded()
  resolveOld(catalogueFixture)
  await nextTick()
  assert.deepEqual(discovery.catalogue.value?.hotTags, ['new catalogue'])
  assert.equal(discovery.catalogueLoading.value, false)
})

for (const replacement of ['tag', 'retry', 'quality', 'provider'] as const) {
  test(`${replacement} replacement releases a superseded high-quality append`, async () => {
    const providerId = ref('alpha')
    let resolveAppend!: (value: {
      items: NcmPlaylistSummary[]
      total: number
      hasMore: boolean
      lasttime: number
    }) => void
    let rejectAppend!: (error: Error) => void
    let appendCalls = 0
    const discovery = useStreamingDiscovery({
      providerId,
      fetchDiscoveryPlaylists: async () => discoveryPage([90]),
      fetchHighQualityPlaylists: async (_providerId, _cat, _limit, before = 0) => {
        if (before > 0) {
          appendCalls += 1
          if (appendCalls === 1) {
            return new Promise((resolve, reject) => {
              resolveAppend = resolve
              rejectAppend = reject
            })
          }
          return { items: [playlist(3)], total: 3, hasMore: false, lasttime: 100 }
        }
        return { items: [playlist(2)], total: 3, hasMore: true, lasttime: 200 }
      }
    })
    discovery.toggleHighQuality()
    await nextTick()
    const staleAppend = discovery.loadMore()
    assert.equal(discovery.loadingMore.value, true)

    if (replacement === 'tag') discovery.selectTag('欧美')
    if (replacement === 'retry') discovery.retry()
    if (replacement === 'quality') {
      discovery.toggleHighQuality()
      discovery.toggleHighQuality()
    }
    if (replacement === 'provider') {
      providerId.value = 'beta'
      await nextTick()
      discovery.toggleHighQuality()
    }
    await nextTick()
    assert.equal(discovery.loadingMore.value, false)
    assert.equal(discovery.listLoading.value, false)
    assert.equal(discovery.hasMore.value, true)

    // Old failures must not poison the replacement; old successes must not
    // append their previous category/provider into it.
    if (replacement === 'retry') rejectAppend(new Error('stale append failed'))
    else resolveAppend({ items: [playlist(99)], total: 1, hasMore: false, lasttime: 0 })
    await staleAppend
    assert.equal(discovery.loadingMore.value, false)
    assert.equal(discovery.listError.value, '')
    assert.deepEqual(
      discovery.playlists.value.map((item) => item.id),
      [2]
    )
    await discovery.loadMore()
    assert.equal(appendCalls, 2)
    assert.deepEqual(
      discovery.playlists.value.map((item) => item.id),
      [2, 3]
    )
  })
}

test('an old append finally cannot release a newer append owner', async () => {
  const pending: Array<
    (value: {
      items: NcmPlaylistSummary[]
      total: number
      hasMore: boolean
      lasttime: number
    }) => void
  > = []
  const discovery = useStreamingDiscovery({
    providerId: ref('ncm'),
    fetchDiscoveryPlaylists: async () => discoveryPage([1]),
    fetchHighQualityPlaylists: async (_providerId, _cat, _limit, before = 0) => {
      if (before === 0) return { items: [playlist(2)], total: 4, hasMore: true, lasttime: 200 }
      return new Promise((resolve) => pending.push(resolve))
    }
  })
  discovery.toggleHighQuality()
  await nextTick()
  const old = discovery.loadMore()
  discovery.selectTag('欧美')
  await nextTick()
  const newer = discovery.loadMore()
  pending[0]({ items: [playlist(99)], total: 4, hasMore: true, lasttime: 100 })
  await old
  assert.equal(discovery.loadingMore.value, true)
  pending[1]({ items: [playlist(3)], total: 4, hasMore: false, lasttime: 50 })
  await newer
  assert.equal(discovery.loadingMore.value, false)
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2, 3]
  )
})

test('unmount invalidates an append and releases both loading flags', async () => {
  let discovery!: ReturnType<typeof useStreamingDiscovery>
  let resolveAppend!: (value: {
    items: NcmPlaylistSummary[]
    total: number
    hasMore: boolean
    lasttime: number
  }) => void
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    setElementText() {},
    setText() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    parentNode: () => null,
    nextSibling: () => null
  })
  const app = renderer.createApp(
    defineComponent({
      setup() {
        discovery = useStreamingDiscovery({
          providerId: ref('ncm'),
          fetchDiscoveryPlaylists: async () => discoveryPage([1]),
          fetchHighQualityPlaylists: async (_providerId, _cat, _limit, before = 0) => {
            if (before === 0)
              return { items: [playlist(2)], total: 4, hasMore: true, lasttime: 200 }
            return new Promise((resolve) => {
              resolveAppend = resolve
            })
          }
        })
        return () => h('div')
      }
    })
  )
  app.mount({})
  discovery.toggleHighQuality()
  await nextTick()
  const pending = discovery.loadMore()
  app.unmount()
  assert.equal(discovery.loadingMore.value, false)
  assert.equal(discovery.listLoading.value, false)
  resolveAppend({ items: [playlist(99)], total: 1, hasMore: false, lasttime: 0 })
  await pending
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2]
  )
})
