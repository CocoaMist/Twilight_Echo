import assert from 'node:assert/strict'
import test from 'node:test'
import { syncPluginProviders, useMediaProviders } from '../providers/index.ts'
import { useNcmStore, type NcmProfile } from './useNcmStore.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let handler: (method: string) => Promise<unknown> = async () => undefined
let chooseFiles: () => Promise<unknown[]> = async () => []
const provider = { id: 'ncm', name: 'Test NCM', capabilities: [], supportedMethods: [] }
let listProviders = async () => [provider]
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      providers: {
        list: () => listProviders(),
        call: async (_id: string, method: string) => handler(method)
      },
      ncmCloud: {
        onProgress: () => () => {},
        cancel: async () => true,
        chooseUploadFiles: () => chooseFiles()
      }
    }
  }
})
await syncPluginProviders()
const store = useNcmStore()
const account = (userId: number): NcmProfile => ({
  userId,
  nickname: String(userId),
  avatarUrl: '',
  signature: '',
  follows: 0,
  followeds: 0
})
const playlist = { id: 100, name: 'A private playlist', cover: null, trackCount: 5 }

test.beforeEach(() => {
  handler = async () => undefined
  store.setLogin(account(1))
})

test('NCM startup login waits for actual provider registration', async () => {
  await syncPluginProviders()
  const registry = useMediaProviders()
  await syncPluginProviders()
  registry.unregister('ncm')
  const registration = deferred<Array<typeof provider>>()
  listProviders = () => registration.promise
  let calls = 0
  handler = async () => {
    calls++
    return { loggedIn: true, profile: account(1) }
  }
  try {
    const restored = store.checkLogin()
    await Promise.resolve()
    assert.equal(calls, 0)
    registration.resolve([provider])
    assert.equal(await restored, true)
    assert.equal(calls, 1)
  } finally {
    listProviders = async () => [provider]
  }
})

test('current login and library results still update the active account', async () => {
  handler = async (method) =>
    method === 'checkLogin'
      ? { loggedIn: true, profile: account(2) }
      : { likedPlaylist: playlist, playlists: [playlist] }
  assert.equal(await store.checkLogin(), true)
  assert.equal(store.profile.value?.userId, 2)
  await store.fetchUserLibrary()
  assert.equal(store.libraryLoaded.value, true)
  assert.equal(store.userPlaylists.value[0].id, playlist.id)
})

async function pending<T>(method: string, run: () => Promise<T>) {
  const response = deferred<unknown>()
  const started = deferred<void>()
  handler = async (name) => {
    if (name !== method) return undefined
    started.resolve()
    return response.promise
  }
  const result = run()
  await started.promise
  return { result, response }
}

test('late library results cannot restore logged-out or previous-account data', async () => {
  for (const destination of ['logout', 'other-account', 'same-account-again']) {
    store.setLogin(account(1))
    const request = await pending('fetchUserLibrary', () => store.fetchUserLibrary())
    await store.logout()
    if (destination !== 'logout') store.setLogin(account(destination === 'other-account' ? 2 : 1))
    request.response.resolve({ likedPlaylist: playlist, playlists: [playlist] })
    await request.result
    assert.equal(store.libraryLoaded.value, false, destination)
    assert.deepEqual(store.userPlaylists.value, [], destination)
    assert.equal(store.likedPlaylist.value, null, destination)
    assert.equal(store.libraryLoading.value, false, destination)
  }
})

test('old errors and finally handlers do not clear a newer library request', async () => {
  const old = await pending('fetchUserLibrary', () => store.fetchUserLibrary())
  const latest = await pending('fetchUserLibrary', () => store.fetchUserLibrary(true))
  old.response.reject(new Error('old failure'))
  await assert.rejects(old.result, /old failure/)
  assert.equal(store.libraryLoading.value, true)
  assert.equal(store.libraryError.value, '')
  latest.response.resolve({ likedPlaylist: null, playlists: [playlist] })
  await latest.result
  assert.equal(store.libraryLoading.value, false)
  assert.equal(store.userPlaylists.value[0].id, playlist.id)
})

test('late login success/failure and logout completion preserve the newest login', async () => {
  for (const fail of [false, true]) {
    const old = await pending('checkLogin', () => store.checkLogin())
    store.setLogin(account(2))
    if (fail) old.response.reject(new Error('stale auth error'))
    else old.response.resolve({ loggedIn: true, profile: account(1) })
    await old.result
    assert.equal(store.profile.value?.userId, 2)
  }
  const old = await pending('logout', () => store.logout())
  assert.equal(store.isLoggedIn.value, false)
  store.setLogin(account(2))
  old.response.resolve(undefined)
  await old.result
  assert.equal(store.profile.value?.userId, 2)
})

test('provider removal and re-registration fences old library responses', async () => {
  const old = await pending('fetchUserLibrary', () => store.fetchUserLibrary())
  const registry = useMediaProviders()
  registry.unregister('ncm')
  await syncPluginProviders()
  old.response.resolve({ likedPlaylist: playlist, playlists: [playlist] })
  await old.result
  assert.equal(store.libraryLoaded.value, false)
  assert.deepEqual(store.userPlaylists.value, [])
})

test('late account mutations never modify the new account collections', async () => {
  const cases: Array<[string, () => Promise<unknown>, unknown]> = [
    ['likeTrack', () => store.likeTrack(9, true), undefined],
    ['fetchLikedTracks', () => store.fetchLikedTracks(), [{ ncmSongId: 9 }]],
    ['fetchLikedTracksPage', () => store.fetchLikedTracksPage(), { tracks: [{ ncmSongId: 9 }] }],
    ['createPlaylist', () => store.createPlaylist('A'), playlist],
    ['deletePlaylist', () => store.deletePlaylist(100), undefined],
    ['addTracksToPlaylist', () => store.addTracksToPlaylist(100, [9]), undefined],
    ['removeTracksFromPlaylist', () => store.removeTracksFromPlaylist(100, [9]), undefined]
  ]
  for (const [method, run, value] of cases) {
    store.setLogin(account(1))
    const old = await pending(method, run)
    store.setLogin(account(2))
    store.userPlaylists.value = [{ ...playlist, name: 'B', trackCount: 8 }]
    old.response.resolve(value)
    await old.result
    assert.equal(store.userPlaylists.value[0].name, 'B', method)
    assert.equal(store.userPlaylists.value[0].trackCount, 8, method)
    assert.equal(store.likedSongIds.value.size, 0, method)
  }
})

test('account changes discard a pending cloud file picker result', async () => {
  const files = deferred<unknown[]>()
  chooseFiles = () => files.promise
  const result = store.chooseCloudUploadFiles()
  store.setLogin(account(2))
  files.resolve([{ handle: 'account-a' }])
  assert.deepEqual(await result, [])
  assert.deepEqual(store.cloudSelectedFiles.value, [])
})
