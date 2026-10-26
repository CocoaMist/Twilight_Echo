import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceResources } from './sourceResources.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

test('cache maintenance drains concurrent source leases and blocks later preparations in order', async () => {
  const resources = new SourceResources(),
    first = deferred(),
    second = deferred(),
    clearing = deferred(),
    events: string[] = []
  const read = (id: string, ready: Promise<void>) =>
    resources.use(async () => {
      events.push(id)
      await ready
      events.push(id + ':done')
    })
  const reads = [read('first', first.promise), read('second', second.promise)]
  const maintenance = resources.maintain(async () => {
    events.push('clear')
    await clearing.promise
    events.push('clear:done')
  })
  const later = read('later', Promise.resolve())
  await tick()
  assert.deepEqual(events, ['first', 'second'])
  first.resolve()
  await tick()
  assert.equal(events.includes('clear'), false)
  second.resolve()
  await tick()
  assert.equal(events.at(-1), 'clear')
  assert.equal(events.includes('later'), false)
  clearing.resolve()
  await Promise.all([...reads, maintenance, later])
  assert.deepEqual(events.slice(-3), ['clear:done', 'later', 'later:done'])
})

test('failed preparations and maintenance release their leases without replaying either operation', async () => {
  const resources = new SourceResources()
  let calls = 0
  const read = resources.use(async () => {
    calls++
    throw new Error('cancelled source')
  })
  const maintenance = resources.maintain(async () => {
    calls++
    throw new Error('clear failed')
  })
  const later = resources.use(async () => ++calls)
  await assert.rejects(read, /cancelled source/)
  await assert.rejects(maintenance, /clear failed/)
  assert.equal(await later, 3)
})
