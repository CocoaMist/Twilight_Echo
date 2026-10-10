import assert from 'node:assert/strict'
import test from 'node:test'
import { DspOrchestrator, type DspOrchestratorHost } from './dspOrchestrator.ts'
import { createDefaultPlaybackInfo } from './audioEngineHelpers.ts'
import type { DspStatePayload } from '../../shared/audioServiceContract.ts'
import { compensatedAuditionGraph } from '../../shared/dspAudition.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, type DspGraphConfig } from '../../shared/dspGraph.ts'
import { DEFAULT_AUTO_MIX } from '../../shared/autoMix.ts'

test('AutoMix suspends Direct without changing the saved preference and rolls back rejected enablement', async () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, {
    routingMode: 'auto',
    preferredBufferSize: 0
  })
  const overrides: boolean[] = []
  const configurations: string[] = []
  let accepts = true
  const host = {
    getPlaybackInfo: () => info,
    getDevice: () => 'auto',
    getOutput: () => 'wasapi',
    getNative: () => ({ SetAutoMixConfig: () => {} }),
    setLastNativeError: () => {},
    getLastNativeError: () => '',
    tryNative: () => true,
    updateOutputPerfect: () => {},
    publishPlaybackInfo: () => {},
    syncPlaybackOutputMirrorsFromOutputInfo: () => {},
    syncLoudnormModeTransition: async () => {},
    applyDirectModeRuntimeOverrides: async (value: boolean) => {
      overrides.push(value)
    },
    callNativeMaybeAsync: async (_: string, method: string, json: string) => {
      if (method === 'SetAutoMixConfig') {
        configurations.push(json)
        return accepts
      }
      return true
    },
    getAudioServiceBinding: () => ({
      applyDspState: async (revision: number) => ({
        revision,
        activeSceneId: 'default',
        totalLatencyFrames: 0,
        totalTailFrames: 0,
        nodes: [],
        compileState: 'ready'
      })
    })
  } as unknown as DspOrchestratorHost
  const dsp = new DspOrchestrator(
    host,
    { audioProcessing: { dspEnabled: false, directMode: true } },
    {}
  )
  await dsp.setAudioProcessing({ autoMix: { ...DEFAULT_AUTO_MIX, enabled: true } })
  assert.equal(dsp.processing.directMode, true)
  assert.equal(dsp.getDspSceneState().directMode, false)
  assert.deepEqual(overrides, [false])
  await dsp.setAudioProcessing({ autoMix: { ...DEFAULT_AUTO_MIX, enabled: false } })
  assert.equal(dsp.getDspSceneState().directMode, true)
  assert.deepEqual(overrides, [false, true])
  accepts = false
  await assert.rejects(
    dsp.setAudioProcessing({ autoMix: { ...DEFAULT_AUTO_MIX, enabled: true } }),
    /not accepted/
  )
  assert.equal(dsp.processing.autoMix?.enabled, false)
  assert.equal(dsp.processing.directMode, true)
  assert.deepEqual(overrides, [false, true, false, true])
  assert.equal(configurations.length, 3)
})

test('saved AutoMix reaches native on overlapping startup graphs and is reapplied after service recovery', async () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, {
    routingMode: 'auto',
    preferredBufferSize: 0
  })
  const configurations: string[] = []
  let releaseFirst!: () => void
  const firstAck = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const host = {
    getPlaybackInfo: () => info,
    getDevice: () => 'auto',
    getOutput: () => 'wasapi',
    getNative: () => ({ SetAutoMixConfig: () => {} }),
    setLastNativeError: () => {},
    getLastNativeError: () => '',
    callNativeMaybeAsync: async (_: string, method: string, json: string) => {
      if (method === 'SetAutoMixConfig') configurations.push(json)
      return true
    },
    getAudioServiceBinding: () => ({
      applyDspState: async (revision: number) => {
        if (revision === 1) await firstAck
        return {
          revision,
          activeSceneId: 'default',
          totalLatencyFrames: 0,
          totalTailFrames: 0,
          nodes: [],
          compileState: 'ready'
        }
      }
    })
  } as unknown as DspOrchestratorHost
  const dsp = new DspOrchestrator(
    host,
    { audioProcessing: { autoMix: { ...DEFAULT_AUTO_MIX, enabled: true } } },
    {}
  )
  const startup = dsp.applyNativeDspSettings('startup', {}, false)
  await dsp.applyNativeDspGraph('service ready')
  releaseFirst()
  await startup
  assert.equal(configurations.length, 1)
  assert.equal(JSON.parse(configurations[0]).enabled, true)
  await dsp.applyNativeDspGraph('scene refresh')
  assert.equal(configurations.length, 1) // Keep the current native pair armed.
  dsp.resetAfterServiceCrash('service restarted')
  await dsp.applyNativeDspGraph('recovery')
  assert.equal(configurations.length, 2)
})

