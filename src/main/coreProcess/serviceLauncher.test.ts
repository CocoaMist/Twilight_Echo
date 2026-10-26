import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { CoreServiceLauncher } from './serviceLauncher.ts'
import type { CoreChildMessage } from '../../shared/coreProcessProtocol.ts'

test('plugin uninstall waits for the supervised process exit rather than its port closure', async () => {
  const sent: CoreChildMessage[] = []
  const launcher = new CoreServiceLauncher('epoch', (message) => sent.push(message))
  const host = launcher.launch('plugin')
  const port = Object.assign(new EventEmitter(), { postMessage() {}, close() {}, start() {} })
  launcher.handle({ kind: 'core:service-connected', leaseId: host.id }, [port])
  let exited = false
  const stopping = host.terminate().then(() => {
    exited = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(exited, false)
  assert.equal(sent.at(-1)?.kind, 'core:service-close')
  launcher.handle({ kind: 'core:service-exit', leaseId: host.id, code: 0 })
  await stopping
  assert.equal(exited, true)
  launcher.destroy()
})

test('audio test destruction requests termination once and still joins its actual exit', async () => {
  const sent: CoreChildMessage[] = []
  const launcher = new CoreServiceLauncher('epoch', (message) => sent.push(message))
  const lease = launcher.launch('audio-test')
  lease.kill()
  let exited = false
  const stopping = lease.terminate().then(() => {
    exited = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(sent.filter((message) => message.kind === 'core:service-close').length, 1)
  assert.equal(exited, false)
  launcher.handle({ kind: 'core:service-exit', leaseId: lease.id, code: 0 })
  await stopping
  assert.equal(exited, true)
})
