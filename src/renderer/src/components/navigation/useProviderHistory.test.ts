import assert from 'node:assert/strict'
import test from 'node:test'
import { useProviderHistory } from './useProviderHistory.ts'
import type { Track } from '@renderer/types/music'

function deferred() {
  let resolve!: (tracks: Track[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Track[]>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('a late response or error cannot replace the selected platform history', async () => {
  const old = deferred(),
    latest = deferred()
  const history = useProviderHistory((id) => (id === 'old' ? old.promise : latest.promise))
  const first = history.load('old'),
    second = history.load('latest')
  const tracks = [{ id: 'latest', source: 'latest' }] as Track[]
  latest.resolve(tracks)
  await second
  old.reject(new Error('old failure'))
  await first
  assert.equal(history.tracks.value, tracks)
  assert.equal(history.error.value, '')
  assert.equal(history.loading.value, false)
})

test('leaving the platform view invalidates its request and failures remain explicit', async () => {
  const pending = deferred()
  const history = useProviderHistory(() => pending.promise)
  const loading = history.load('platform')
  history.invalidate()
  pending.resolve([{ id: 'old' }] as Track[])
  await loading
  assert.deepEqual(history.tracks.value, [])
  const failing = useProviderHistory(async () => {
    throw new Error('请先登录这个平台')
  })
  await failing.load('platform')
  assert.equal(failing.error.value, '请先登录这个平台')
  assert.deepEqual(failing.tracks.value, [])
})

test('reopening the same platform preserves displayed records while refreshing', async () => {
  const next = deferred()
  let calls = 0
  const tracks = [{ id: 'known', source: 'platform' }] as Track[]
  const history = useProviderHistory(async () => (++calls === 1 ? tracks : next.promise))
  await history.load('platform')
  history.invalidate(false)
  const refresh = history.load('platform')
  assert.equal(history.tracks.value, tracks)
  next.resolve(tracks)
  await refresh
})
