import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { reactive } from 'vue'

const { MediaProviderRegistry, getProviderLocalId, getTrackProviderId, toProviderIpcArgs } =
  (await import(
    new URL('./mediaProvider.ts', import.meta.url).href
  )) as typeof import('./mediaProvider')

const { getNcmSongId } = (await import(
  new URL('./ncmTrack.ts', import.meta.url).href
)) as typeof import('./ncmTrack')

test('extracts provider prefixes from source or track id', () => {
  assert.equal(getTrackProviderId({ id: 'bili:BV1xx', source: undefined }), 'bili')
  assert.equal(getTrackProviderId({ id: 'ignored:123', source: 'ncm' }), 'ncm')
  assert.equal(getTrackProviderId({ id: 'D:\\Music\\track.flac', source: undefined }), null)
  assert.equal(getTrackProviderId({ id: '/Users/me/Music/track.flac', source: undefined }), null)
  assert.equal(getProviderLocalId('bili:BV1xx', 'bili'), 'BV1xx')
  assert.equal(getProviderLocalId('ncm:12345', 'bili'), null)
})

let providerList: () => Promise<unknown[]> = async () => []
let providerCall: (
  id: string,
  method: string,
  args: unknown[],
  requestId: string
) => Promise<unknown>
const pendingProviderCalls = new Map<string, (error: Error) => void>()
const cancelledProviderCalls: string[] = []
const providerCore: import('../../../shared/coreBridge.ts').CoreBridgeApi = {
  connect: async () => ({
    ok: true,
    value: {
      connectionId: 'providers',
      snapshot: {
        epoch: 'core',
        sequence: 0,
        protocolVersion: 1,
        phase: 'ready',
        pluginsRevision: 0
      } as import('../../../shared/coreProtocol.ts').CoreSnapshot
    }
  }),
  request: async (_id, request) => ({
    ok: true,
    value:
      request.name === 'providers.list'
        ? await providerList()
        : request.name === 'providers.call'
          ? await providerCall(
              request.payload.providerId,
              request.payload.method,
              request.payload.args,
              request.requestId
            )
          : undefined
  }),
  cancel: async (_id, requestId) => {
    cancelledProviderCalls.push(requestId)
    pendingProviderCalls.get(requestId)?.(new Error('cancelled'))
    pendingProviderCalls.delete(requestId)
    return { ok: true, value: undefined }
  },
  disconnect: async () => ({ ok: true, value: undefined }),
  onMessage: () => () => {},
  onStatus: () => () => {}
}
async function attachProviderCore() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { core: providerCore } }
  })
  const { useCoreConnection } = await import('../stores/coreConnection.ts')
  await useCoreConnection().attach()
}

