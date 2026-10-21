import assert from 'node:assert/strict'
import test from 'node:test'
import { createLibraryCompatibilityRefresh } from './libraryCompatibilityRefresh.ts'

test('scan revision storms do not reload full documents; pause/cancel flushes one authoritative snapshot', async () => {
  let revision = 1,
    scanning = true,
    reads = 0
  const refresh = createLibraryCompatibilityRefresh({
    getRevision: () => revision,
    isScanning: () => scanning,
    refresh: async (required) => {
      reads++
      return (revision = required)
    },
    onError() {}
  })
  await Promise.all(Array.from({ length: 1000 }, (_, index) => refresh.notify(index + 2)))
  assert.equal(reads, 0)
  scanning = false
  await refresh.flush()
  assert.equal(reads, 1)
  assert.equal(revision, 1001)
  await refresh.notify(5)
  assert.equal(reads, 1)
})

test('one slow read and one latest demand replace a notification backlog', async () => {
  let revision = 0,
    reads = 0
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const refresh = createLibraryCompatibilityRefresh({
    getRevision: () => revision,
    isScanning: () => false,
    refresh: async (required) => {
      if (++reads === 1) await hold
      return (revision = required)
    },
    onError() {}
  })
  const first = refresh.notify(1)
  await Promise.resolve()
  const latest = refresh.notify(100)
  assert.equal(first, latest)
  assert.equal(refresh.notify(50), first)
  release()
  await latest
  assert.equal(reads, 2)
  assert.equal(revision, 100)
})

test('failed or stale reads keep the old snapshot and expose an explicit retry, never a rescan', async () => {
  let revision = 1,
    fail = true,
    error = '',
    reads = 0
  const refresh = createLibraryCompatibilityRefresh({
    getRevision: () => revision,
    isScanning: () => false,
    refresh: async (required) => {
      reads++
      if (fail) throw new Error('worker unavailable')
      return (revision = required)
    },
    onError: (value) => {
      error = value
    }
  })
  await assert.rejects(refresh.notify(3), /worker unavailable/)
  assert.equal(error, 'worker unavailable')
  assert.equal(revision, 1)
  assert.equal(reads, 1)
  fail = false
  await refresh.flush()
  assert.equal(revision, 3)
  assert.equal(error, '')
  const stale = createLibraryCompatibilityRefresh({
    getRevision: () => 0,
    isScanning: () => false,
    refresh: async () => 0,
    onError() {}
  })
  await assert.rejects(stale.notify(2), /快照版本过旧/)
  await assert.rejects(stale.notify(Number.NaN), /无效的曲库版本/)
})
