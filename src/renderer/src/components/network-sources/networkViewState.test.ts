import assert from 'node:assert/strict'
import test from 'node:test'
import { isProxy } from 'vue'
import {
  createNetworkBrowser,
  createNetworkLibraryView,
  parseOptionalPort,
  type NetworkLibraryItem
} from './networkViewState.ts'
import type {
  NetworkEntry,
  NetworkSourceProfileSummary
} from '../../../../shared/networkSources.ts'
import type { CoreNetworkEntry, CoreNetworkPage } from '../../../../shared/coreNetwork.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function profile(id = 'p1'): NetworkSourceProfileSummary {
  return {
    id,
    protocol: 'webdav',
    name: id,
    host: 'nas.local',
    port: null,
    rootPath: '/music',
    credentialKind: 'anonymous',
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    options: {
      readOnly: true,
      connectTimeoutMs: 5000,
      transferTimeoutMs: 10000,
      maxConcurrentTransfers: 2
    }
  }
}
function entry(name: string): NetworkEntry {
  return { id: name, profileId: 'p1', name, kind: 'audio', path: `/music/${name}` }
}
function item(name: string): NetworkLibraryItem {
  return { profileId: 'p1', profileName: 'NAS', entry: entry(name) }
}
function directoryPage(items: CoreNetworkEntry[], offset = 0, total = items.length, revision = 1) {
  return { items, offset, total, revision, token: 'directory-token' }
}
function libraryPage(
  items: NetworkLibraryItem[],
  offset = 0,
  total = items.length,
  revision = 1
): CoreNetworkPage<CoreNetworkEntry & { profileName: string }> {
  return {
    items: items.map(({ entry, profileName }) => ({ ...entry, profileName })),
    offset,
    total,
    revision
  }
}

test('parseOptionalPort accepts number and string input without assuming string methods', () => {
  // `<input type="number">` hands `v-model` a number once the user types a value.
  assert.equal(parseOptionalPort(8080), 8080)
  assert.equal(parseOptionalPort(' 443 '), 443)
  assert.equal(parseOptionalPort(''), null)
  assert.equal(parseOptionalPort('   '), null)
  assert.equal(parseOptionalPort(null), null)
  assert.equal(parseOptionalPort(undefined), null)
})

test('parseOptionalPort rejects out-of-range and non-integer values', () => {
  for (const value of ['0', '65536', '80.5', 'abc', '-1']) {
    assert.throws(() => parseOptionalPort(value), /端口需为 1-65535 之间的整数/)
  }
})

test('directory responses cannot overwrite a newer path or finish its loading state', async () => {
  const requests: ReturnType<typeof deferred<ReturnType<typeof directoryPage>>>[] = []
  const browser = createNetworkBrowser(async () => {
    const request = deferred<ReturnType<typeof directoryPage>>()
    requests.push(request)
    return request.promise
  })
  const first = browser.enter(profile())
  const second = browser.navigateTo('/fast-B')
  requests[0].resolve(directoryPage([entry('A.flac')]))
  await first
  assert.equal(browser.loading.value, true)
  assert.equal(browser.entries.value.length, 0)
  requests[1].resolve(directoryPage([entry('B.flac')]))
  await second
  assert.equal(browser.path.value, '/fast-B')
  assert.equal(browser.entries.value[0].name, 'B.flac')
  assert.equal(browser.loading.value, false)
  assert.equal(isProxy(browser.entries.value[0]), false)
  browser.dispose()
})

test('late directory failures cannot clear a successful newer result', async () => {
  const old = deferred<ReturnType<typeof directoryPage>>()
  const browser = createNetworkBrowser(async (_id, path) =>
    path === '/music' ? old.promise : directoryPage([entry('B')])
  )
  const pending = browser.enter(profile())
  await browser.navigateTo('/B')
  old.reject(new Error('old failure'))
  await pending
  assert.equal(browser.error.value, '')
  assert.equal(browser.entries.value[0].name, 'B')
  browser.dispose()
})

test('leave, profile changes, A-to-B-to-A and disposal revoke old requests and contexts', async () => {
  const requests: ReturnType<typeof deferred<ReturnType<typeof directoryPage>>>[] = []
  const browser = createNetworkBrowser(async () => {
    const request = deferred<ReturnType<typeof directoryPage>>()
    requests.push(request)
    return request.promise
  })
  const first = browser.enter(profile('A'))
  const firstContext = browser.capture()
  browser.leave()
  assert.equal(firstContext(), false)
  const second = browser.enter(profile('B'))
  const third = browser.enter(profile('A'))
  requests[2].resolve(directoryPage([entry('current')]))
  await third
  requests[1].reject(new Error('B failure'))
  await second
  requests[0].resolve(directoryPage([entry('old A')]))
  await first
  assert.equal(browser.profile.value?.id, 'A')
  assert.equal(browser.entries.value[0].name, 'current')
  assert.equal(browser.error.value, '')
  const last = browser.navigateTo('/last')
  browser.dispose()
  requests[3].resolve(directoryPage([entry('disposed')]))
  await last
  assert.equal(browser.profile.value, null)
  assert.deepEqual(browser.entries.value, [])
  assert.equal(browser.loading.value, false)
})