test('album search registration follows advertised methods and forwards cancellation through Core', async (t) => {
  const { syncPluginProviders, useMediaProviders } = await import('./index.ts')
  let methods: string[] = []
  let hold = false
  const calls: unknown[][] = []
  providerList = async () => [
    { id: 'album-test', name: 'Albums', capabilities: ['search'], supportedMethods: methods }
  ]
  providerCall = async (id, method, args, requestId) => {
    calls.push([id, method, args, requestId])
    if (hold)
      return new Promise((_resolve, reject) => {
        pendingProviderCalls.set(requestId, reject)
      })
    return { items: [{ id: '1', name: 'Album', cover: null, trackCount: 1 }], total: 1 }
  }
  await attachProviderCore()
  const registry = useMediaProviders()
  t.after(() => {
    registry.unregister('album-test')
  })
  await syncPluginProviders()
  assert.equal(registry.get('album-test')?.searchAlbums, undefined)
  methods = ['searchAlbums']
  await syncPluginProviders()
  assert.equal((await registry.searchAlbums('album-test', 'Album', 30, 60)).total, 1)
  assert.deepEqual(calls[0].slice(0, 3), ['album-test', 'searchAlbums', ['Album', 30, 60]])
  hold = true
  const controller = new AbortController()
  const pending = registry.searchAlbums('album-test', 'Album', 30, 0, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.equal(cancelledProviderCalls.at(-1), calls[1][3])
  methods = []
  await syncPluginProviders()
  assert.equal(registry.get('album-test')?.searchAlbums, undefined)
})

test('playlist search follows the search contract without requiring playlist library access', async (t) => {
  const { syncPluginProviders, useMediaProviders } = await import('./index.ts')
  let methods: string[] = ['searchPlaylists']
  let hold = false
  const calls: unknown[][] = []
  providerList = async () => [
    {
      id: 'playlist-search-only',
      name: 'Collection search',
      capabilities: ['search'],
      supportedMethods: methods
    }
  ]
  providerCall = async (id, method, args, requestId) => {
    calls.push([id, method, args, requestId])
    if (hold)
      return new Promise((_resolve, reject) => {
        pendingProviderCalls.set(requestId, reject)
      })
    return { items: [{ id: 'mix', name: 'Evening', cover: null, trackCount: 12 }], total: 1 }
  }
  await attachProviderCore()
  const registry = useMediaProviders()
  t.after(() => {
    registry.unregister('playlist-search-only')
  })
  await syncPluginProviders()
  assert.equal((await registry.searchPlaylists('playlist-search-only', 'Evening', 20, 40)).total, 1)
  assert.deepEqual(calls[0].slice(0, 3), [
    'playlist-search-only',
    'searchPlaylists',
    ['Evening', 20, 40]
  ])
  assert.equal(registry.get('playlist-search-only')?.fetchPlaylistTracks, undefined)
  hold = true
  const controller = new AbortController()
  const pending = registry.searchPlaylists('playlist-search-only', 'Evening', 20, 0, {
    signal: controller.signal
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.equal(cancelledProviderCalls.at(-1), calls[1][3])
  methods = []
  await syncPluginProviders()
  assert.equal(registry.get('playlist-search-only')?.searchPlaylists, undefined)
  methods = ['searchPlaylists']
  hold = false
  await syncPluginProviders()
  assert.equal((await registry.searchPlaylists('playlist-search-only', 'Back')).total, 1)
})

test('provider cancellation uses the document Core connection without passing AbortSignal through preload', () => {
  const registry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const connection = readFileSync(new URL('../stores/coreConnection.ts', import.meta.url), 'utf8')
  const preload = readFileSync(
    new URL('../../../preload/domains/coreApi.ts', import.meta.url),
    'utf8'
  )
  assert.match(registry, /core\.command\(\s*'providers.call'/)
  assert.doesNotMatch(registry, /window\.api\.providers/)
  assert.match(connection, /signal\?\.addEventListener\('abort', cancel, \{ once: true \}\)/)
  assert.match(connection, /this\.api\.cancel\(id, request\.requestId\)/)
  assert.doesNotMatch(preload, /AbortSignal|addEventListener/)
})

test('normalizes NetEase song ids from legacy and prefixed tracks', () => {
  assert.equal(getNcmSongId({ id: 'ncm:123', ncmSongId: undefined }), 123)
  assert.equal(getNcmSongId({ id: 'ncm:123', ncmSongId: 456 }), 456)
  assert.equal(getNcmSongId({ id: 'bili:123', ncmSongId: undefined }), null)
})

test('normalizes reactive provider call args before IPC', () => {
  const track = reactive({
    id: 'bili:BV1xx:123',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    filePath: 'bili:BV1xx:123',
    fileName: 'Song',
    duration: 1,
    size: 0,
    cover: null,
    lyrics: null,
    source: 'bili',
    nested: reactive({ value: 'ok' })
  })

  assert.throws(() => structuredClone([track]), /could not be cloned/i)
  const args = toProviderIpcArgs([track])
  assert.deepEqual(structuredClone(args), args)
  assert.equal((args[0] as { nested: { value: string } }).nested.value, 'ok')
})

test('registry forwards unified search to Core without renderer source enumeration', async () => {
  const calls: unknown[] = []
  const page = { items: [], logicalItems: [], health: {}, total: 401, versionsRevision: 7 }
  const registry = new MediaProviderRegistry(async (...args) => { calls.push(args); return page })
  const controller = new AbortController()
  const result = await registry.searchAllSongs({query: 'moon', limit: 30, offset: 200, signal: controller.signal})
  assert.equal(result, page)
  assert.deepEqual(calls, [[{query:'moon',limit:30,offset:200}, controller.signal]])
})
test('registry updates provider health without replacing method handlers', async () => {
  const registry = new MediaProviderRegistry()
  registry.register({
    id: 'ncm',
    name: 'NetEase',
    source: 'plugin',
    capabilities: ['playbackUrl'],
    health: {
      providerId: 'ncm',
      pluginId: 'com.twilightecho.provider.ncm',
      pluginStatus: 'enabled',
      available: true,
      totalCalls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      successRate: 1,
      methodStats: {},
      lastError: null,
      lastCheckedAt: '2026-07-02T12:00:00.000Z'
    },
    getPlaybackUrl: async () => 'https://example.test/song.mp3'
  })

  const updated = registry.update('ncm', {
    health: {
      providerId: 'ncm',
      pluginId: 'com.twilightecho.provider.ncm',
      pluginStatus: 'enabled',
      available: false,
      totalCalls: 2,
      successfulCalls: 1,
      failedCalls: 1,
      successRate: 0.5,
      methodStats: {
        getPlaybackUrl: {
          totalCalls: 1,
          successfulCalls: 0,
          failedCalls: 1,
          successRate: 0,
          lastError: 'stream expired',
          lastCheckedAt: '2026-07-02T12:01:00.000Z'
        }
      },
      lastError: 'stream expired',
      lastCheckedAt: '2026-07-02T12:01:00.000Z'
    }
  })

  assert.equal(updated, true)
  assert.equal(registry.get('ncm')?.health?.available, false)
  assert.equal(
    registry.get('ncm')?.health?.methodStats?.getPlaybackUrl?.lastError,
    'stream expired'
  )
  assert.equal(registry.getGeneration('ncm'), 1, 'API health changes retain the plugin session')
  assert.equal(
    await registry.get('ncm')?.getPlaybackUrl?.({
      id: 'ncm:1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      filePath: 'ncm:1',
      fileName: 'Song',
      duration: 1,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    }),
    'https://example.test/song.mp3'
  )
})

test('plugin disable and re-enable still invalidate outstanding provider sessions', () => {
  const registry = new MediaProviderRegistry()
  registry.register({ id: 'ncm', name: 'NetEase', source: 'plugin', capabilities: ['login'] })
  const generation = registry.getGeneration('ncm')
  const health = {
    providerId: 'ncm',
    pluginId: 'com.twilightecho.provider.ncm',
    pluginStatus: 'disabled',
    available: false,
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    successRate: 1,
    lastError: null,
    lastCheckedAt: null
  }
  registry.update('ncm', { health })
  assert.equal(registry.getGeneration('ncm'), generation + 1)
  registry.update('ncm', { health: { ...health, pluginStatus: 'enabled', available: true } })
  assert.equal(registry.getGeneration('ncm'), generation + 2)
})

test('renderer provider sync carries host health into registered providers', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  assert.match(source, /health: provider\.health/)
  assert.match(source, /isEnabled: \(\) => isPluginProviderEnabled\(provider\.health\)/)
  assert.match(source, /mediaProviders\.update\(provider\.id/)
  assert.match(source, /fetchDiscoveryPlaylists: supports\('fetchDiscoveryPlaylists'\)/)
  assert.match(source, /fetchHighQualityPlaylists: supports\('fetchHighQualityPlaylists'\)/)
})

test('renderer provider calls refresh host health snapshots after IPC settles', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  assert.match(source, /async function refreshPluginProviderHealth\(\): Promise<void>/)
  assert.match(source, /void refreshPluginProviderHealth\(\)/)
  assert.match(source, /finally \{\s*void refreshPluginProviderHealth\(\)/)
})
