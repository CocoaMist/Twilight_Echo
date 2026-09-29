import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// Exercise the page handler without bundling or requiring an Electron window.
// Provider I/O and navigation are controlled; the function body is production code.
const source = readFileSync(new URL('./StreamingPage.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true)
const fn = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'removeStreamingTracks'
)!
const code = ts.transpileModule(fn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
const track = (id: number) => ({ id: `ncm:${id}`, ncmSongId: id })
const view = (id: string) => ({
  type: 'playlist',
  playlist: { id, name: id, owned: true, trackCount: 3 }
})

function fixture() {
  let finish!: () => void
  let fail!: (error: Error) => void
  const pending = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const currentDetail = { value: view('A') as ReturnType<typeof view> | null }
  const detailTracks = { value: [track(1), track(2), track(3)] }
  const errors: string[] = []
  const requests: unknown[] = []
  let cleared = 0
  let refreshed = 0
  const bindings = {
    canMutateCurrentNcmPlaylist: { value: true },
    currentDetail,
    detailTracks,
    detailLoadToken: 1,
    activeProvider: { value: 'ncm' },
    sessionCurrent: true,
    detailStack: {
      value: [] as Array<{
        view: ReturnType<typeof view>
        snapshot: { tracks: ReturnType<typeof track>[] }
      }>
    },
    detailError: { value: '' },
    detailLoading: { value: false },
    captureNcmSession: () => () => bindings.sessionCurrent,
    isActiveDetailLoad: (token: number) => token === bindings.detailLoadToken,
    window: { confirm: () => true },
    removeNcmTracksFromPlaylist: (id: string, tracks: number[]) => {
      requests.push({ id, tracks: [...tracks] })
      return pending
    },
    fetchPlaylistTracks: async () => {
      refreshed++
      return [track(7), track(8)]
    },
    replaceTopDetail: (next: ReturnType<typeof view>) => {
      currentDetail.value = next
    },
    clearSelection: () => {
      cleared++
    },
    pushNotice: () => {},
    setStreamingBatchRemovalError: (error: string) => errors.push(error),
    friendlyStreamingError: (error: Error, label: string) => `${label}: ${error.message}`
  }
  const remove = runInNewContext(`${code}\nremoveStreamingTracks`, bindings) as (
    tracks: ReturnType<typeof track>[]
  ) => Promise<void>
  return {
    bindings,
    remove,
    finish,
    fail,
    errors,
    requests,
    get cleared() {
      return cleared
    },
    get refreshed() {
      return refreshed
    }
  }
}

test('playlist removal never edits B or dereferences a closed detail', async () => {
  for (const destination of ['B', 'closed', 'provider', 'account']) {
    const f = fixture()
    const operation = f.remove([track(1)])
    f.bindings.detailLoadToken++
    f.bindings.currentDetail.value = destination === 'closed' ? null : view('B')
    if (destination === 'provider') f.bindings.activeProvider.value = 'other'
    if (destination === 'account') f.bindings.sessionCurrent = false
    await Promise.resolve()
    f.finish()
    await operation
    assert.deepEqual(f.requests, [{ id: 'A', tracks: [1] }])
    assert.deepEqual(f.bindings.detailTracks.value, [track(1), track(2), track(3)])
    assert.deepEqual(f.errors, [])
    assert.equal(f.cleared, 0)
  }
})

test('A -> B -> A refreshes current data instead of applying the old response', async () => {
  const f = fixture()
  const operation = f.remove([track(1)])
  f.bindings.detailLoadToken += 2
  f.bindings.currentDetail.value = view('A')
  f.finish()
  await operation
  assert.equal(f.refreshed, 1)
  assert.equal(f.bindings.detailLoadToken, 4)
  assert.equal(f.bindings.detailLoading.value, false)
  assert.equal(f.bindings.currentDetail.value?.playlist.trackCount, 2)
  assert.deepEqual(f.bindings.detailTracks.value, [track(7), track(8)])
  assert.equal(f.cleared, 0)
})

test('removal updates the target navigation snapshot and deduplicates song IDs', async () => {
  const f = fixture()
  const operation = f.remove([track(1), track(1)])
  const cached = { view: view('A'), snapshot: { tracks: [track(1), track(2), track(3)] } }
  f.bindings.detailStack.value.push(cached)
  f.bindings.detailLoadToken++
  f.bindings.currentDetail.value = view('B')
  f.finish()
  await operation
  assert.deepEqual(f.requests, [{ id: 'A', tracks: [1] }])
  assert.deepEqual(cached.snapshot.tracks, [track(2), track(3)])
  assert.equal(cached.view.playlist.trackCount, 2)
})

test('same-view success updates count once; stale errors do not contaminate B', async () => {
  const f = fixture()
  const operation = f.remove([track(1), track(1)])
  f.finish()
  await operation
  assert.equal(f.bindings.currentDetail.value?.playlist.trackCount, 2)
  assert.equal(f.cleared, 1)
  const stale = fixture()
  const failed = stale.remove([track(1)])
  stale.bindings.detailLoadToken++
  stale.bindings.currentDetail.value = view('B')
  stale.fail(new Error('network error'))
  await failed
  assert.deepEqual(stale.errors, [])
})
