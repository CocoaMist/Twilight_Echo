import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAfterglowSourceResolver,
  authorizeAfterglowNativeSource
} from './afterglowSourceResolver.ts'
import { protectProviderMedia, RemoteMediaGrantService } from '../security/remoteMediaGrants.ts'

test('local queue entries resolve without touching a provider', async () => {
  let calls = 0
  const resolver = createAfterglowSourceResolver({
    callProvider: async () => {
      calls += 1
      return 'https://cdn.test/unused.flac'
    }
  })
  const resolved = await resolver.resolve({
    id: 'local:1',
    filePath: 'D:/Music/album/song.flac',
    source: 'local'
  })
  assert.deepEqual(resolved, { source: 'D:/Music/album/song.flac', expiresAt: null })
  assert.equal(calls, 0)
})

test('provider results normalize string and identity payloads', async () => {
  const now = 1_000_000
  const seen: Array<{ providerId: string; method: string; args: unknown[] }> = []
  const resolver = createAfterglowSourceResolver({
    now: () => now,
    quality: 'lossless',
    callProvider: async (providerId, method, args) => {
      seen.push({ providerId, method, args })
      return {
        streamUrl: 'https://cdn.test/song.flac?sig=1',
        providerSource: { expiresAt: now + 120_000 }
      }
    }
  })
  const resolved = await resolver.resolve({
    id: 'ncm:123',
    filePath: 'ncm:123',
    source: 'ncm'
  })
  assert.deepEqual(resolved, {
    source: 'https://cdn.test/song.flac?sig=1',
    expiresAt: now + 120_000
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].providerId, 'ncm')
  assert.equal(seen[0].method, 'getPlaybackUrl')
  assert.deepEqual(seen[0].args[1], { quality: 'lossless' })

  const stringResolver = createAfterglowSourceResolver({
    now: () => now,
    quality: 'auto',
    callProvider: async () => 'https://cdn.test/plain.flac'
  })
  const plain = await stringResolver.resolve({ id: 'ncm:2', source: 'ncm' })
  assert.deepEqual(plain, {
    source: 'https://cdn.test/plain.flac',
    expiresAt: now + 8 * 60_000
  })
})

test('local subtrack routing preserves SACD targets and CUE continues to use the physical file', async () => {
  const resolver = createAfterglowSourceResolver()
  const track = {
    id: 'local:iso',
    source: 'local',
    filePath: 'D:/Music/disc.iso',
    subTrack: 'D:/Music/disc.iso?area=stereo&track=2'
  }
  assert.equal((await resolver.resolve(track))?.source, track.subTrack)
  assert.equal(
    (
      await resolver.resolve({
        ...track,
        filePath: 'D:/Music/disc.flac',
        cueRange: { startSeconds: 90, endSeconds: 180 }
      })
    )?.source,
    'D:/Music/disc.flac'
  )
  const authorized: string[] = []
  const authorize = async (source: string) => {
    authorized.push(source)
    return source.replace('D:', 'E:')
  }
  assert.equal(
    await authorizeAfterglowNativeSource(track.subTrack, authorize),
    'E:/Music/disc.iso?area=stereo&track=2'
  )
  assert.deepEqual(authorized, ['D:/Music/disc.iso'])
  authorized.length = 0
  const malformed = `${track.filePath}?area=stereo&track=2&other=../../private`
  await authorizeAfterglowNativeSource(malformed, authorize)
  assert.deepEqual(
    authorized,
    [malformed],
    'a malformed selector cannot acquire a physical-container grant'
  )
})

test('provider failures and unissued media handles fail closed', async () => {
  const resolver = createAfterglowSourceResolver({
    quality: 'auto',
    callProvider: async () => ({ streamUrl: 'twilight-media://audio/token' })
  })
  assert.equal(await resolver.resolve({ id: 'ncm:3', source: 'ncm' }), null)

  const throwing = createAfterglowSourceResolver({
    quality: 'auto',
    callProvider: async () => {
      throw new Error('provider offline')
    }
  })
  assert.equal(await throwing.resolve({ id: 'ncm:4', source: 'ncm' }), null)
})

test('protected provider audio resolves through the same issued grant, without trusting other schemes or kinds', async () => {
  let now = 1_000
  let token = 0
  const grants = new RemoteMediaGrantService({
    now: () => now,
    createToken: () => `media-${++token}`
  })
  let response: unknown = protectProviderMedia(
    'https://cdn.test/track.flac',
    'getPlaybackUrl',
    grants
  )
  const resolver = createAfterglowSourceResolver({
    now: () => now,
    quality: 'auto',
    grants,
    callProvider: async () => response
  })
  const track = { id: 'ncm:3', source: 'ncm' }
  assert.deepEqual(await resolver.resolve(track), {
    source: 'https://cdn.test/track.flac',
    expiresAt: now + 8 * 60_000
  })
  now += 30 * 60_000 + 1
  assert.equal(await resolver.resolve(track), null, 'an expired grant is not native authority')
  response = grants.grant('https://cdn.test/cover.jpg', 'image')
  assert.equal(await resolver.resolve(track), null)
  for (const source of [
    'twilight-media://audio/forged',
    'javascript:alert(1)',
    'data:audio/flac,abc'
  ]) {
    response = source
    assert.equal(await resolver.resolve(track), null)
  }
})

test('known-expired provider URLs are rejected rather than receiving the unknown-expiry TTL', async () => {
  const now = 1_000_000
  let expiry = now - 1
  const resolver = createAfterglowSourceResolver({
    now: () => now,
    quality: 'auto',
    callProvider: async () => ({
      streamUrl: 'https://cdn.test/expired.flac',
      providerSource: { expiresAt: expiry }
    })
  })
  for (expiry of [now - 1, now, 0])
    assert.equal(await resolver.resolve({ id: 'ncm:4', source: 'ncm' }), null)
  expiry = now + 1
  assert.equal((await resolver.resolve({ id: 'ncm:4', source: 'ncm' }))?.expiresAt, expiry)
})

test('provider timeout aborts the underlying RPC and consumes an unsupported late reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined
  let reply!: (value: unknown) => void
  const resolver = createAfterglowSourceResolver({
    quality: 'auto',
    callProvider: async (_provider, _method, _args, options) => {
      signal = options.signal
      assert.equal(options.playbackExpiry, true)
      return new Promise((resolve) => {
        reply = resolve
      })
    }
  })
  const pending = resolver.resolve({ id: 'ncm:5', source: 'ncm' })
  await Promise.resolve()
  assert.equal(signal?.aborted, false)
  t.mock.timers.tick(12_000)
  assert.equal(await pending, null)
  assert.equal(signal?.aborted, true)
  reply('https://cdn.test/late.flac')
  await Promise.resolve()
})

test('cancelled preview cancels provider work and does not dispatch a pre-cancelled call', async () => {
  const controller = new AbortController()
  let signal: AbortSignal | undefined
  let calls = 0
  const resolver = createAfterglowSourceResolver({
    quality: 'auto',
    callProvider: async (_provider, _method, _args, options) => {
      calls++
      signal = options.signal
      return new Promise(() => {})
    }
  })
  const pending = resolver.resolve({ id: 'ncm:6', source: 'ncm' }, controller.signal)
  await Promise.resolve()
  controller.abort()
  assert.equal(await pending, null)
  assert.equal(signal?.aborted, true)
  assert.equal(await resolver.resolve({ id: 'ncm:6', source: 'ncm' }, controller.signal), null)
  assert.equal(calls, 1)
})