test('device profile processing reaches the native graph and rollback restores the previous values', async () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, {
    routingMode: 'auto',
    preferredBufferSize: 0
  })
  const payloads: DspStatePayload[] = []
  const host = {
    getPlaybackInfo: () => info,
    getDevice: () => 'auto',
    getOutput: () => 'wasapi',
    getNative: () => ({}),
    callNativeMaybeAsync: async () => true,
    setLastNativeError: () => undefined,
    updateOutputPerfect: () => undefined,
    publishPlaybackInfo: () => undefined,
    syncLoudnormModeTransition: async () => undefined,
    getAudioServiceBinding: () => ({
      applyDspState: async (revision: number, payload: DspStatePayload) => {
        payloads.push(structuredClone(payload))
        return {
          revision,
          activeSceneId: 'default',
          totalLatencyFrames: 0,
          totalTailFrames: 0,
          nodes: [],
          compileState: 'ready'
        }
      }
    })
  } as unknown as DspOrchestratorHost
  const dsp = new DspOrchestrator(
    host,
    {
      audioProcessing: {
        dspEnabled: true,
        eqEnabled: false,
        eqPreamp: -6,
        volumeNormalization: 'off',
        crossfeedEnabled: true,
        crossfeedStrength: 0.2
      }
    },
    {}
  )
  const previous = structuredClone(dsp.getAudioProcessing())
  const defaultScene = dsp.dspScenes.find((scene) => scene.id === 'default')!
  defaultScene.graph.outputStage.targetSampleRate = 96000
  const compressor = defaultScene.graph.nodes.find((node) => node.id === 'compressor')!
  compressor.enabled = true
  compressor.params = { thresholdDb: -12 }
  defaultScene.graph.nodes.push({
    id: 'custom-gate',
    type: 'gate',
    enabled: true,
    params: { thresholdDb: -30 }
  })
  const previousGraph = structuredClone(defaultScene.graph)
  await dsp.applyProfileConfiguration(
    { eqEnabled: true, volumeNormalization: 'album', crossfeedStrength: 0.8 },
    'default',
    null
  )
  const graph = payloads.at(-1)!.graph as DspGraphConfig
  assert.equal(graph.nodes.find((node) => node.type === 'equalizer')?.enabled, true)
  assert.equal(graph.nodes.find((node) => node.type === 'replayGain')?.enabled, true)
  assert.equal(graph.nodes.find((node) => node.type === 'replayGain')?.params.mode, 'album')
  assert.equal(graph.nodes.find((node) => node.type === 'crossfeed')?.params.strength, 0.8)
  assert.equal(graph.outputStage.targetSampleRate, 96000)
  assert.deepEqual(
    graph.nodes.find((node) => node.id === 'compressor'),
    compressor
  )
  assert.deepEqual(
    graph.nodes.find((node) => node.id === 'custom-gate'),
    {
      id: 'custom-gate',
      type: 'gate',
      enabled: true,
      params: { thresholdDb: -30 }
    }
  )
  await dsp.applyProfileConfiguration(previous, 'default', null)
  assert.deepEqual(defaultScene.graph, previousGraph)
  const restored = payloads.at(-1)!.graph as DspGraphConfig
  assert.equal(restored.nodes.find((node) => node.type === 'equalizer')?.enabled, false)
  assert.equal(restored.nodes.find((node) => node.type === 'crossfeed')?.params.strength, 0.2)
})

test('temporary audition graphs use DSP revisions and leave saved processing and position untouched', async () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, {
    routingMode: 'auto',
    preferredBufferSize: 0
  })
  info.position = 42
  const payloads: DspStatePayload[] = []
  let staleAck = false
  let continuity = false
  const host = {
    getPlaybackInfo: () => info,
    getDevice: () => 'auto',
    getOutput: () => 'wasapi',
    getOutputConfig: () => ({
      playbackPolicy: continuity ? 'continuity-first' : 'bit-perfect-first',
      continuitySampleRate: 96000
    }),
    getNative: () => ({}),
    setLastNativeError: () => undefined,
    getAudioServiceBinding: () => ({
      applyDspState: async (revision: number, payload: DspStatePayload) => {
        payloads.push(payload)
        return {
          revision: staleAck ? revision - 1 : revision,
          activeSceneId: null,
          totalLatencyFrames: 0,
          totalTailFrames: 0,
          nodes: [],
          compileState: 'ready'
        }
      }
    })
  } as unknown as DspOrchestratorHost
  const dsp = new DspOrchestrator(
    host,
    { audioProcessing: { dspEnabled: false, directMode: true } },
    {}
  )
  const before = structuredClone(dsp.processing)
  const scenes = structuredClone(dsp.dspScenes)
  const graph = compensatedAuditionGraph(
    { version: 2, nodes: [], outputStage: DEFAULT_DSP_OUTPUT_STAGE },
    -6
  )
  assert.equal((await dsp.applyNativeDspGraph('test audition', graph)).applyState, 'applied')
  assert.equal(payloads[0].processing.dspEnabled, true)
  assert.equal(payloads[0].processing.directMode, false)
  assert.equal((payloads[0].graph as DspGraphConfig).nodes[0].params.preampDb, -6)
  assert.equal(
    (payloads[0].graph as unknown as { auditionTransition: boolean }).auditionTransition,
    true
  )
  assert.deepEqual(dsp.processing, before)
  assert.deepEqual(dsp.dspScenes, scenes)
  assert.equal(info.position, 42)
  await dsp.applyNativeDspGraph('restore')
  assert.deepEqual((payloads[1].graph as DspGraphConfig).nodes, [])
  assert.equal(payloads[1].processing.dspEnabled, false)
  continuity = true
  await dsp.applyNativeDspGraph('continuous output')
  assert.equal((payloads[2].graph as DspGraphConfig).outputStage.targetSampleRate, 96000)
  assert.deepEqual(dsp.dspScenes, scenes)
  continuity = false
  staleAck = true
  const status = await dsp.applyNativeDspGraph('stale ACK', graph)
  assert.equal(status.applyState, 'failed')
  assert.match(status.applyError ?? '', /ACK revision mismatch/)
})
