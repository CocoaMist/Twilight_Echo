import assert from 'node:assert/strict'
import test from 'node:test'
import { ScanCoverWrites } from './scanCoverWrites.ts'

test('scan cover suspension joins actual writes and gates new ones, even if a parser timed out', async () => {
  const gate = new ScanCoverWrites(),
    events: string[] = []
  let finish!: () => void
  const physical = gate.use(async () => {
    events.push('write')
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    events.push('closed')
  })
  await Promise.resolve()
  const generation = gate.generation
  const suspended = gate.suspend().then(() => events.push('suspended'))
  const next = gate.use(async () => {
    events.push('next')
  })
  await Promise.resolve()
  assert.deepEqual(events, ['write'])
  finish()
  await Promise.all([physical, suspended])
  assert.deepEqual(events, ['write', 'closed', 'suspended'])
  assert.notEqual(generation, gate.generation)
  gate.resume()
  await next
  assert.equal(events.at(-1), 'next')
})

test('cover waits exclude maintenance time without disabling their original IO deadlines', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new ScanCoverWrites()
  let resolve!: (value: number) => void
  const operation = new Promise<number>((done) => {
    resolve = done
  })
  const waiting = gate.timeout(operation, 100, 'cover')
  const failed = assert.rejects(waiting, /cover timed out/)
  t.mock.timers.tick(40)
  await gate.suspend()
  t.mock.timers.tick(1000)
  gate.resume()
  t.mock.timers.tick(59)
  let ended = false
  void waiting.catch(() => {
    ended = true
  })
  await Promise.resolve()
  assert.equal(ended, false)
  t.mock.timers.tick(1)
  await failed
  resolve(1)
  await Promise.resolve()
  assert.equal(await gate.timeout(Promise.resolve(3), 100, 'new cover'), 3)
})
