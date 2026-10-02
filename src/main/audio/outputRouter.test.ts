import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngineManager } from '../audioEngineManager.ts'
import { createDefaultPlaybackInfo, getAudioOutputOptions } from './audioEngineHelpers.ts'
import type { AudioEngineConfig, NativeAudioBinding, OutputConfig } from './audioEngineTypes.ts'

function createHarness(config: AudioEngineConfig) {
  let info = createDefaultPlaybackInfo('wasapi', 'auto', config.exclusiveMode, {
    preferredBufferSize: 0,
    routingMode: 'auto'
  })
  const calls: Array<{ method: string; value: unknown }> = []
  let failConfig = false
  let dspRevision = 0
  const native = {
    GetPlaybackInfo: () => JSON.stringify(info),
    SetOutputBackend: (backend: string) => {
      calls.push({ method: 'backend', value: backend })
      info = { ...info, outputBackend: backend }
      if (!info.outputInfo.outputReleased) {
        info.actualBackend = backend
        info.outputInfo = { ...info.outputInfo, backend, actualBackend: backend }
      }
    },
    SetOutputDevice: (device: string) => {
      calls.push({ method: 'device', value: device })
      info = { ...info, outputDevice: device }
    },
    SetOutputConfig: (json: string) => {
      if (failConfig) throw new Error('configuration rejected')
      calls.push({ method: 'config', value: JSON.parse(json) })
    },
    SetVolume: () => {},
    SetDspConfig: () => {},
    ApplyDspState: (revision: number) => {
      dspRevision = revision
    },
    GetDspGraphStatus: () =>
      JSON.stringify({ revision: dspRevision, nodes: [], compileState: 'ready' }),
    GetLastError: () => ''
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager(config, { nativeBinding: native })
  const effective = () =>
    manager.getEffectiveOutputConfig() as OutputConfig & { releaseExclusiveOnPause: boolean }
  return {
    manager,
    calls,
    effective,
    rejectConfig: () => (failConfig = true),
    releasePausedOutput: () => {
      info = { ...info, state: 'paused', source: 'track.flac', position: 12 }
      info.outputInfo = {
        ...info.outputInfo,
        actualBackend: 'wasapi-exclusive',
        outputReleased: true,
        exclusive: false,
        outputPerfect: false,
        accessMode: 'released'
      }
    }
  }
}

test('exclusive automatic release defaults off and requires the exclusive preference', () => {
  const manual = createHarness({ exclusiveMode: true })
  assert.equal(manual.effective().releaseExclusiveOnPause, false)
  const shared = createHarness({ exclusiveMode: false, exclusiveAutoRelease: true })
  assert.equal(shared.effective().releaseExclusiveOnPause, false)
  const exclusive = createHarness({ exclusiveMode: true, exclusiveAutoRelease: true })
  assert.equal(exclusive.effective().releaseExclusiveOnPause, true)
})

test('runtime release policy follows the transaction target and survives output configuration edits', async () => {
  const harness = createHarness({ exclusiveMode: true, exclusiveAutoRelease: true })
  await harness.manager.setExclusiveMode(false)
  assert.equal(
    (harness.calls.find((call) => call.method === 'config')?.value as Record<string, unknown>)
      .releaseExclusiveOnPause,
    false
  )
  await harness.manager.setExclusiveMode(true)
  await harness.manager.setOutputConfig({ preferredBufferSize: 512 })
  assert.equal(harness.effective().releaseExclusiveOnPause, true)
  assert.equal(harness.manager.getOutputConfig().preferredBufferSize, 512)
  assert.equal('releaseExclusiveOnPause' in harness.manager.getOutputConfig(), false)
})

test('release policy respects the platform backend capabilities', () => {
  for (const option of getAudioOutputOptions()) {
    const harness = createHarness({
      exclusiveMode: true,
      exclusiveAutoRelease: true,
      audioOutput: option.id
    })
    assert.equal(harness.effective().releaseExclusiveOnPause, option.supportsExclusive)
  }
})

test('automatic release policy update rolls back on native rejection', async () => {
  const harness = createHarness({ exclusiveMode: true })
  await harness.manager.setExclusiveAutoRelease(true)
  assert.equal(harness.effective().releaseExclusiveOnPause, true)
  harness.rejectConfig()
  await assert.rejects(harness.manager.setExclusiveAutoRelease(false), /configuration rejected/)
  assert.equal(harness.effective().releaseExclusiveOnPause, true)
})

test('released pause accepts pending route edits without requiring a newly opened output', async () => {
  const harness = createHarness({ exclusiveMode: true })
  harness.releasePausedOutput()
  await harness.manager.setExclusiveAutoRelease(true)
  assert.equal((await harness.manager.getPlaybackInfo()).state, 'paused')
  await harness.manager.setExclusiveMode(false)
  const pending = await harness.manager.getPlaybackInfo()
  assert.equal(pending.state, 'paused')
  assert.equal(pending.position, 12)
  assert.equal(pending.outputInfo.outputReleased, true)
  assert.equal(pending.outputInfo.exclusive, false)
  assert.equal(pending.outputInfo.actualBackend, 'wasapi-exclusive')
  assert.equal(pending.outputBackend, 'wasapi')
  assert.equal(harness.effective().releaseExclusiveOnPause, false)
})

test('failed service resume is returned once without a second toggle through the synchronous binding', async () => {
  const methods: string[] = []
  const native = {
    Pause: () => methods.push('sync Pause'),
    callAsync: async (method: string) => {
      methods.push(method)
      throw new Error('exclusive device busy')
    }
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager({ exclusiveMode: true }, { nativeBinding: native })
  await assert.rejects(manager.togglePause(), /exclusive device busy/)
  assert.deepEqual(methods, ['Pause'])
})

test('failed synchronous resume reaches the caller', async () => {
  let pauses = 0
  const native = {
    Pause: () => {
      pauses++
      throw new Error('exclusive device busy')
    }
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager({ exclusiveMode: true }, { nativeBinding: native })
  await assert.rejects(manager.togglePause(), /exclusive device busy/)
  assert.equal(pauses, 1)
})
