import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import type { ProviderInfo } from '../../stores/useProviderStore'
import type { Track } from '../../types/music'
import { useOnlineHome } from './useOnlineHome.ts'

function provider(id = 'ncm'): ProviderInfo {
  return {
    id,
    name: id,
    capabilities: ['playbackUrl', 'login'],
    supportedMethods: ['daily', 'fetchRecommendPlaylists', 'fetchDiscoveryPlaylists'],
    ui: {
      icon: 'pi pi-cloud',
      authType: 'qr',
      streamingSections: [{ id: 'daily', title: '每日推荐', icon: 'pi pi-music', method: 'daily' }]
    }
  }
}
const track = (id: string) => ({ id, title: id, source: 'ncm' }) as Track
const playlist = (id: number) => ({ id, name: `歌单 ${id}`, cover: null, trackCount: 10 })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
function setup(
  options: {
    sources?: ProviderInfo[]
    loggedIn?: boolean
    call?: (id: string, method: string, args?: unknown[]) => Promise<unknown>
  } = {}
) {
  const scope = effectScope()
  const providers = ref(options.sources ?? [provider()])
  const preferred = ref('ncm')
  const calls: string[] = []
  const home = scope.run(() =>
    useOnlineHome({
      providers,
      preferredProvider: preferred,
      checkLogin: async () => ({ loggedIn: options.loggedIn ?? false, profile: null }),
      callProvider: async <T>(id: string, method: string, args?: unknown[]) => {
        calls.push(`${id}:${method}`)
        return (await (options.call?.(id, method, args) ??
          Promise.resolve(
            method === 'fetchDiscoveryPlaylists'
              ? { items: [playlist(1)] }
              : method === 'daily'
                ? [track(id)]
                : []
          ))) as T
      }
    })
  )!
  return { scope, providers, preferred, calls, home }
}

test('signed-out home loads public discovery without requesting personalized endpoints', async () => {
  const state = setup()
  try {
    await settle()
    assert.deepEqual(state.calls, ['ncm:fetchDiscoveryPlaylists'])
    assert.equal(state.home.loggedIn.value, false)
    assert.equal(state.home.playlists.value[0].id, 1)
    assert.equal(state.home.playlistTitle.value, '发现好歌单')
  } finally {
    state.scope.stop()
  }
})

test('signed-in home bounds recommendations and passes provider section arguments', async () => {
  const source = provider()
  source.ui!.streamingSections![0].args = ['seed']
  const state = setup({
    loggedIn: true,
    sources: [source],
    call: async (_id, method, args) => {
      if (method === 'daily') {
        assert.deepEqual(args, ['seed'])
        return Array.from({ length: 40 }, (_, index) => track(String(index)))
      }
      return Array.from({ length: 20 }, (_, index) => playlist(index))
    }
  })
  try {
    await settle()
    assert.equal(state.home.tracks.value.length, 12)
    assert.equal(state.home.playlists.value.length, 6)
    assert.equal(state.home.sectionTitle.value, '每日推荐')
    assert.equal(state.home.loading.value, false)
  } finally {
    state.scope.stop()
  }
})

test('partial failures preserve tracks and fall back to public playlists; retry recovers', async () => {
  let failed = true
  const state = setup({
    loggedIn: true,
    call: async (_id, method) => {
      if (method === 'daily') return [track('daily')]
      if (method === 'fetchRecommendPlaylists') {
        if (failed) throw new Error('fetch failed')
        return [playlist(2)]
      }
      return { items: [playlist(1)] }
    }
  })
  try {
    await settle()
    assert.equal(state.home.tracks.value[0].id, 'daily')
    assert.equal(state.home.playlists.value[0].id, 1)
    assert.ok(state.home.error.value)
    failed = false
    await state.home.reload()
    assert.equal(state.home.error.value, '')
    assert.equal(state.home.playlists.value[0].id, 2)
  } finally {
    state.scope.stop()
  }
})

