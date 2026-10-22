<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { createDspFactoryScene } from '../../../shared/dspGraph.ts'
import type {
  DspAsset,
  DspAssetKind,
  DspCorrectionProfile,
  DspFactorySceneTemplateId,
  DspGraphNode,
  DspGraphStatus,
  DspNodeType,
  DspScene,
  DspSceneState,
  Vst3CatalogState
} from '../../../shared/dspGraph.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import DspGraphCanvas from './dsp-rack/DspGraphCanvas.vue'
import DspNodeEditor from './dsp-rack/DspNodeEditor.vue'
import DspScenePane from './dsp-rack/DspScenePane.vue'
import DspSceneRules from './dsp-rack/DspSceneRules.vue'
import DspLibrary from './dsp-rack/DspLibrary.vue'
import DspMonitor from './dsp-rack/DspMonitor.vue'
import DspOutputPanel from './dsp-rack/DspOutputPanel.vue'
import DspAuditionPanel from './dsp-rack/DspAuditionPanel.vue'
import {
  nodeCatalog,
  normalizeNodeEditorParams,
  singletonNodeTypes,
  cloneNodeParams
} from '@renderer/utils/dspNodeParams'
import { cloneDspScene as cloneScene, submitDspSceneDraft } from '@renderer/utils/dspSceneDraft'
import {
  createDspDraftHistory,
  createDspDiagnosticsPoller,
  dspAssetReferences,
  moveDspNode,
  normalizeDspSerialOrder
} from '@renderer/utils/dspWorkbench'
import type { DspWorkspaceTab } from '@renderer/utils/dspWorkbench'

const props = defineProps<{ tab?: DspWorkspaceTab; visible?: boolean; hostDocument?: Document }>()
const emit = defineEmits<{
  status: [status: DspGraphStatus | null]
  scene: [name: string]
  dirty: [dirty: boolean]
  diagnosticError: [error: string]
  state: [state: DspSceneState]
  navigate: [tab: DspWorkspaceTab]
}>()
const { isPlaying } = usePlayerStore()
const outputStore = useAudioOutputDspStore()
const { audioProcessing, outputInfo } = storeToRefs(outputStore)
const state = ref<DspSceneState | null>(null)
const saved = shallowRef<DspSceneState | null>(null)
const status = shallowRef<DspGraphStatus | null>(null)
const selectedSceneId = ref<string | null>(null)
const selectedNodeId = ref<string | null>(null)
const editor = ref<'node' | 'rules' | 'output'>('node')
const narrowView = ref<'chain' | 'editor'>('chain')
const factoryTemplate = ref<DspFactorySceneTemplateId>('transparent')
const snapshotA = shallowRef<DspScene[] | null>(null)
const busy = ref(false)
const outputBusy = ref(false)
const loading = ref(true)
const message = ref('')
const error = ref('')
const diagnosticsError = ref('')
const assets = ref<DspAsset[]>([])
const vst3Catalog = shallowRef<Vst3CatalogState | null>(null)
const audition = ref<InstanceType<typeof DspAuditionPanel> | null>(null)
const auditionOpen = ref(false)
const auditionMounted = ref(false)
const confirm = (message: string) => (props.hostDocument?.defaultView ?? window).confirm(message)
const scenes = computed(() => state.value?.scenes ?? [])
const selectedScene = computed(
  () => scenes.value.find((scene) => scene.id === selectedSceneId.value) ?? scenes.value[0] ?? null
)
const selectedNode = computed(
  () => selectedScene.value?.graph.nodes.find((node) => node.id === selectedNodeId.value) ?? null
)
const activeSceneId = computed(
  () => status.value?.activeSceneId ?? state.value?.activeSceneId ?? null
)
const savedScenes = computed(() => saved.value?.scenes ?? [])
const serialize = () =>
  JSON.stringify({ scenes: scenes.value, pinnedSceneId: state.value?.pinnedSceneId ?? null })
