import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMetadataArtworkCache } from './metadataArtworkCache.ts'
import {
  createRemoteMediaRequestHandler,
  RemoteMediaGrantService
} from '../security/remoteMediaGrants.ts'

test('saved metadata bitmaps survive seven-day TTL and restart, usable offline only with a valid grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'te-metadata-art-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let enabled = true,
    calls = 0
  const directory = () => (enabled ? root : null)
  const source = 'https://example.com/artist.jpg'
  const first = createMetadataArtworkCache(directory, {
    fetch: async () => {
      calls++
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
    }
  })
  await first.retain(source, new AbortController().signal)
  const folder = join(root, 'metadata-artwork'),
    old = new Date(Date.now() - 60 * 86400000)
  for (const file of await readdir(folder)) await utimes(join(folder, file), old, old)
  const restarted = createMetadataArtworkCache(directory, {
    fetch: async () => {
      throw Error('offline')
    }
  })
  await restarted.retain(source, new AbortController().signal)
  const grants = new RemoteMediaGrantService({ now: () => 1000 })
  const handler = createRemoteMediaRequestHandler({
    grants,
    imageCache: restarted,
    fetch: async () => {
      throw Error('offline')
    }
  })
  const response = await handler(new Request(grants.grant(source, 'image')))
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3])
  assert.equal(calls, 1)
  assert.equal((await handler(new Request('twilight-media://image/unknown'))).status, 403)
  // Expiring permissions cannot read the durable store, even for the same URL.
  assert.equal((await handler(new Request(grants.grant(source, 'image', 1001)))).status, 502)
  enabled = false
  assert.equal(await restarted.read(source), null)
})

test('metadata persistence obeys upstream no-store and fences late writes across clear', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'te-metadata-art-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let release!: (r: Response) => void
  const source = 'https://example.com/artist.jpg'
  const cache = createMetadataArtworkCache(() => root, {
    fetch: () =>
      new Promise<Response>((resolve) => {
        release = resolve
      })
  })
  const pending = cache.retain(source, new AbortController().signal)
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  await cache.maintain(async () => {})
  release(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }))
  await pending
  assert.equal(await cache.read(source), null)
  const noStore = createMetadataArtworkCache(() => root, {
    fetch: async () =>
      new Response(new Uint8Array([2]), {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }
      })
  })
  await noStore.retain(source, new AbortController().signal)
  assert.equal(await noStore.read(source), null)
})
