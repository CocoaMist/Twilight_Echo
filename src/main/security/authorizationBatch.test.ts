import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAuthorizationBatch, AUTHORIZATION_BATCH_CONCURRENCY } from './authorizationBatch.ts'

test('queue-sized repeated sources resolve once per request and never cache authorization across requests', async () => {
  let calls = 0
  const resolve = async (source: string) => {
    calls++
    return `authorized:${source}`
  }
  const sources = new Array(5000).fill('shared.flac')
  const results = await resolveAuthorizationBatch(sources, resolve)
  assert.equal(calls, 1)
  assert.equal(results.get('shared.flac'), 'authorized:shared.flac')
  await resolveAuthorizationBatch(sources, resolve)
  assert.equal(calls, 2)
})

test('unique sources use bounded workers and retain exact source associations', async () => {
  let running = 0,
    peak = 0
  const sources = Array.from({ length: 500 }, (_, index) => String(index))
  const results = await resolveAuthorizationBatch(sources, async (source) => {
    peak = Math.max(peak, ++running)
    await new Promise((resolve) => setImmediate(resolve))
    running--
    return `canonical:${source}`
  })
  assert.equal(peak, AUTHORIZATION_BATCH_CONCURRENCY)
  assert.equal(running, 0)
  for (const source of sources) assert.equal(results.get(source), `canonical:${source}`)
})

test('failed authorization rejects the batch after draining all outstanding resolutions', async () => {
  let running = 0
  await assert.rejects(
    resolveAuthorizationBatch(['bad', ...new Array(100).fill('ok')], async (source) => {
      running++
      await new Promise((resolve) => setImmediate(resolve))
      running--
      if (source === 'bad') throw new Error('denied')
      return source
    }),
    /denied/
  )
  assert.equal(running, 0)
  assert.deepEqual(await resolveAuthorizationBatch([], async (source) => source), new Map())
})