const savedKey = computed(() =>
  JSON.stringify({ scenes: savedScenes.value, pinnedSceneId: saved.value?.pinnedSceneId ?? null })
)
const dirty = computed(() => !!state.value && serialize() !== savedKey.value)
const history = createDspDraftHistory(serialize())
const historyRevision = ref(0)
const canUndo = computed(() => {
  void historyRevision.value
  return history.canUndo
})
const canRedo = computed(() => {
  void historyRevision.value
  return history.canRedo
})
let historyTimer: ReturnType<typeof setTimeout> | null = null
let gesture = false
let restoring = false
let disposed = false
function cancelHistoryTimer(): void {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = null
}
function checkpoint(): void {
  cancelHistoryTimer()
  history.push(serialize())
  historyRevision.value++
}
function beginGesture(): void {
  checkpoint()
  gesture = true
}
function endGesture(): void {
  gesture = false
  checkpoint()
}
function finishPointerGesture(): void {
  if (gesture) void nextTick(endGesture)
}
watch(
  serialize,
  () => {
    if (restoring || loading.value) return
    cancelHistoryTimer()
    if (!gesture) historyTimer = setTimeout(checkpoint, 450)
  },
  { flush: 'sync' }
)
watch(dirty, (value) => emit('dirty', value))
watch(
  () => props.tab,
  () => {
    message.value = ''
  }
)
function travel(direction: 'undo' | 'redo'): void {
  checkpoint()
  restoring = true
  const next = JSON.parse(direction === 'undo' ? history.undo() : history.redo())
  if (state.value) {
    state.value.scenes = next.scenes
    state.value.pinnedSceneId = next.pinnedSceneId
  }
  restoring = false
  historyRevision.value++
  repairSelection()
}
function repairSelection(): void {
  if (!scenes.value.some((scene) => scene.id === selectedSceneId.value))
    selectedSceneId.value = scenes.value[0]?.id ?? null
  if (!selectedScene.value?.graph.nodes.some((node) => node.id === selectedNodeId.value))
    selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
}
function adopt(next: DspSceneState): void {
  restoring = true
  next.scenes.forEach((scene) => {
    scene.graph.nodes.forEach(normalizeNodeEditorParams)
    normalizeDspSerialOrder(scene.graph.nodes)
  })
  if (!selectedSceneId.value) selectedSceneId.value = next.activeSceneId
  state.value = JSON.parse(JSON.stringify(next))
  saved.value = JSON.parse(JSON.stringify(next))
  repairSelection()
  history.reset(serialize())
  cancelHistoryTimer()
  historyRevision.value++
  restoring = false
  emit('scene', next.scenes.find((scene) => scene.id === next.activeSceneId)?.name ?? '自动匹配')
  emit('state', JSON.parse(JSON.stringify(next)))
}
function selectScene(id: string): void {
  checkpoint()
  selectedSceneId.value = id
  selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
  editor.value = 'node'
}
function selectNode(id: string): void {
  selectedNodeId.value = id
  editor.value = 'node'
  narrowView.value = 'editor'
}
async function focusRuntimeNode(id: string): Promise<void> {
  if (!(await requestLeave())) return
  const active = scenes.value.find((scene) => scene.id === activeSceneId.value)
  if (!active?.graph.nodes.some((node) => node.id === id)) return
  selectScene(active.id)
  selectNode(id)
}
function showEditor(next: 'rules' | 'output'): void {
  editor.value = next
  narrowView.value = 'editor'
}
function addScene(): void {
  if (!state.value) return
  const next = createDspFactoryScene('transparent', `scene-${crypto.randomUUID()}`)
  next.name = `新场景 ${scenes.value.length + 1}`
  state.value.scenes.push(next)
  selectScene(next.id)
  editor.value = 'rules'
  checkpoint()
}
function addFactoryScene(): void {
  if (!state.value) return
  const next = createDspFactoryScene(factoryTemplate.value, `factory-${crypto.randomUUID()}`)
  state.value.scenes.push(next)
  selectScene(next.id)
  checkpoint()
}
function duplicateScene(): void {
  if (!state.value || !selectedScene.value) return
  const next = cloneScene(
    selectedScene.value,
    `scene-${crypto.randomUUID()}`,
    `${selectedScene.value.name} 副本`
  )
  state.value.scenes.push(next)
  selectScene(next.id)
  checkpoint()
}
function removeScene(): void {
  const scene = selectedScene.value
  if (!state.value || !scene || scenes.value.length <= 1) return
  if (!confirm(`删除场景“${scene.name}”？保存后生效。`)) return
  state.value.scenes = scenes.value.filter((item) => item.id !== scene.id)
  if (state.value.pinnedSceneId === scene.id) state.value.pinnedSceneId = null
  repairSelection()
  checkpoint()
}
function addNode(type: DspNodeType): void {
  const scene = selectedScene.value
  const item = nodeCatalog.find((entry) => entry.type === type)
  if (!scene || !item) return
  const existing =
    singletonNodeTypes.has(type) && scene.graph.nodes.find((node) => node.type === type)
  if (existing) {
    selectNode(existing.id)
    return
  }
  const node: DspGraphNode = {
    id: `${type}-${crypto.randomUUID()}`,
    type,
    enabled: type === 'meter',
    ...(type === 'nativePlugin' ? { pluginAbiVersion: 2 as const } : {}),
    params: cloneNodeParams(item.params)
  }
  scene.graph.nodes.push(node)
  normalizeDspSerialOrder(scene.graph.nodes)
  normalizeNodeEditorParams(node)
  selectNode(node.id)
  checkpoint()
}
function removeNode(id: string): void {
  if (!selectedScene.value) return
  selectedScene.value.graph.nodes = selectedScene.value.graph.nodes.filter((node) => node.id !== id)
  repairSelection()
  checkpoint()
}
function moveNode(id: string, destination: string): void {
  if (selectedScene.value && moveDspNode(selectedScene.value.graph.nodes, id, destination))
    checkpoint()
}
function resetNode(): void {
  const node = selectedNode.value
  const defaults = nodeCatalog.find((item) => item.type === node?.type)
  if (!node || !defaults) return
  node.params = cloneNodeParams(defaults.params)
  normalizeNodeEditorParams(node)
  checkpoint()
}
const vst3HelpersNotice = computed(() => {
  const helpers = vst3Catalog.value?.helpers
  if (!/win/i.test(navigator.platform) || helpers?.platformSupported === false)
    return 'VST3 仅支持 Windows x64。'
  if (helpers && (!helpers.scannerPresent || !helpers.hostPresent))
    return '本构建缺少 VST3 扫描或宿主组件。请安装完整 Windows 构建。'
  return ''
})
const poller = createDspDiagnosticsPoller({
  visible: () => !!props.visible && !(props.hostDocument ?? document).hidden,
  playing: () => isPlaying.value,
  read: async () => {
    try {
      const next = await window.api.audioEngine.getDspGraphStatus()
      if (disposed) return
      status.value = next
      diagnosticsError.value = ''
      emit('diagnosticError', '')
      emit('status', next)
      emit(
        'scene',
        savedScenes.value.find((scene) => scene.id === next.activeSceneId)?.name ?? '自动匹配'
      )
    } catch (cause) {
      diagnosticsError.value = cause instanceof Error ? cause.message : String(cause)
      status.value = null
      emit('status', null)
      emit('diagnosticError', diagnosticsError.value)
      throw cause
    }
  }
})
function visibilityChanged(): void {
  poller.update()
}
function observeDocument(doc: Document, observe: boolean): void {
  if (observe) {
    doc.addEventListener('visibilitychange', visibilityChanged)
    doc.addEventListener('pointerup', finishPointerGesture, true)
    doc.addEventListener('pointercancel', finishPointerGesture, true)
    doc.defaultView?.addEventListener('blur', finishPointerGesture)
  } else {
    doc.removeEventListener('visibilitychange', visibilityChanged)
    doc.removeEventListener('pointerup', finishPointerGesture, true)
    doc.removeEventListener('pointercancel', finishPointerGesture, true)
    doc.defaultView?.removeEventListener('blur', finishPointerGesture)
  }
}
watch(
  () => props.hostDocument,
  (next, previous) => {
    observeDocument(previous ?? document, false)
    observeDocument(next ?? document, true)
    poller.update()
  }
)
watch(
  () => [props.visible, isPlaying.value],
  () => poller.update()
)
async function run(action: () => Promise<void>): Promise<boolean> {
  if (busy.value || outputBusy.value || loading.value) return false
  busy.value = true
  error.value = ''
  message.value = ''
  checkpoint()
  try {
    await action()
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    busy.value = false
  }
}
async function finishAudition(): Promise<boolean> {
  return (await audition.value?.end()) ?? true
}
async function toggleAudition(event: Event): Promise<void> {
  const details = event.target as HTMLDetailsElement
  if (details.open) {
    auditionMounted.value = true
    auditionOpen.value = true
  } else if (await finishAudition()) {
    auditionOpen.value = false
  } else {
    auditionOpen.value = true
    details.open = true
  }
}
async function saveScenes(): Promise<boolean> {
  if (!(await finishAudition())) return false
  return run(async () => {
    if (!state.value) return
    const drafts = scenes.value.map((scene) => cloneScene(scene))
    drafts.forEach((scene) => scene.graph.nodes.forEach(normalizeNodeEditorParams))
    let next = await submitDspSceneDraft(window.api.audioEngine, drafts, state.value.pinnedSceneId)
    if (
      next.requiresPcmFallback &&
      !next.dsdPcmFallbackApplied &&
      confirm('场景已保存。停止 DSD Direct / DoP 直通并转换为 PCM 以运行 DSP？')
    )
      next = await window.api.audioEngine.applyDspScene(next.pinnedSceneId, true)
    adopt(next)
    await refreshSavedAssetReferences()
    message.value =
      next.requiresPcmFallback && !next.dsdPcmFallbackApplied
        ? '场景已保存；保持 DSD 直通。'
        : '已保存，等待引擎确认。'
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
async function pinScene(pin: string | null): Promise<void> {
  if (!(await requestLeave()) || !(await finishAudition())) return
  await run(async () => {
    const previousPin = saved.value?.pinnedSceneId ?? null
    let next = await window.api.audioEngine.applyDspScene(pin)
    if (next.requiresPcmFallback && !next.dsdPcmFallbackApplied) {
      if (confirm('停止 DSD Direct / DoP 直通并转换为 PCM，以应用此场景？'))
        next = await window.api.audioEngine.applyDspScene(pin, true)
      else {
        next = await window.api.audioEngine.applyDspScene(previousPin)
        message.value = '已取消，保持原场景与 DSD 直通。'
      }
    }
    adopt(next)
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
function discard(): void {
  if (saved.value) adopt(JSON.parse(JSON.stringify(saved.value)))
  message.value = '已还原到上次保存。'
}
const leaveDialog = ref(false)
const dialogRef = ref<HTMLElement | null>(null)
let leaveOpener: HTMLElement | null = null
let resolveLeave: ((answer: boolean) => void) | null = null
let leavePromise: Promise<boolean> | null = null
async function requestLeave(): Promise<boolean> {
  if (busy.value || outputBusy.value || loading.value) return false
  if (!(await finishAudition())) return false
  if (!dirty.value) return true
  if (leavePromise) return leavePromise
  checkpoint()
  leaveOpener = (props.hostDocument ?? document).activeElement as HTMLElement | null
  leaveDialog.value = true
  leavePromise = new Promise<boolean>((resolve) => {
    resolveLeave = resolve
  })
  void nextTick(() => dialogRef.value?.querySelector<HTMLButtonElement>('button')?.focus())
  return leavePromise
}
async function answerLeave(answer: 'save' | 'discard' | 'cancel'): Promise<void> {
  if (answer === 'save' && !(await saveScenes())) return
  if (answer === 'discard') discard()
  leaveDialog.value = false
  resolveLeave?.(answer !== 'cancel')
  resolveLeave = null
  leavePromise = null
  void nextTick(() => {
    if (leaveOpener?.isConnected) leaveOpener.focus()
  })
}
function trapDialog(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !busy.value) {
    event.stopPropagation()
    void answerLeave('cancel')
  }
  if (event.key !== 'Tab') return
  const buttons = [
    ...(dialogRef.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  ]
  const index = buttons.indexOf((props.hostDocument ?? document).activeElement as HTMLButtonElement)
  event.preventDefault()
  buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
}
async function refreshLibrary(): Promise<void> {
  ;[assets.value, vst3Catalog.value] = await Promise.all([
    window.api.audioEngine.getDspAssets(),
    window.api.audioEngine.getVst3Catalog()
  ])
}
async function refreshSavedAssetReferences(): Promise<void> {
  try {
    assets.value = await window.api.audioEngine.getDspAssets()
  } catch (cause) {
    // Persistence has succeeded. A library read failure must not turn a save
    // into a failed navigation decision; the engine still guards asset deletion.
    error.value = `场景已保存，但资料引用未能刷新：${cause instanceof Error ? cause.message : String(cause)}`
  }
}
async function reload(): Promise<void> {
  if (!(await requestLeave())) return
  await run(async () => {
    adopt(await window.api.audioEngine.getDspSceneState())
    await refreshLibrary()
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
async function syncFromEngine(): Promise<void> {
  if (!dirty.value) adopt(await window.api.audioEngine.getDspSceneState())
}
function applyCorrection(assetId: string, profile: DspCorrectionProfile): void {
  if (selectedNode.value?.type !== 'equalizer') return
  selectedNode.value.enabled = true
  selectedNode.value.params = {
    ...selectedNode.value.params,
    mode: 'parametric',
    preampDb: profile.preampDb,
    bands: profile.bands.map((band) => ({ ...band })),
    correctionAssetId: assetId,
    correctionFormat: profile.format
  }
  checkpoint()
}
async function bindAsset(asset: DspAsset): Promise<void> {
  if (asset.kind === 'correctionProfile') {
    await run(async () =>
      applyCorrection(asset.id, await window.api.audioEngine.getDspCorrectionProfile(asset.id))
    )
    return
  }
  const node = selectedNode.value
  if (asset.kind === 'impulseResponse' && node?.type === 'convolver') {
    node.params.impulseResponseAssetId = asset.id
    node.params.impulseResponsePath = ''
  }
  if ((asset.kind === 'vst3Preset' || asset.kind === 'vst3State') && node?.vst3)
    node.vst3 = { ...node.vst3, stateAssetId: asset.id }
  checkpoint()
}
async function importAsset(kind: DspAssetKind): Promise<void> {
  await run(async () => {
    const asset = await window.api.audioEngine.importDspAsset(kind)
    if (asset) {
      assets.value = await window.api.audioEngine.getDspAssets()
      if (kind === 'impulseResponse' && selectedNode.value?.type === 'convolver') {
        selectedNode.value.params.impulseResponseAssetId = asset.id
        selectedNode.value.params.impulseResponsePath = ''
      }
      if ((kind === 'vst3Preset' || kind === 'vst3State') && selectedNode.value?.vst3)
        selectedNode.value.vst3 = { ...selectedNode.value.vst3, stateAssetId: asset.id }
      checkpoint()
      message.value = `已导入 ${asset.name}。`
    }
  })
}
async function importCorrection(): Promise<void> {
  await run(async () => {
    const imported = await window.api.audioEngine.importDspCorrectionProfile()
    if (!imported) return
    assets.value = await window.api.audioEngine.getDspAssets()
    if (selectedNode.value?.type === 'equalizer')
      applyCorrection(imported.asset.id, imported.profile)
    message.value = `已导入 ${imported.profile.bands.length} 段校正。`
  })
}
async function selectCorrectionAsset(assetId: string): Promise<void> {
  if (!assetId && selectedNode.value) {
    delete selectedNode.value.params.correctionAssetId
    delete selectedNode.value.params.correctionFormat
    checkpoint()
    return
  }
  await run(async () =>
    applyCorrection(assetId, await window.api.audioEngine.getDspCorrectionProfile(assetId))
  )
}
async function removeAsset(id: string): Promise<void> {
  if (
    dspAssetReferences(scenes.value, id).length ||
    dspAssetReferences(savedScenes.value, id).length ||
    assets.value.find((item) => item.id === id)?.referenceCount
  )
    return
  if (confirm('永久删除此资料？'))
    await run(async () => {
      assets.value = await window.api.audioEngine.deleteDspAsset(id)
    })
}
async function exportProfile(): Promise<void> {
  if (await requestLeave())
    await run(async () => {
      await window.api.audioEngine.exportDspProfile(selectedScene.value?.name)
    })
}
async function importProfile(): Promise<void> {
  if (!(await requestLeave()) || !confirm('导入将替换全部场景与固定选择，并立即应用。继续？'))
    return
  await run(async () => {
    const imported = await window.api.audioEngine.importDspProfile()
    if (!imported) return
    adopt(imported.state)
    await refreshLibrary()
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
async function scanVst3(): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await window.api.audioEngine.scanVst3Plugins()
  })
}
async function recoverVst3(id: string): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await window.api.audioEngine.clearVst3Quarantine(id)
    message.value = '隔离重扫完成；插件需手动重新启用。'
  })
}
async function enableVst3(enabled: boolean): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await window.api.audioEngine.setVst3Enabled(enabled)
  })
}
async function addPath(): Promise<void> {
  await run(async () => {
    const path = await window.api.audioEngine.selectVst3SearchPath()
    if (path)
      vst3Catalog.value = await window.api.audioEngine.setVst3SearchPaths([
        ...new Set([...(vst3Catalog.value?.searchPaths ?? []), path])
      ])
  })
}
async function removePath(path: string): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await window.api.audioEngine.setVst3SearchPaths(
      vst3Catalog.value?.searchPaths.filter((item) => item !== path) ?? []
    )
  })
}
function keydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || busy.value || leaveDialog.value || props.tab === 'equalizer') return
  if (!(event.ctrlKey || event.metaKey)) return
  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveScenes()
  } else if (
    !(event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]') &&
    ['z', 'y'].includes(event.key.toLowerCase())
  ) {
    event.preventDefault()
    travel(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo')
  }
}
onMounted(async () => {
  try {
    adopt(await window.api.audioEngine.getDspSceneState())
    await refreshLibrary()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    observeDocument(props.hostDocument ?? document, true)
    poller.update()
  }
})
onBeforeUnmount(() => {
  disposed = true
  poller.stop()
  cancelHistoryTimer()
  observeDocument(props.hostDocument ?? document, false)
  resolveLeave?.(false)
})
defineExpose({
  requestLeave,
  syncFromEngine,
  finishAudition,
  focusRuntimeNode,
  refreshDiagnostics: poller.refreshAfterCurrent,
  dirty,
  busy: computed(() => busy.value || outputBusy.value),
  loading
})
</script>