test('switching provider discards an older result and health polling does not reload content', async () => {
  let release!: (value: unknown) => void
  const state = setup({
    sources: [provider(), provider('other')],
    call: async (id) => {
      if (id === 'ncm')
        return new Promise((resolve) => {
          release = resolve
        })
      return { items: [playlist(2)] }
    }
  })
  try {
    await settle()
    state.preferred.value = 'other'
    await settle()
    release({ items: [playlist(1)] })
    await settle()
    assert.equal(state.home.playlists.value[0].id, 2)
    state.providers.value = state.providers.value.map((item) => ({ ...item }))
    await settle()
    assert.deepEqual(state.calls, ['ncm:fetchDiscoveryPlaylists', 'other:fetchDiscoveryPlaylists'])
  } finally {
    state.scope.stop()
  }
})

test('removing providers clears online content without persisting an availability fallback', async () => {
  const state = setup()
  try {
    await settle()
    state.providers.value = []
    await nextTick()
    assert.equal(state.home.provider.value, null)
    assert.deepEqual(state.home.playlists.value, [])
    assert.equal(state.home.loading.value, false)
    assert.equal(state.preferred.value, 'ncm')
  } finally {
    state.scope.stop()
  }
})

test('guest-capable providers load public sections while skipping locked sections', async () => {
  const source = provider('guest')
  source.ui!.streamingHome = { requiresLogin: false }
  source.ui!.streamingSections!.unshift({
    id: 'locked',
    title: '专属',
    icon: '',
    method: 'locked',
    requiresLogin: true
  })
  source.supportedMethods.push('locked')
  const state = setup({ sources: [source] })
  try {
    await settle()
    assert.ok(state.calls.includes('guest:daily'))
    assert.ok(!state.calls.includes('guest:locked'))
  } finally {
    state.scope.stop()
  }
})

