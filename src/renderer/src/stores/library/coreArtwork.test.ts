import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createCoreArtwork } from './coreArtwork.ts'
import type { CoreSnapshot } from '../../../../shared/coreProtocol.ts'

function fixture() {
  let revision = 1,
    gate: (() => Promise<void>) | undefined
  const state = shallowRef({ phase: 'ready', epoch: 'one' } as CoreSnapshot)
  const reads: string[][] = []
  const core = {
    state,
    attach: async () => state.value,
    query: async (name: string, input: { ids: string[]; revision?: number }) => {
      assert.equal(name, 'library.artwork')
      assert.equal(input.revision, revision)
      reads.push(input.ids)
      if (gate) {
        const wait = gate
        gate = undefined
        await wait()
      }
      return { revision, items: input.ids.map((id) => ({ id, cover: `cover://${id}.jpg` })) }
    }
  } as unknown as Parameters<typeof createCoreArtwork>[0]
  const artwork = createCoreArtwork(core, () => revision)
  return {
    artwork,
    state,
    reads,
    advance() {
      revision++
    },
    block(wait: () => Promise<void>) {
      gate = wait
    }
  }
}

test('artwork batches identity-only demand, reuses grants and bounds its display cache', async () => {
  const f = fixture()
  const results = await Promise.all(
    Array.from({ length: 530 }, (_, i) => f.artwork.read(`song-${i}`))
  )
  assert.equal(results[529], 'cover://song-529.jpg')
  assert.deepEqual(
    f.reads.map((ids) => ids.length),
    [200, 200, 130]
  )
  assert.equal(f.artwork.cachedCount, 512)
  await f.artwork.read('song-529')
  assert.equal(f.reads.length, 3)
  await f.artwork.read('song-529', true)
  assert.equal(f.reads.length, 4)
})

test('library revision and epoch invalidate cached grants, and a stale result cannot fill the new cache', async () => {
  const f = fixture()
  await f.artwork.read('song')
  f.advance()
  await f.artwork.read('song')
  assert.equal(f.reads.length, 2)
  let release!: () => void
  f.block(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const old = f.artwork.read('old')
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  f.state.value = { ...f.state.value, epoch: 'two' }
  release()
  assert.equal(await old, null)
  await f.artwork.read('old')
  assert.equal(f.reads.length, 4)
  assert.equal(f.artwork.cachedCount, 1)
})
