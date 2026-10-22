import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import {
  compensatedAuditionGraph,
  matchAuditionLoudness,
  normalizeAuditionGraph
} from './dspAudition.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, type DspGraphConfig } from './dspGraph.ts'

test('reactive EQ scenes produce detached cloneable audition data without mutating the draft', () => {
  const graph = reactive<DspGraphConfig>({
    version: 2,
    outputStage: { ...DEFAULT_DSP_OUTPUT_STAGE },
    nodes: [
      {
        id: 'eq',
        type: 'equalizer',
        enabled: true,
        params: {
          mode: 'parametric',
          preampDb: -2,
          bands: [{ frequency: 1000, gain: -3, q: 1.2, filterType: 'peak', enabled: false }]
        }
      }
    ]
  })
  const normalized = normalizeAuditionGraph(graph)
  assert.deepEqual(structuredClone(normalized), normalized)
  assert.deepEqual(normalized.nodes[0].params, {
    mode: 'parametric',
    preampDb: -2,
    bands: [{ frequency: 1000, gain: -3, q: 1.2, filterType: 'peak', enabled: false }]
  })
  const compensated = compensatedAuditionGraph(graph, -4)
  assert.equal(compensated.nodes[0].params.preampDb, -6)
  assert.equal(graph.nodes[0].params.preampDb, -2)
  ;(graph.nodes[0].params.bands as Array<{ gain: number }>)[0].gain = 5
  assert.equal((normalized.nodes[0].params.bands as Array<{ gain: number }>)[0].gain, -3)
  graph.nodes[0].params.preampDb = Number.NaN
  assert.throws(() => normalizeAuditionGraph(graph), /EQ 参数无效/)
})

test('matching only attenuates and respects the common true peak ceiling', () => {
  const result = matchAuditionLoudness(
    { integratedLufs: -14, truePeakDb: -0.2, processingVersion: 1 },
    { integratedLufs: -20, truePeakDb: -0.5, processingVersion: 1 }
  )
  assert.equal(result.targetLufs, -20.5)
  assert.equal(result.gainA, -6.5)
  assert.equal(result.gainB, -0.5)
  assert.throws(
    () =>
      matchAuditionLoudness(
        { integratedLufs: -14, truePeakDb: -2, processingVersion: 0 },
        { integratedLufs: -20, truePeakDb: -2, processingVersion: 1 }
      ),
    /处理后/
  )
})

test('audition rejects unsupported graphs and compensation never mutates the scene', () => {
  const graph: DspGraphConfig = {
    version: 2,
    nodes: [],
    outputStage: { ...DEFAULT_DSP_OUTPUT_STAGE }
  }
  const result = compensatedAuditionGraph(graph, -6)
  assert.equal(
    normalizeAuditionGraph({
      ...graph,
      nodes: [{ id: 'meter', type: 'meter', enabled: true, params: {} }]
    }).nodes.length,
    0
  )
  assert.equal(graph.nodes.length, 0)
  assert.equal(result.nodes[0].params.preampDb, -6)
  assert.throws(() => compensatedAuditionGraph(graph, -25), /补偿/)
  assert.throws(
    () =>
      normalizeAuditionGraph({
        ...graph,
        nodes: [{ id: 'x', type: 'compressor', enabled: true, params: {} }]
      }),
    /仅支持/
  )
  assert.throws(
    () =>
      normalizeAuditionGraph({ ...graph, outputStage: { ...graph.outputStage, dither: 'tpdf' } }),
    /抖动/
  )
})
