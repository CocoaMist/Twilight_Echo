import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDspDraftHistory,
  createDspDiagnosticsPoller,
  dspApplyLabel,
  dspAssetReferences,
  moveDspNode,
  normalizeDspSerialOrder
} from './dspWorkbench.ts'
import { createDspFactoryScene, type DspGraphStatus } from '../../../shared/dspGraph.ts'
import { dspSampleRate, dspSignalNodes } from './dspSignalOverview.ts'
import type { DspSceneState } from '../../../shared/dspGraph.ts'

test('signal overview uses runtime order and state without presenting a saved intention as active', () => {
  const scene = createDspFactoryScene('headphoneCorrection', 'active')
  const state = { scenes: [scene], activeSceneId: scene.id } as DspSceneState
  const pending = dspSignalNodes(state, null, false)
  assert.ok(pending.every((node) => !node.active && node.state !== '运行中'))
  const saved = scene.graph.nodes[0]
  const status = {
    activeSceneId: scene.id,
    nodes: [
      { id: 'runtime-only', type: 'meter', enabled: true, active: true, bypassed: false },
      { ...saved, active: false, bypassed: true, bypassReason: 'direct' }
    ]
  } as DspGraphStatus
  const runtime = dspSignalNodes(state, status, false)
  assert.deepEqual(
    runtime.map((node) => node.id),
    ['runtime-only', saved.id]
  )
  assert.equal(runtime[0].state, '运行中')
  assert.equal(runtime[0].configured, false)
  assert.equal(runtime[1].state, '已旁路')
  assert.equal(runtime[1].reason, 'direct')
  assert.ok(
    dspSignalNodes(state, status, true).every((node) => !node.active && node.state === '已旁路')
  )
})

test('unknown sample rates remain unknown and known rates keep their precision', () => {
  assert.equal(dspSampleRate(44100), '44.1 kHz')
  assert.equal(dspSampleRate(96000), '96 kHz')
  for (const rate of [null, undefined, NaN, Infinity, 0, -1])
    assert.equal(dspSampleRate(rate), '— kHz')
})

test('applied means matching requested, acknowledged and native revisions', () => {
  const status = {
    applyState: 'applied',
    requestedRevision: 8,
    appliedRevision: 7,
    revision: 7
  } as DspGraphStatus
  assert.equal(dspApplyLabel(null), '等待引擎')
  assert.equal(dspApplyLabel(status), '等待引擎确认')
  status.appliedRevision = 8
  assert.equal(dspApplyLabel(status), '等待引擎确认')
  status.revision = 8
  assert.equal(dspApplyLabel(status), '已生效')
  assert.equal(dspApplyLabel({ ...status, applyState: 'failed' }), '应用失败')
})

test('asset references include bypassed nodes and all persisted reference fields', () => {
  const scene = createDspFactoryScene('transparent', 'one')
  scene.graph.nodes.push(
    { id: 'ir', type: 'convolver', enabled: false, params: { impulseResponseAssetId: 'ir' } },
    { id: 'eq', type: 'equalizer', enabled: true, params: { correctionAssetId: 'correction' } },
    {
      id: 'vst',
      type: 'vst3Plugin',
      enabled: false,
      params: {},
      vst3: { catalogId: 'plugin', classId: 'class', stateAssetId: 'state' }
    }
  )
  for (const id of ['ir', 'correction', 'state'])
    assert.deepEqual(dspAssetReferences([scene], id), [scene.name])
  assert.deepEqual(dspAssetReferences([scene], 'unused'), [])
})

test('serial sorting allows v2 plugins but leaves ABI v1 fixed', () => {
  const nodes = [
    { id: 'one', type: 'equalizer' as const, enabled: true, params: {} },
    {
      id: 'two',
      type: 'nativePlugin' as const,
      pluginAbiVersion: 2 as const,
      enabled: true,
      params: {}
    },
    {
      id: 'v1',
      type: 'nativePlugin' as const,
      pluginAbiVersion: 1 as const,
      enabled: true,
      params: {}
    }
  ]
  assert.equal(moveDspNode(nodes, 'two', 'one'), true)
  assert.deepEqual(
    nodes.map((node) => node.id),
    ['two', 'one', 'v1']
  )
  assert.equal(moveDspNode(nodes, 'v1', 'two'), false)
  assert.equal(moveDspNode(nodes, 'one', 'v1'), false)
  assert.equal(moveDspNode(nodes, 'missing', 'one'), false)
  nodes.push({ id: 'last', type: 'equalizer', enabled: false, params: {} })
  normalizeDspSerialOrder(nodes)
  assert.deepEqual(
    nodes.map((node) => node.id),
    ['two', 'one', 'last', 'v1']
  )
})

test('draft checkpoints group gestures, travel and invalidate abandoned redo branches', () => {
  const history = createDspDraftHistory('saved')
  assert.equal(history.canUndo, false)
  history.push('gesture-end')
  history.push('gesture-end')
  assert.equal(history.undo(), 'saved')
  assert.equal(history.canUndo, false)
  assert.equal(history.redo(), 'gesture-end')
  history.undo()
  history.push('new-branch')
  assert.equal(history.canRedo, false)
  history.reset('reloaded')
  assert.equal(history.canUndo, false)
  assert.equal(history.redo(), 'reloaded')
})

test('post-write diagnostics wait for an older read then request a fresh acknowledgement', async () => {
  const releases: Array<() => void> = []
  let calls = 0
  const poller = createDspDiagnosticsPoller({
    visible: () => false,
    playing: () => false,
    read: () => {
      calls++
      return new Promise((done) => releases.push(done))
    }
  })
  const old = poller.refresh()
  const fresh = poller.refreshAfterCurrent()
  assert.equal(calls, 1)
  releases.shift()!()
  await old
  await Promise.resolve()
  assert.equal(calls, 2)
  releases.shift()!()
  await fresh
  poller.stop()
})

test('diagnostics share one request, schedule at most 4 Hz and stop when hidden', async () => {
  let visible = true,
    playing = true,
    calls = 0
  let resolve!: () => void
  const tasks = new Map<number, { action: () => void; delay: number }>()
  let id = 0
  const poller = createDspDiagnosticsPoller({
    visible: () => visible,
    playing: () => playing,
    read: () => {
      calls++
      return new Promise<void>((done) => {
        resolve = done
      })
    },
    schedule: (action, delay) => {
      tasks.set(++id, { action, delay })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    cancel: (timer) => {
      tasks.delete(Number(timer))
    }
  })
  poller.update()
  poller.update()
  const refresh = poller.refresh()
  assert.equal(calls, 1)
  resolve()
  await refresh
  await Promise.resolve()
  assert.equal(tasks.size, 1)
  assert.equal([...tasks.values()][0].delay, 250)
  playing = false
  poller.update()
  const paused = poller.refresh()
  resolve()
  await paused
  await Promise.resolve()
  assert.equal(tasks.size, 1)
  assert.equal([...tasks.values()][0].delay, 1500)
  visible = false
  poller.update()
  assert.equal(tasks.size, 0)
  assert.equal(calls, 2)
  visible = true
  poller.update()
  const last = poller.refresh()
  poller.stop()
  resolve()
  await last
  await Promise.resolve()
  assert.equal(tasks.size, 0)
})
