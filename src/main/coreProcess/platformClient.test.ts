import assert from 'node:assert/strict'
import test from 'node:test'
import { CorePlatformClient } from './platformClient.ts'
import type { CorePlatformRequest, CorePlatformCancel } from '../../shared/corePlatform.ts'

test('joined OS cancellation sends a private cancel and waits for actual operation completion', async () => {
  const sent: Array<CorePlatformRequest | CorePlatformCancel> = []
  const client = new CorePlatformClient('epoch', (message) => sent.push(message))
  const controller = new AbortController()
  let finished = false
  const work = client
    .callJoined(
      'network.sftp',
      {
        connection: { host: 'nas', port: 22, username: 'alice', keyPath: '/key' },
        operation: { kind: 'list', path: '/' }
      },
      controller.signal
    )
    .finally(() => {
      finished = true
    })
  const rejected = assert.rejects(work, /cancelled/)
  controller.abort(new Error('cancelled'))
  await Promise.resolve()
  assert.equal(finished, false)
  assert.deepEqual(sent[1], {
    kind: 'core:platform-cancel',
    requestId: sent[0].requestId,
    epoch: 'epoch'
  })
  client.handle({
    kind: 'core:platform-response',
    epoch: 'epoch',
    requestId: sent[0].requestId,
    ok: true,
    value: { code: 0, stdout: '', stderr: '' }
  })
  await rejected
  client.destroy()
})

test('stem worker cancellation retains its material lease until main confirms exit', async () => {
  const sent: Array<CorePlatformRequest | CorePlatformCancel> = []
  const client = new CorePlatformClient('epoch', (message) => sent.push(message))
  const controller = new AbortController()
  let ended = false
  const work = client
    .callJoined(
      'automix.runWorker',
      {
        packDirectory: 'D:/pack',
        requestPath: 'D:/material/request.json',
        budgetMs: 90000
      },
      controller.signal
    )
    .finally(() => {
      ended = true
    })
  const rejected = assert.rejects(work, /cancelled/)
  controller.abort(new Error('cancelled'))
  await Promise.resolve()
  assert.equal(ended, false)
  assert.equal(sent[1].kind, 'core:platform-cancel')
  client.handle({
    kind: 'core:platform-response',
    epoch: 'epoch',
    requestId: sent[0].requestId,
    ok: true,
    value: undefined
  })
  await rejected
  client.destroy()
})

test('model decoder deadline keeps the extraction lease until the decoder has exited', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent: Array<CorePlatformRequest | CorePlatformCancel> = []
  const client = new CorePlatformClient('epoch', (message) => sent.push(message))
  let ended = false
  const work = client
    .callJoined('automix.decodeArchiveEntry', {
      directory: 'D:/profile/automix-stem-packs/.decode-fixture',
      bytes: 100
    })
    .finally(() => {
      ended = true
    })
  const failed = assert.rejects(work, /timed out/)
  t.mock.timers.tick(310_001)
  await Promise.resolve()
  assert.equal(ended, false)
  assert.equal(sent.at(-1)?.kind, 'core:platform-cancel')
  client.handle({
    kind: 'core:platform-response',
    requestId: sent[0].requestId,
    epoch: 'epoch',
    ok: true,
    value: undefined
  })
  await failed
  client.destroy()
})

test('platform cache cancellation keeps the Core writer gates held until main acknowledges completion', async () => {
  const sent: Array<CorePlatformRequest | CorePlatformCancel> = []
  const client = new CorePlatformClient('epoch', (message) => sent.push(message))
  const signal = new AbortController()
  let ended = false
  const work = client.callJoined('cache.clearPlatform', {}, signal.signal).finally(() => {
    ended = true
  })
  const failed = assert.rejects(work, /disconnected/)
  signal.abort(new Error('disconnected'))
  await Promise.resolve()
  assert.equal(ended, false)
  client.handle({
    kind: 'core:platform-response',
    requestId: sent[0].requestId,
    epoch: 'epoch',
    ok: true,
    value: undefined
  })
  await failed
  client.destroy()
})

test('a private cache deadline requests cancellation but does not release a live filesystem owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent: Array<CorePlatformRequest | CorePlatformCancel> = []
  const client = new CorePlatformClient('epoch', (message) => sent.push(message))
  let ended = false
  const work = client.callJoined('cache.clearPlatform', {}).finally(() => {
    ended = true
  })
  const failed = assert.rejects(work, /timed out/)
  t.mock.timers.tick(70_001)
  await Promise.resolve()
  assert.equal(ended, false)
  assert.equal(sent.at(-1)?.kind, 'core:platform-cancel')
  client.handle({
    kind: 'core:platform-response',
    requestId: sent[0].requestId,
    epoch: 'epoch',
    ok: true,
    value: undefined
  })
  await failed
  client.destroy()
})
