import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LibraryWatcherPoller,
  LIBRARY_POLL_MIN_MS,
  LIBRARY_POLL_MAX_MS
} from './libraryWatcherPolling.ts'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(check: () => Promise<boolean | undefined>) {
  let timer: { callback(): void; delay: number } | null = null
  const errors: unknown[] = []
  const poller = new LibraryWatcherPoller({
    check,
    onError: (error) => errors.push(error),
    schedule(callback, delay) {
      assert.equal(timer, null, 'only one timer may be armed')
      timer = { callback, delay }
      return () => {
        timer = null
      }
    }
  })
  return {
    poller,
    errors,
    delay: () => timer?.delay,
    async advance() {
      assert.ok(timer)
      const callback = timer.callback
      timer = null
      callback()
      await flush()
    }
  }
}

test('idle polling backs off to five minutes and resets after a change', async () => {
  let result: boolean | undefined = undefined
  const f = fixture(async () => result)
  f.poller.start()
  await flush()
  assert.equal(f.delay(), LIBRARY_POLL_MIN_MS)
  result = false
  for (const expected of [
    15_000,
    30_000,
    60_000,
    120_000,
    240_000,
    LIBRARY_POLL_MAX_MS,
    LIBRARY_POLL_MAX_MS
  ]) {
    await f.advance()
    assert.equal(f.delay(), expected)
  }
  result = true
  await f.advance()
  assert.equal(f.delay(), LIBRARY_POLL_MIN_MS)
  f.poller.stop()
  assert.equal(f.delay(), undefined)
})

test('a slow check cannot overlap and stopping does not rearm on completion', async () => {
  let release!: (value: boolean) => void
  let calls = 0
  const f = fixture(() => {
    calls++
    return new Promise((resolve) => {
      release = resolve
    })
  })
  f.poller.start()
  f.poller.start()
  assert.equal(calls, 1)
  assert.equal(f.delay(), undefined)
  f.poller.stop()
  release(false)
  await flush()
  assert.equal(f.delay(), undefined)
})

test('offline polling reports the error and backs off rather than spinning', async () => {
  const error = new Error('offline')
  const f = fixture(async () => {
    throw error
  })
  f.poller.start()
  await flush()
  assert.equal(f.errors[0], error)
  assert.equal(f.delay(), 15_000)
  await f.advance()
  assert.equal(f.delay(), 30_000)
  f.poller.stop()
})
