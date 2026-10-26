import assert from 'node:assert/strict'
import test from 'node:test'
import { CastOutputSupervisor } from './castOutputSupervisor.ts'
import type { CoreCastSafetyTarget } from '../../shared/coreCast.ts'

const target: CoreCastSafetyTarget = {
  deviceId: 'one',
  protocol: 'dlna',
  controlUrl: 'http://127.0.0.1/control'
}

test('main retains an independent stop-only target until Stop is confirmed, including explicit retry', async () => {
  const calls: CoreCastSafetyTarget[] = []
  let fail = true
  const output = new CastOutputSupervisor(async (value) => {
    calls.push(value)
    if (fail) throw new Error('Stop reply lost')
  })
  output.arm(target)
  target.controlUrl = 'http://changed.test/control'
  await assert.rejects(output.stop(), /reply lost/)
  assert.equal(calls[0].protocol === 'dlna' && calls[0].controlUrl, 'http://127.0.0.1/control')
  assert.throws(() => output.arm({ ...target, deviceId: 'two' }), /not confirmed Stop/)
  output.disarm('unrelated')
  fail = false
  await output.stop()
  await output.stop()
  assert.equal(calls.length, 2)
  output.arm({ ...target, deviceId: 'two' })
  output.disarm('two')
  await output.stop()
  assert.equal(calls.length, 2)
})

test('completion of an old stop cannot discard a newly armed receiver session on the same device', async () => {
  let finish!: () => void
  const calls: CoreCastSafetyTarget[] = []
  const output = new CastOutputSupervisor(async (value) => {
    calls.push(value)
    if (calls.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
  })
  const cast: CoreCastSafetyTarget = {
    deviceId: 'cast',
    protocol: 'chromecast',
    host: '127.0.0.1',
    port: 8009,
    receiverSessionId: 'old'
  }
  output.arm(cast)
  const stopping = output.stop()
  output.arm({ ...cast, receiverSessionId: 'new' })
  finish()
  await stopping
  await output.stop()
  assert.deepEqual(
    calls.map((value) => value.protocol === 'chromecast' && value.receiverSessionId),
    ['old', 'new']
  )
})
