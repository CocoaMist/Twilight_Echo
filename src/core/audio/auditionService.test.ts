import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreAuditionService } from './auditionService.ts'
import { DspAuditionManager, type DspAuditionContext } from './dspAuditionManager.ts'
import { CoreAudioOutputService, type CoreOutputEngine } from './outputService.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, type DspGraphConfig } from '../../shared/dspGraph.ts'
import { isCoreRequest } from '../../shared/coreProtocol.ts'

const graph: DspGraphConfig = {
  version: 2,
  nodes: [],
  outputStage: { ...DEFAULT_DSP_OUTPUT_STAGE }
}
const input = { startSeconds: 0, endSeconds: 12, a: graph, b: graph }
const signal = () => new AbortController().signal
function fixture() {
  let nativeRevision = 1,
    measured = 0,
    cancels = 0,
    changeKey = 'original'
  let gate: (() => Promise<void>) | undefined, cancelled: (() => void) | undefined
  let tick: (() => void) | undefined
  const applied: (DspGraphConfig | undefined)[] = []
  const output = new CoreAudioOutputService({
    engine: {} as CoreOutputEngine,
    settings: {} as CoreSettingsRepository,
    changed: () => {}
  })
  const context = async () =>
    ({
      revision: nativeRevision,
      key: changeKey,
      applied: true,
      graph,
      info: {
        source: 'authoritative-local.wav',
        nativePlaybackActive: true,
        isDsd: false,
        state: 'playing',
        decodedChannels: 2,
        actualChannels: 2,
        actualOutputFormat: 'float32',
        sourceSampleRate: 48000,
        actualSampleRate: 48000,
        playbackRate: 1,
        position: 7
      }
    }) as DspAuditionContext
  const manager = new DspAuditionManager({
    context,
    newId: () => 'audition-fixture',
    identify: async () => 'unchanged-file',
    authorize: async (source) => {
      assert.equal(source, 'authoritative-local.wav')
      return source
    },
    apply: async (revision, _key, value) => {
      assert.equal(revision, nativeRevision)
      applied.push(value)
      return ++nativeRevision
    },
    analyze: async (source) => {
      assert.equal(source, 'authoritative-local.wav')
      measured++
      await gate?.()
      return { integratedLufs: -20, truePeakDb: -10, processingVersion: 1 }
    },
    cancel: () => {
      cancels++
      cancelled?.()
    },
    timers: {
      setInterval: (cb) => {
        tick = cb
        return 1
      },
      clearInterval: () => {
        tick = undefined
      }
    },
    changed: () => output.changed()
  })
  return {
    output,
    manager,
    service: new CoreAuditionService({ manager, configuration: output, context }),
    applied,
    measured: () => measured,
    cancels: () => cancels,
    tick: () => tick?.(),
    change: () => {
      changeKey = 'changed'
    },
    wait: (run: () => Promise<void>, cancel?: () => void) => {
      gate = run
      cancelled = cancel
    }
  }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('audition measures the Core source, persists no graph and outlives its requesting window', async () => {
  const f = fixture(),
    controller = new AbortController()
  let release!: () => void
  f.wait(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const measuring = f.service.measure({ revision: 0, ...input }, controller.signal)
  while (!f.measured()) await turn()
  controller.abort(new Error('renderer destroyed'))
  assert.equal((await f.service.state()).measuring, true)
  await f.output.serialize(async () => {})
  f.wait(async () => {})
  release()
  const result = await measuring
  assert.equal(f.measured(), 4)
  assert.equal((await f.service.state()).result?.id, result.id)
  await f.service.select(f.output.getRevision(), result.id, 'b', signal())
  assert.equal((await f.service.state()).result?.selected, 'b')
  await f.service.shutdown()
  assert.equal(f.applied.length, 2)
  assert.equal(f.applied[1], undefined)
  assert.equal((await f.service.state()).result, null)
})

test('quit cancels and joins an in-flight analysis before its service is destroyed', async () => {
  const f = fixture()
  let reject!: (reason: Error) => void
  f.wait(
    () =>
      new Promise<void>((_resolve, rejectAnalysis) => {
        reject = rejectAnalysis
      }),
    () => reject(new Error('analysis cancelled'))
  )
  const measuring = f.service.measure({ revision: 0, ...input }, signal())
  const rejected = assert.rejects(measuring, /cancelled/)
  while (!f.measured()) await turn()
  await f.service.shutdown()
  await rejected
  assert.equal((await f.service.state()).measuring, false)
  assert.equal(f.cancels(), 1)
})

test('stale selection is rejected before graph dispatch and source changes retire audition', async () => {
  const f = fixture()
  const result = await f.service.measure({ revision: 0, ...input }, signal())
  await assert.rejects(f.service.select(0, result.id, 'a', signal()), { code: 'STALE_REVISION' })
  assert.equal(f.applied.length, 0)
  await f.service.select(f.output.getRevision(), result.id, 'a', signal())
  f.change()
  f.tick()
  await turn()
  assert.equal((await f.service.state()).result, null)
  await f.service.shutdown()
})

test('audition commands never accept a renderer-selected source', () => {
  const request = (payload: unknown) => ({
    kind: 'command',
    name: 'audio.audition.measure',
    epoch: 'e',
    requestId: 'r',
    payload
  })
  assert.equal(isCoreRequest(request({ revision: 0, ...input })), true)
  assert.equal(isCoreRequest(request({ revision: 0, ...input, source: 'C:/private.wav' })), false)
})
