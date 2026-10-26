import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { CoreOutputTestService } from './outputTestService.ts'
import { CoreAudioOutputService, type CoreOutputEngine } from './outputService.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import type { OutputTestContext } from './outputTest.ts'
import { isCoreRequest } from '../../shared/coreProtocol.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const signal = () => new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-output-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: [string, unknown[]][] = []
  let source = '',
    closes = 0,
    created = 0,
    timer: (() => void) | undefined
  let closeGate: Promise<void> | undefined
  let contextGate: Promise<void> | undefined
  let ackGate: Promise<void> | undefined
  const context: OutputTestContext = {
    backend: 'wasapi',
    device: 'device-1',
    volume: 0.3,
    outputConfig: { preferredBufferSize: 512, routingMode: 'stereo' },
    playing: false
  }
  const output = new CoreAudioOutputService({
    engine: {} as CoreOutputEngine,
    settings: {} as CoreSettingsRepository,
    changed() {}
  })
  const service = new CoreOutputTestService({
    configuration: output,
    temporaryDirectory: root,
    context: async (exclusive) => {
      await contextGate
      return { ...context, backend: exclusive ? 'wasapi-exclusive' : 'wasapi' }
    },
    timers: {
      setTimeout(callback) {
        timer = callback
        return 1
      },
      clearTimeout() {
        timer = undefined
      }
    },
    createService: () => {
      created++
      return {
        callAsync: async (method, args) => {
          calls.push([method, args])
          if (method === 'Play') {
            source = String(args[0])
            assert.equal((await readFile(source)).toString('ascii', 0, 4), 'RIFF')
          }
          if (method === 'GetPlaybackInfo') {
            await ackGate
            return { state: 'playing', source }
          }
          return undefined
        },
        destroy: async () => {
          closes++
          await closeGate
        }
      }
    }
  })
  t.after(() => service.stop())
  return {
    service,
    output,
    context,
    calls,
    source: () => source,
    closes: () => closes,
    created: () => created,
    started: async () => {
      while (!timer) await turn()
    },
    finish: () => timer?.(),
    delayClose: (gate: Promise<void>) => {
      closeGate = gate
    },
    delayContext: (gate: Promise<void>) => {
      contextGate = gate
    },
    delayAck: (gate: Promise<void>) => {
      ackGate = gate
    }
  }
}

test('accepted output test outlives its client and frees both configuration and transport lanes', async (t) => {
  const f = await fixture(t),
    controller = new AbortController()
  const playing = f.service.play(0, true, controller.signal)
  await f.started()
  controller.abort(new Error('renderer destroyed'))
  assert.equal(f.service.state().active, true)
  await f.output.serialize(async () => {})
  assert.deepEqual(f.calls.slice(0, 4), [
    ['SetVolume', [0.3]],
    ['SetOutputBackend', ['wasapi-exclusive']],
    ['SetOutputDevice', ['device-1']],
    ['SetOutputConfig', [JSON.stringify(f.context.outputConfig)]]
  ])
  f.finish()
  assert.deepEqual(await playing, { cancelled: false })
  assert.equal(f.service.state().active, false)
  assert.equal(f.closes(), 1)
  await assert.rejects(access(dirname(f.source())))
})

test('Pause/Play waits for actual test-service exit, then preserves the music operation result', async (t) => {
  const f = await fixture(t),
    exit = deferred()
  f.delayClose(exit.promise)
  const playing = f.service.play(0, false, signal())
  await f.started()
  let dispatched = false
  const transport = f.service.withTransport(async () => {
    dispatched = true
    return 'native-ACK'
  })
  await turn()
  assert.equal(dispatched, false)
  assert.equal(f.closes(), 1)
  assert.equal(f.service.state().active, true)
  await access(f.source())
  exit.resolve()
  assert.equal(await transport, 'native-ACK')
  assert.deepEqual(await playing, { cancelled: true })
  await assert.rejects(access(dirname(f.source())))
})

test('new test cannot race a still-pending music transport into playing', async (t) => {
  const f = await fixture(t),
    native = deferred(),
    entered = deferred()
  const transport = f.service.withTransport(async () => {
    entered.resolve()
    await native.promise
    f.context.playing = true
  })
  await entered.promise
  const playing = f.service.play(0, false, signal())
  const rejected = assert.rejects(playing, /暂停/)
  native.resolve()
  await transport
  await rejected
  assert.equal(f.created(), 0)
})

test('stale, cancelled, busy and muted tests never launch another service; quit joins cleanup', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.service.play(4, false, signal()), { code: 'STALE_REVISION' })
  const cancelled = new AbortController()
  cancelled.abort(new Error('cancelled before acceptance'))
  await assert.rejects(f.service.play(0, false, cancelled.signal), /cancelled/)
  f.context.volume = 0
  await assert.rejects(f.service.play(0, false, signal()), /音量/)
  assert.equal(f.created(), 0)
  f.context.volume = 0.2
  const playing = f.service.play(f.output.getRevision(), false, signal())
  await f.started()
  await assert.rejects(f.service.play(f.output.getRevision(), false, signal()), /正在播放/)
  assert.equal(f.created(), 1)
  await f.service.stop()
  assert.deepEqual(await playing, { cancelled: true })
  assert.equal(f.service.state().active, false)
  assert.equal(f.closes(), 1)
})

test('a disconnected request awaiting context does not start a late test', async (t) => {
  const f = await fixture(t),
    gate = deferred(),
    controller = new AbortController()
  f.delayContext(gate.promise)
  const playing = f.service.play(0, false, controller.signal)
  const rejected = assert.rejects(playing, /disconnected/)
  await turn()
  controller.abort(new Error('disconnected before acceptance'))
  gate.resolve()
  await rejected
  assert.equal(f.created(), 0)
})

test(
  'Stop during the final native start acknowledgement does not enter the duration wait',
  { timeout: 1_000 },
  async (t) => {
    const f = await fixture(t),
      ack = deferred()
    f.delayAck(ack.promise)
    const playing = f.service.play(0, false, signal())
    while (!f.calls.some(([method]) => method === 'GetPlaybackInfo')) await turn()
    const stopped = f.service.stop()
    await turn()
    ack.resolve()
    await stopped
    assert.deepEqual(await playing, { cancelled: true })
    assert.equal(f.closes(), 1)
  }
)

test('output test API accepts only route revision and exclusive preference, not sources or services', () => {
  const request = (name: string, payload: unknown, kind = 'command') => ({
    name,
    payload,
    kind,
    epoch: 'e',
    requestId: 'r'
  })
  assert.equal(isCoreRequest(request('audio.outputTest', {}, 'query')), true)
  assert.equal(
    isCoreRequest(request('audio.outputTest.play', { revision: 0, exclusive: true })),
    true
  )
  for (const payload of [
    { revision: -1, exclusive: true },
    { revision: 0, exclusive: 'yes' },
    { revision: 0, exclusive: false, source: 'private.wav' },
    { revision: 0, exclusive: true, service: 'audio', method: 'Play' }
  ])
    assert.equal(isCoreRequest(request('audio.outputTest.play', payload)), false)
  assert.equal(isCoreRequest(request('audio.outputTest.stop', {})), true)
})