<template>
  <section class="dsp-rack-content" @keydown="keydown">
    <div v-if="tab !== 'monitor'" class="draft-toolbar" :inert="outputBusy">
      <div>
        <span class="draft-dot" :class="{ dirty }"></span
        ><strong>{{ dirty ? '未保存更改' : '场景已保存' }}</strong
        ><span class="muted">正在编辑：{{ selectedScene?.name ?? '—' }}</span>
      </div>
      <div class="toolbar">
        <button
          class="icon-button"
          title="撤销 · Ctrl+Z"
          :disabled="!canUndo || busy"
          @click="travel('undo')"
        >
          <i class="pi pi-undo"></i>
        </button>
        <button
          class="icon-button"
          title="重做 · Ctrl+Shift+Z"
          :disabled="!canRedo || busy"
          @click="travel('redo')"
        >
          <i class="pi pi-refresh"></i>
        </button>
        <button :disabled="!dirty || busy" @click="discard">还原</button>
        <details class="profile-menu">
          <summary title="配置包与重新加载"><i class="pi pi-ellipsis-h"></i></summary>
          <div>
            <button :disabled="busy" @click="reload">重新加载</button
            ><button :disabled="busy" @click="importProfile">导入配置包</button
            ><button :disabled="busy" @click="exportProfile">导出配置包</button>
          </div>
        </details>
        <button class="primary-button" :disabled="!dirty || busy || loading" @click="saveScenes">
          <i class="pi pi-save"></i>{{ busy ? '处理中…' : '保存更改' }}
        </button>
      </div>
    </div>
    <p v-if="error" class="rack-message error" role="alert">{{ error }}</p>
    <p v-else-if="message" class="rack-message" role="status">{{ message }}</p>
    <p v-if="loading" class="empty-detail">正在读取音频引擎…</p>
    <fieldset
      v-else
      :disabled="busy || outputBusy || leaveDialog"
      :inert="busy || outputBusy || leaveDialog"
      class="rack-fields"
      :aria-busy="busy || outputBusy"
      @pointerdown.capture="beginGesture"
      @change="checkpoint"
    >
      <div v-show="tab === 'chain'" class="rack-layout" :data-narrow-view="narrowView">
        <DspScenePane
          :scenes="scenes"
          :selected-scene-id="selectedSceneId"
          :active-scene-id="activeSceneId"
          v-model:factory-template="factoryTemplate"
          @select="selectScene"
          @add="addScene"
          @duplicate="duplicateScene"
          @remove="removeScene"
          @add-factory="addFactoryScene"
        />
        <div class="chain-heading">
          <div>
            <h2>{{ selectedScene?.name }}</h2>
            <small class="muted">{{
              selectedScene?.id === activeSceneId
                ? '正在播放此场景'
                : '编辑草稿，不改变正在播放的场景'
            }}</small>
          </div>
          <div class="toolbar">
            <button :disabled="!selectedScene" @click="pinScene(selectedScene!.id)">
              <i class="pi pi-thumbtack"></i
              >{{
                saved?.pinnedSceneId === selectedScene?.id ? '已固定使用' : '固定使用此场景'
              }}</button
            ><button :disabled="!saved?.pinnedSceneId" @click="pinScene(null)">恢复自动匹配</button>
          </div>
        </div>
        <div class="narrow-tabs toolbar">
          <button :aria-pressed="narrowView === 'chain'" @click="narrowView = 'chain'">
            信号链</button
          ><button :aria-pressed="narrowView === 'editor'" @click="narrowView = 'editor'">
            参数
          </button>
        </div>
        <DspGraphCanvas
          :scene="selectedScene"
          :selected-node-id="editor === 'node' ? selectedNodeId : null"
          :busy="busy"
          @select-node="selectNode"
          @add-node="addNode"
          @remove-node="removeNode"
          @move-node="moveNode"
          @rules="showEditor('rules')"
          @output="emit('navigate', 'output')"
        />
        <section class="editor-pane">
          <div class="editor-tools toolbar">
            <button :aria-pressed="editor === 'rules'" @click="editor = 'rules'">场景规则</button
            ><button @click="emit('navigate', 'output')">输出级</button
            ><button v-if="editor === 'node' && selectedNode" @click="resetNode">重置参数</button>
          </div>
          <DspSceneRules v-if="editor === 'rules' && selectedScene" :model-value="selectedScene" />
          <DspNodeEditor
            v-else
            :scene="selectedScene"
            :node="selectedNode"
            :busy="busy"
            :assets="assets"
            :vst3-catalog="vst3Catalog"
            :vst3-helpers-ready="!vst3HelpersNotice"
            :sample-rate="outputInfo?.actualSampleRate || outputInfo?.outputSampleRate || 48000"
            :host-document="hostDocument"
            @import-asset="importAsset"
            @import-correction-profile="importCorrection"
            @select-correction-asset="selectCorrectionAsset"
            @scan-vst3="scanVst3"
            @recover-vst3="recoverVst3"
          />
          <p v-if="state?.requiresPcmFallback && !state.dsdPcmFallbackApplied" class="notice">
            DSD Direct / DoP 保持直通。运行 DSP 需确认转换为 PCM。
          </p>
          <p v-if="state?.directMode || audioProcessing.directMode" class="notice">
            Direct 模式正在旁路处理。
          </p>
        </section>
        <details class="audition-section" :open="auditionOpen" @toggle="toggleAudition">
          <summary>等响度 A / B <span class="muted">本地 PCM · 无处理或单 EQ</span></summary>
          <div v-if="auditionMounted" v-show="auditionOpen">
            <button @click="snapshotA = scenes.map((scene) => cloneScene(scene))">
              {{ snapshotA ? '重新记录 A 快照' : '记录 A 快照' }}</button
            ><DspAuditionPanel
              ref="audition"
              :current="state?.effectiveGraph ?? state?.graph"
              :a="snapshotA?.find((scene) => scene.id === selectedScene?.id)?.graph ?? null"
              :b="selectedScene?.graph ?? null"
            />
          </div>
        </details>
      </div>
      <DspLibrary
        v-show="tab === 'library'"
        :assets="assets"
        :catalog="vst3Catalog"
        :scenes="scenes"
        :saved-scenes="savedScenes"
        :selected-node="selectedNode"
        :notice="vst3HelpersNotice"
        :busy="busy"
        @import-asset="importAsset"
        @import-correction="importCorrection"
        @remove="removeAsset"
        @bind="bindAsset"
        @enable-vst3="enableVst3"
        @add-path="addPath"
        @remove-path="removePath"
        @scan="scanVst3"
        @recover="recoverVst3"
      />
      <section v-if="tab === 'output'" class="output-page">
        <div class="output-scene-strip">
          <label
            >正在编辑的场景<select
              :value="selectedSceneId"
              @change="selectScene(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
                {{ scene.name }}{{ scene.id === activeSceneId ? ' · 当前活动' : '' }}
              </option>
            </select></label
          ><span class="muted">{{
            selectedScene?.id === activeSceneId ? '当前活动场景' : '编辑此场景不改变正在播放的场景'
          }}</span>
        </div>
        <DspOutputPanel :scene="selectedScene" :status="status" @busy="outputBusy = $event" />
      </section>
      <DspMonitor
        v-if="tab === 'monitor'"
        :status="status"
        :error="diagnosticsError"
        :visible="visible"
        :host-document="hostDocument"
        @navigate="emit('navigate', $event)"
        @refresh="poller.refreshAfterCurrent().catch(() => undefined)"
      >
        <template #capture
          ><div class="capture-controls">
            <label class="switch-field"
              ><input
                type="checkbox"
                :checked="audioProcessing.fftEnabled"
                @change="
                  run(async () => {
                    await outputStore.setAudioProcessing(
                      { fftEnabled: ($event.target as HTMLInputElement).checked },
                      { throwOnError: true }
                    )
                  })
                "
              />开启 FFT 频谱采集</label
            ><label
              >FFT 分辨率<select
                :value="audioProcessing.fftResolution"
                @change="
                  run(async () => {
                    await outputStore.setAudioProcessing(
                      { fftResolution: Number(($event.target as HTMLSelectElement).value) },
                      { throwOnError: true }
                    )
                  })
                "
              >
                <option
                  v-for="size in [64, 128, 256, 512, 1024, 2048, 4096, 8192]"
                  :key="size"
                  :value="size"
                >
                  {{ size }}
                </option>
              </select></label
            >
          </div></template
        >
      </DspMonitor>
    </fieldset>
    <div v-if="leaveDialog" class="draft-dialog-backdrop" @keydown="trapDialog">
      <section
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsp-draft-title"
        class="draft-dialog"
      >
        <p class="eyebrow">DSP / DRAFT</p>
        <h2 id="dsp-draft-title">保存效果链更改？</h2>
        <p>保存会更新全部场景，并重新应用当前活动场景。</p>
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <div class="toolbar">
          <button :disabled="busy" @click="answerLeave('cancel')">取消</button
          ><button :disabled="busy" @click="answerLeave('discard')">放弃更改</button
          ><button class="primary-button" :disabled="busy" @click="answerLeave('save')">
            {{ busy ? '正在保存…' : '保存更改' }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
