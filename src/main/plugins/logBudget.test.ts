import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BoundedPluginLogQueue,
  PluginLogBudget,
  PLUGIN_LOG_LINE_BYTES,
  PLUGIN_LOG_PENDING_BYTES,
  PLUGIN_LOG_PENDING_LINES
} from './logBudget.ts'

test('plugin logs bound text before forwarding and renew the rate budget', () => {
  let now = 1000
  const budget = new PluginLogBudget(() => now)
  const enormous = '音乐'.repeat(1024 * 1024)
  const captured = budget.capture(enormous)
  assert.ok(captured.text)
  assert.ok(Buffer.byteLength(captured.text) <= PLUGIN_LOG_LINE_BYTES + 3)
  assert.ok(captured.notice)
  for (let i = 0; i < 1000; i++) budget.capture('x'.repeat(4096))
  assert.equal(budget.capture('suppressed').text, null)
  now += 1000
  assert.equal(budget.capture('renewed').text, 'renewed')
})

test('a slow disk keeps plugin backlog bounded and reports dropped lines', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const written: string[] = []
  const queue = new BoundedPluginLogQueue(async (_path, line) => {
    if (written.length === 0) await gate
    written.push(line)
  })
  for (let i = 0; i < 20_000; i++) queue.append('plugin.log', `${i}:${'x'.repeat(1024)}\n`)
  const pending = queue.pending('plugin.log')
  assert.ok(pending.count <= PLUGIN_LOG_PENDING_LINES)
  assert.ok(pending.bytes <= PLUGIN_LOG_PENDING_BYTES)
  assert.equal(pending.count, 64)
  release()
  await queue.flush('plugin.log')
  assert.ok(written.some((line) => /dropped 19936 lines/.test(line)))
  assert.deepEqual(queue.pending('plugin.log'), { bytes: 0, count: 0 })
  assert.equal(queue.append('plugin.log', 'after flush'), true)
  await queue.flush('plugin.log')
  assert.equal(written.at(-1), 'after flush')
})

test('a failed plugin disk write does not wedge later writes or another plugin', async () => {
  const written: string[] = []
  const queue = new BoundedPluginLogQueue(async (_path, line) => {
    if (line === 'fail') throw new Error('disk full')
    written.push(line)
  })
  queue.append('a', 'fail')
  queue.append('a', 'next')
  queue.append('b', 'independent')
  await Promise.all([queue.flush('a'), queue.flush('b')])
  assert.deepEqual(written.sort(), ['independent', 'next'])
})
