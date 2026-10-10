import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, ref } from 'vue'
import type { ProviderInfo } from '../../stores/useProviderStore'
import type { MediaProviderToplistSummary } from '../../providers/mediaProvider'
import type { Track } from '../../types/music'
import { useNcmToplists } from './useNcmToplists.ts'

const source: ProviderInfo = {
  id: 'ncm',
  name: '网易云音乐',
  capabilities: ['playlist'],
  supportedMethods: ['fetchToplists', 'fetchPlaylistTracks']
}
const chart = (id: number): MediaProviderToplistSummary => ({
  id,
  name: `榜单 ${id}`,
  cover: null,
  trackCount: 3,
  previewTracks: []
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
function setup(call: (method: string, args: unknown[]) => Promise<unknown>) {
  const scope = effectScope()
  const providers = ref([source])
  const home = scope.run(() =>
    useNcmToplists({
      providers,
      callProvider: async <T>(id: string, method: string, args: unknown[] = []) => {
        assert.equal(id, 'ncm')
        return (await call(method, args)) as T
      }
    })
  )!
  return { scope, providers, home }
}

test('home requests one public summary, prioritizes official charts and ignores health polling', async () => {
  const calls: string[] = []
  const state = setup(async (method, args) => {
    calls.push(method)
    assert.deepEqual(args, [false])
    return [chart(42), chart(3778678), chart(2884035), chart(3779629), chart(19723756)]
  })
  try {
    await settle()
    assert.deepEqual(calls, ['fetchToplists'])
    assert.deepEqual(
      state.home.featured.value.map((item) => item.id),
      [19723756, 3779629, 2884035, 3778678]
    )
    state.providers.value = [{ ...source, health: { available: true } as ProviderInfo['health'] }]
    await settle()
    assert.equal(calls.length, 1)
  } finally {
    state.scope.stop()
  }
})

test('refresh preserves a usable snapshot on failure and retry replaces it', async () => {
  let failed = false
  const state = setup(async () => {
    if (failed) throw new Error('network unavailable')
    return [chart(1)]
  })
  try {
    await settle()
    failed = true
    await state.home.reload()
    assert.equal(state.home.charts.value[0].id, 1)
    assert.ok(state.home.error.value)
    failed = false
    await state.home.reload()
    assert.equal(state.home.error.value, '')
  } finally {
    state.scope.stop()
  }
})

test('closing or switching charts discards old detail responses and forces fresh playlist data', async () => {
  const resolvers: Array<(tracks: Track[]) => void> = []
  const state = setup(async (method, args) => {
    if (method === 'fetchToplists') return [chart(1), chart(2)]
    assert.equal(args[1], true)
    return new Promise<Track[]>((resolve) => resolvers.push(resolve))
  })
  try {
    await settle()
    const first = state.home.open(chart(1))
    const second = state.home.open(chart(2))
    resolvers[0]([{ id: 'old' } as Track])
    assert.equal(await first, null)
    assert.equal(state.home.selected.value?.id, 2)
    state.home.close()
    resolvers[1]([{ id: 'closed' } as Track])
    assert.equal(await second, null)
    assert.equal(state.home.tracks.value.length, 0)
    assert.equal(state.home.detailLoading.value, false)
  } finally {
    state.scope.stop()
  }
})

test('provider removal and scope disposal prevent late network results from returning', async () => {
  let resolve!: (items: MediaProviderToplistSummary[]) => void
  const state = setup(
    async () =>
      new Promise<MediaProviderToplistSummary[]>((done) => {
        resolve = done
      })
  )
  state.providers.value = []
  resolve([chart(1)])
  await settle()
  assert.equal(state.home.available.value, false)
  assert.equal(state.home.charts.value.length, 0)
  state.providers.value = [source]
  state.scope.stop()
  resolve([chart(2)])
  await settle()
  assert.equal(state.home.charts.value.length, 0)
})
