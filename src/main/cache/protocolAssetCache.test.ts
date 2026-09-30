import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createProtocolAssetCache,
  type ProtocolAssetBytes,
  readCachedProtocolFile,
  resetProtocolAssetCacheForTests,
  setProtocolAssetCacheMaxBytesForTests
} from './protocolAssetCache.ts'

beforeEach(() => {
  resetProtocolAssetCacheForTests()
})

test('serves repeated reads from the in-memory cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-asset-cache-'))
  try {
    const filePath = join(dir, 'a.jpg')
    writeFileSync(filePath, Buffer.from([1, 2, 3]))
    const first = await readCachedProtocolFile(filePath)
    assert.deepEqual(first, Buffer.from([1, 2, 3]))
    rmSync(filePath)
    const second = await readCachedProtocolFile(filePath)
    assert.deepEqual(second, Buffer.from([1, 2, 3]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to later paths when earlier ones are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-asset-cache-'))
  try {
    const missing = join(dir, 'missing.jpg')
    const existing = join(dir, 'existing.jpg')
    writeFileSync(existing, Buffer.from([9]))
    const data = await readCachedProtocolFile(missing, existing)
    assert.deepEqual(data, Buffer.from([9]))
    assert.equal(await readCachedProtocolFile(missing), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evicts oldest entries beyond the byte budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-asset-cache-'))
  try {
    setProtocolAssetCacheMaxBytesForTests(1)
    const firstPath = join(dir, 'first.jpg')
    const secondPath = join(dir, 'second.jpg')
    writeFileSync(firstPath, Buffer.from([1]))
    writeFileSync(secondPath, Buffer.from([2]))
    await readCachedProtocolFile(firstPath)
    await readCachedProtocolFile(secondPath)
    rmSync(firstPath)
    rmSync(secondPath)
    assert.equal(await readCachedProtocolFile(firstPath), null)
    assert.deepEqual(await readCachedProtocolFile(secondPath), Buffer.from([2]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('oversized assets are served without retention or eviction of useful small assets', async () => {
  let reads = 0
  const cache = createProtocolAssetCache({
    maxBytes: 2,
    read: async (path) => {
      reads++
      return Buffer.alloc(path === 'large' ? 3 : 1)
    }
  })
  await cache.read('small')
  await cache.read('large')
  assert.deepEqual(cache.stats(), { cachedBytes: 1, cachedEntries: 1, pendingReads: 0 })
  await cache.read('small')
  await cache.read('large')
  assert.equal(reads, 3)
})

test('entry limit also bounds zero-byte assets and keeps recently read entries', async () => {
  let reads = 0
  const cache = createProtocolAssetCache({
    maxBytes: 100,
    maxEntries: 2,
    read: async () => {
      reads++
      return Buffer.alloc(0)
    }
  })
  await cache.read('a')
  await cache.read('b')
  await cache.read('a')
  await cache.read('c')
  assert.deepEqual(cache.stats(), { cachedBytes: 0, cachedEntries: 2, pendingReads: 0 })
  await cache.read('a')
  assert.equal(reads, 3)
  await cache.read('b')
  assert.equal(reads, 4)
})

test('pending reads coalesce and failed reads can retry', async () => {
  let resolve!: (bytes: ProtocolAssetBytes) => void
  let reads = 0
  const cache = createProtocolAssetCache({
    read: async () => {
      reads++
      if (reads === 1) throw new Error('missing')
      return new Promise<ProtocolAssetBytes>((done) => {
        resolve = done
      })
    }
  })
  assert.equal(await cache.read('a'), null)
  const requests = [cache.read('a'), cache.read('a'), cache.read('a')]
  resolve(Buffer.from('ok'))
  assert.equal(
    (await Promise.all(requests)).every((bytes) => bytes?.toString() === 'ok'),
    true
  )
  assert.equal(reads, 2)
  assert.equal(cache.stats().pendingReads, 0)
})

test('clearing during reads prevents stale reinsertion and stale cleanup of a new request', async () => {
  const complete: Array<(bytes: ProtocolAssetBytes) => void> = []
  const cache = createProtocolAssetCache({
    read: async () =>
      new Promise<ProtocolAssetBytes>((resolve) => {
        complete.push(resolve)
      })
  })
  const old = cache.read('a')
  cache.clear()
  const fresh = cache.read('a')
  complete[0](Buffer.from('old'))
  await old
  assert.deepEqual(cache.stats(), { cachedBytes: 0, cachedEntries: 0, pendingReads: 1 })
  const coalesced = cache.read('a')
  assert.equal(complete.length, 2)
  complete[1](Buffer.from('fresh'))
  assert.equal((await fresh)?.toString(), 'fresh')
  assert.equal((await coalesced)?.toString(), 'fresh')
  assert.equal((await cache.read('a'))?.toString(), 'fresh')
})