test('latest library query wins and an earlier completion cannot clear loading', async () => {
  const requests: Array<{
    query: string | undefined
    request: ReturnType<
      typeof deferred<CoreNetworkPage<CoreNetworkEntry & { profileName: string }>>
    >
  }> = []
  const library = createNetworkLibraryView(async (query) => {
    const request = deferred<CoreNetworkPage<CoreNetworkEntry & { profileName: string }>>()
    requests.push({ query, request })
    return request.promise
  })
  library.query.value = 'a'
  const first = library.load()
  library.query.value = 'b'
  const second = library.load()
  requests[0].request.resolve(libraryPage([item('a')]))
  await first
  assert.equal(library.loading.value, true)
  requests[1].request.resolve(libraryPage([item('b')]))
  await second
  assert.deepEqual(
    requests.map((request) => request.query),
    ['a', 'b']
  )
  assert.equal(library.items.value[0].entry.name, 'b')
  assert.equal(isProxy(library.items.value[0].entry), false)
  library.dispose()
})

test('library late errors and results are ignored after leave and disposal', async () => {
  const requests: ReturnType<
    typeof deferred<CoreNetworkPage<CoreNetworkEntry & { profileName: string }>>
  >[] = []
  const library = createNetworkLibraryView(async () => {
    const request = deferred<CoreNetworkPage<CoreNetworkEntry & { profileName: string }>>()
    requests.push(request)
    return request.promise
  })
  const first = library.load()
  library.leave()
  requests[0].reject(new Error('old'))
  await first
  assert.equal(library.error.value, '')
  const second = library.load()
  library.dispose()
  requests[1].resolve(libraryPage([item('old')]))
  await second
  assert.deepEqual(library.items.value, [])
  assert.equal(library.loading.value, false)
})

test('search debounce coalesces keystrokes and disposal cancels a pending timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const queries: string[] = []
  const library = createNetworkLibraryView(async (query) => {
    queries.push(query ?? '')
    return libraryPage([item(query ?? '')])
  })
  for (const query of ['a', 'ab', 'abc']) {
    library.query.value = query
    library.schedule()
  }
  t.mock.timers.tick(149)
  assert.deepEqual(queries, [])
  t.mock.timers.tick(1)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(queries, ['abc'])
  assert.equal(library.items.value[0].entry.name, 'abc')
  library.query.value = 'abcd'
  library.schedule()
  library.dispose()
  t.mock.timers.tick(1000)
  assert.deepEqual(queries, ['abc'])
})

test('directory pages append with the Core token and retain the original revision', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => entry(`track-${index}`))
  const requests: Array<{ offset?: number; token?: string; revision?: number }> = []
  const browser = createNetworkBrowser(async (_id, _path, query) => {
    requests.push(query)
    return directoryPage(rows.slice(query.offset, (query.offset ?? 0) + 200), query.offset, 201, 8)
  })
  await browser.enter(profile())
  assert.equal(browser.entries.value.length, 200)
  assert.equal(browser.hasMore.value, true)
  await browser.loadMore()
  assert.equal(browser.entries.value.length, 201)
  assert.equal(browser.hasMore.value, false)
  assert.deepEqual(
    requests.map(({ offset, token, revision }) => ({ offset, token, revision })),
    [
      { offset: 0, token: undefined, revision: undefined },
      { offset: 200, token: 'directory-token', revision: 8 }
    ]
  )
  browser.dispose()
})

test('library pages append under the same query and revision', async () => {
  const requests: Array<{ query: string; offset?: number; revision?: number }> = []
  const library = createNetworkLibraryView(async (query, page) => {
    requests.push({ query, offset: page.offset, revision: page.revision })
    const offset = page.offset ?? 0
    return libraryPage([item(`row-${offset}`)], offset, 2, 11)
  })
  library.query.value = 'jazz'
  await library.load()
  assert.equal(library.items.value.length, 1)
  assert.equal(library.hasMore.value, true)
  await library.loadMore()
  assert.equal(library.items.value.length, 2)
  assert.deepEqual(requests, [
    { query: 'jazz', offset: 0, revision: undefined },
    { query: 'jazz', offset: 1, revision: 11 }
  ])
  library.dispose()
})