test('unmount discards in-flight content and prevents follow-up discovery requests', async () => {
  let release!: (value: unknown) => void
  const state = setup({
    loggedIn: true,
    call: async (_id, method) => {
      if (method === 'daily') return []
      return new Promise((resolve) => {
        release = resolve
      })
    }
  })
  await settle()
  state.scope.stop()
  release([])
  await settle()
  assert.deepEqual(state.home.playlists.value, [])
  assert.ok(!state.calls.some((call) => call.includes('fetchDiscoveryPlaylists')))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

test('same-provider refresh retains one snapshot until both sections settle', async () => {
  let refreshing = false
  const songs = deferred<Track[]>()
  const collections = deferred<ReturnType<typeof playlist>[]>()
  const state = setup({
    loggedIn: true,
    call: async (_id, method) =>
      method === 'daily'
        ? refreshing
          ? songs.promise
          : [track('old')]
        : refreshing
          ? collections.promise
          : [playlist(1)]
  })
  try {
    await settle()
    const oldTracks = state.home.tracks.value
    const oldPlaylists = state.home.playlists.value
    refreshing = true
    const request = state.home.reload()
    assert.equal(state.home.loading.value, true)
    assert.equal(state.home.loggedIn.value, true)
    assert.equal(state.home.tracks.value, oldTracks)
    assert.equal(state.home.playlists.value, oldPlaylists)
    songs.resolve([track('new')])
    await settle()
    assert.equal(state.home.tracks.value, oldTracks, 'Do not expose a half-refreshed snapshot')
    collections.resolve([playlist(2)])
    await request
    assert.equal(state.home.loading.value, false)
    assert.equal(state.home.tracks.value[0].id, 'new')
    assert.equal(state.home.playlists.value[0].id, 2)
  } finally {
    state.scope.stop()
  }
})

test('failed refresh sections keep their last results while successful sections commit', async () => {
  let phase = 'initial'
  const state = setup({
    loggedIn: true,
    call: async (_id, method) => {
      if (phase === 'all-fail' || (phase === 'songs-fail' && method === 'daily'))
        throw new Error('refresh failed')
      return method === 'daily' ? [track('old')] : [playlist(phase === 'initial' ? 1 : 2)]
    }
  })
  try {
    await settle()
    phase = 'songs-fail'
    await state.home.reload()
    assert.equal(state.home.tracks.value[0].id, 'old')
    assert.equal(state.home.playlists.value[0].id, 2)
    assert.equal(state.home.sectionTitle.value, '每日推荐')
    assert.ok(state.home.error.value)
    phase = 'all-fail'
    await state.home.reload()
    assert.equal(state.home.tracks.value[0].id, 'old')
    assert.equal(state.home.playlists.value[0].id, 2)
    assert.equal(state.home.playlistTitle.value, '精选歌单')
    assert.equal(state.home.loading.value, false)
  } finally {
    state.scope.stop()
  }
})

test('successful empty refresh replaces retained recommendations with the empty state', async () => {
  let empty = false
  const state = setup({
    loggedIn: true,
    call: async (_id, method) => {
      if (method === 'fetchDiscoveryPlaylists') return { items: [] }
      if (empty) return []
      return method === 'daily' ? [track('old')] : [playlist(1)]
    }
  })
  try {
    await settle()
    empty = true
    await state.home.reload()
    assert.deepEqual(state.home.tracks.value, [])
    assert.deepEqual(state.home.playlists.value, [])
    assert.equal(state.home.error.value, '')
    assert.equal(state.home.playlistTitle.value, '发现好歌单')
  } finally {
    state.scope.stop()
  }
})

test('a failed recommendation request without public fallback retains the prior playlist snapshot', async () => {
  const source = provider()
  source.supportedMethods = ['daily', 'fetchRecommendPlaylists']
  let failed = false
  const state = setup({
    loggedIn: true,
    sources: [source],
    call: async (_id, method) => {
      if (method === 'daily') return [track('daily')]
      if (failed) throw new Error('network unavailable')
      return [playlist(1)]
    }
  })
  try {
    await settle()
    const prior = state.home.playlists.value
    failed = true
    await state.home.reload()
    assert.equal(state.home.playlists.value, prior)
    assert.equal(state.home.playlistTitle.value, '精选歌单')
    assert.ok(state.home.error.value)
  } finally {
    state.scope.stop()
  }
})

test('provider switch synchronously clears stale actions while the next provider loads', async () => {
  const pending = deferred<ReturnType<typeof playlist>[]>()
  const state = setup({
    loggedIn: true,
    sources: [provider(), provider('other')],
    call: async (id, method) => {
      if (id === 'other') return method === 'daily' ? [] : pending.promise
      return method === 'daily' ? [track('old')] : [playlist(1)]
    }
  })
  try {
    await settle()
    assert.equal(state.home.tracks.value.length, 1)
    state.preferred.value = 'other'
    assert.equal(
      state.home.tracks.value.length,
      0,
      'No old tracks may be acted on with a new provider'
    )
    assert.equal(state.home.playlists.value.length, 0)
    assert.equal(state.home.loading.value, true)
    pending.resolve([playlist(2)])
    await settle()
    assert.equal(state.home.playlists.value[0].id, 2)
  } finally {
    state.scope.stop()
  }
})

test('newer same-provider refresh wins over an older request without losing its snapshot', async () => {
  let pending: ReturnType<typeof deferred<ReturnType<typeof playlist>[]>> | null = null
  const state = setup({
    call: async () => ({ items: pending ? await pending.promise : [playlist(1)] })
  })
  try {
    await settle()
    const older = deferred<ReturnType<typeof playlist>[]>()
    pending = older
    const oldRequest = state.home.reload()
    await settle()
    const newer = deferred<ReturnType<typeof playlist>[]>()
    pending = newer
    const newRequest = state.home.reload()
    await settle()
    newer.resolve([playlist(3)])
    await newRequest
    older.resolve([playlist(2)])
    await oldRequest
    assert.equal(state.home.playlists.value[0].id, 3)
    assert.equal(state.home.loading.value, false)
  } finally {
    state.scope.stop()
  }
})
