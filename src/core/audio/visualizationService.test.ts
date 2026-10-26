import assert from 'node:assert/strict'
import test from 'node:test'
import type { VisualizationData } from '../../shared/audioEngineTypes.ts'
import type { CoreVisualizationEvent } from '../../shared/coreVisualization.ts'
import { CoreVisualizationService } from './visualizationService.ts'
import {
  createInactiveVisualizationData,
  normalizeVisualizationOptions
} from './audioEngineHelpers.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const frame = createInactiveVisualizationData(normalizeVisualizationOptions())
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(epoch = 'epoch-1') {
  const demand: boolean[] = []
  const reads: ReturnType<typeof deferred<VisualizationData>>[] = []
  const events: Array<{ clientId: string; event: CoreVisualizationEvent }> = []
  let tick: (() => void) | null = null
  const service = new CoreVisualizationService({
    epoch,
    engine: {
      setVisualizationDemand: async (enabled) => {
        demand.push(enabled)
      },
      readVisualizationDataAsync: async () => {
        const result = deferred<VisualizationData>()
        reads.push(result)
        return result.promise
      }
    },
    send: (clientId, event) => events.push({ clientId, event }),
    schedule: (callback, delay) => {
      assert.equal(delay, 60)
      tick = callback
      return () => {
        tick = null
      }
    }
  })
  return { service, demand, reads, events, tick: () => tick?.(), polling: () => tick !== null }
}

test('Core starts capture off; equal options share reads across windows and duplicate subscribe is idempotent', async () => {
  const f = fixture()
  await f.service.initialize()
  assert.deepEqual(f.demand, [false])
  assert.equal(f.polling(), false)
  await f.service.subscribe('desktop', { subscriptionId: 'spectrum' })
  await f.service.subscribe('mini', { subscriptionId: 'bars', options: { spectrumPoints: 64 } })
  await f.service.subscribe('desktop', { subscriptionId: 'spectrum' })
  assert.deepEqual(f.demand, [false, true])
  f.tick()
  f.tick()
  assert.equal(f.reads.length, 1)
  f.reads[0].resolve(frame)
  await flush()
  assert.deepEqual(
    f.events.map(({ clientId }) => clientId),
    ['desktop', 'mini']
  )
  assert.equal(f.events[0].event.sequence, 1)
  await f.service.disconnect('desktop')
  assert.equal(f.polling(), true)
  await f.service.disconnect('mini')
  assert.equal(f.polling(), false)
  assert.deepEqual(f.demand, [false, true, false])
  f.tick()
  assert.equal(f.reads.length, 1)
  await f.service.shutdown()
})

test('withdrawn or replaced subscriptions do not receive a late FFT result', async () => {
  const f = fixture()
  await f.service.initialize()
  await f.service.subscribe('desktop', { subscriptionId: 'view' })
  f.tick()
  await f.service.subscribe('desktop', { subscriptionId: 'view', options: { spectrumPoints: 256 } })
  f.tick()
  assert.equal(f.reads.length, 2)
  f.reads[0].resolve(frame)
  await flush()
  assert.equal(f.events.length, 0)
  f.reads[1].resolve(frame)
  await flush()
  assert.equal(f.events.length, 1)
  f.tick()
  await f.service.unsubscribe('desktop', 'view')
  assert.equal(f.demand.at(-1), false)
  f.reads[2].resolve(frame)
  await flush()
  assert.equal(f.events.length, 1)
  await f.service.shutdown()
})

test('shutdown disables native capture before joining a slow read and suppresses the old epoch', async () => {
  const f = fixture('old-epoch')
  await f.service.initialize()
  await f.service.subscribe('desktop', { subscriptionId: 'view' })
  f.tick()
  let stopped = false
  const shutdown = f.service.shutdown().then(() => {
    stopped = true
  })
  await flush()
  assert.equal(f.demand.at(-1), false)
  assert.equal(stopped, false)
  assert.equal(f.polling(), false)
  f.reads[0].resolve(frame)
  await shutdown
  assert.equal(f.events.length, 0)
  await assert.rejects(f.service.subscribe('desktop', { subscriptionId: 'view' }), /shutting down/)
  const replacement = fixture('new-epoch')
  await replacement.service.initialize()
  await replacement.service.subscribe('desktop', { subscriptionId: 'view' })
  replacement.tick()
  replacement.reads[0].resolve(frame)
  await flush()
  assert.equal(replacement.events[0].event.epoch, 'new-epoch')
  await replacement.service.shutdown()
})

test('a disconnect during gate enable still disables the tap without starting a timer', async () => {
  const gate = deferred<void>()
  const entered = deferred<void>()
  const demand: boolean[] = []
  let schedules = 0
  const service = new CoreVisualizationService({
    epoch: 'epoch',
    engine: {
      setVisualizationDemand: async (enabled) => {
        demand.push(enabled)
        if (enabled) {
          entered.resolve()
          await gate.promise
        }
      },
      readVisualizationDataAsync: async () => frame
    },
    send: () => assert.fail('no subscribed frame'),
    schedule: () => {
      schedules++
      return () => {}
    }
  })
  await service.initialize()
  const subscription = service.subscribe('window', { subscriptionId: 'view' })
  await entered.promise
  const disconnect = service.disconnect('window')
  gate.resolve()
  await Promise.all([subscription, disconnect])
  assert.deepEqual(demand, [false, true, false])
  assert.equal(schedules, 0)
  await service.shutdown()
})
