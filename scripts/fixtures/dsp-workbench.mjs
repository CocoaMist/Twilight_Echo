import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import Workspace from '@renderer/components/AudioWorkspace.vue'
import { createDspFactoryScene } from '../../src/shared/dspGraph.ts'
import { defaultAudioProcessing } from '../../src/renderer/src/utils/equalizerPageLogic.ts'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import '@renderer/assets/base.css'
import '@renderer/assets/bohr.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/appearance.css'

const plain = (value) => JSON.parse(JSON.stringify(value))
const scene = createDspFactoryScene('headphoneCorrection', 'headphones')
scene.graph.nodes.find((node) => node.type === 'equalizer').params.bands = [
  { frequency: 1000, gain: -2, q: 1, enabled: true, filterType: 'peak', channelMask: 0 }
]
const second = createDspFactoryScene('roomCorrection', 'speakers')
let state = {
  scenes: [scene, second],
  pinnedSceneId: null,
  activeSceneId: scene.id,
  graph: plain(scene.graph),
  requiresPcmFallback: false,
  dsdPcmFallbackApplied: false
}
let revision = 1
let ack = 1
let failSave = false
let writes = 0
let sceneReads = 0
let assetReads = 0
let polls = 0
let pins = []
let confirmAnswer = true
let resamplerObservation = {}
const assets = [
  {
    id: 'ir-one',
    name: 'Studio room.wav',
    kind: 'impulseResponse',
    mediaType: 'audio/wav',
    byteSize: 2097152,
    referenceCount: 0,
    sourceChannels: 2,
    sourceSampleRate: 48000
  },
  {
    id: 'unused',
    name: 'Unused.wav',
    kind: 'impulseResponse',
    mediaType: 'audio/wav',
    byteSize: 65536,
    referenceCount: 0
  }
]
let catalog = {
  enabled: false,
  searchPaths: ['D:/Audio/VST3'],
  helpers: { platformSupported: true, scannerPresent: true, hostPresent: true },
  entries: []
}
window.confirm = () => confirmAnswer
window.api = {
  settings: {
    // Frozen so Vue's deep ref never proxies these objects: EqualizerPage
    // structuredClone()s them and rejects reactive proxies.
    get: async () => Object.freeze({
      audioProcessing: Object.freeze({ ...defaultAudioProcessing, dspEnabled: false, eqMode: 'parametric', eqEnabled: true }),
      audioEqPresets: Object.freeze([]),
      headphoneCompensation: Object.freeze({ enabled: false, bands: [] })
    }),
    set: async () => {}
  },
  opra: { getStatus: async () => ({ ready: true, profileCount: 0, productCount: 0 }) },
  window: {
    copyEqBands: async () => {},
    pasteEqBands: async () => [],
    popupContextMenu: async () => null,
    closeContextMenu: async () => {}
  },
  audioEngine: {
    getDspSceneState: async () => {
      sceneReads++
      return plain(state)
    },
    setDspScenes: async (scenes, pin) => {
      writes++
      if (failSave) throw Error('test engine rejected graph')
      revision++
      state = { ...state, scenes: plain(scenes), pinnedSceneId: pin }
      return plain(state)
    },
    applyDspScene: async (pin, confirm = false) => {
      pins.push([pin, confirm])
      state = {
        ...state,
        pinnedSceneId: pin,
        activeSceneId: pin ?? scene.id,
        dsdPcmFallbackApplied: confirm
      }
      revision++
      return plain(state)
    },
    getDspGraphStatus: async () => {
      polls++
      return {
        revision: ack,
        requestedRevision: revision,
        appliedRevision: ack,
        applyState: ack === revision ? 'applied' : 'pending',
        activeSceneId: state.activeSceneId,
        totalLatencyFrames: 128,
        totalTailFrames: 4096,
        nodes: [],
        meter: {
          integratedLufs: -19.7,
          shortTermLufs: -18.9,
          momentaryLufs: -20.3,
          loudnessRangeLu: 7.2,
          truePeakDb: -2.8,
          correlation: 0.89,
          clipCount: 0
        },
        outputStage: {
          actualSampleRate: 48000,
          resamplerQuality: 'native',
          dither: 'off',
          active: true,
          ...resamplerObservation
        }
      }
    },
    getDspAssets: async () => {
      assetReads++
      return plain(assets)
    },
    getVst3Catalog: async () => plain(catalog),
    setVst3Enabled: async (enabled) => {
      catalog.enabled = enabled
      return plain(catalog)
    },
    selectVst3SearchPath: async () => 'D:/NewVST3',
    setVst3SearchPaths: async (paths) => {
      catalog.searchPaths = paths
      return plain(catalog)
    },
    scanVst3Plugins: async () => plain(catalog),
    clearVst3Quarantine: async () => plain(catalog),
    exportDspProfile: async () => null,
    importDspProfile: async () => null,
    deleteDspAsset: async (id) => {
      assets.splice(
        assets.findIndex((asset) => asset.id === id),
        1
      )
      return plain(assets)
    },
    audition: { end: async () => {}, status: async () => null }
  }
}
const workspace = ref(null)
const active = ref(true)
const app = createApp({
  setup: () => () => h(Workspace, { ref: workspace, active: active.value, initialTab: 'monitor' })
})
// The migrated workbench speaks the Core DSP protocol; translate it onto the
// engine stubs this fixture already maintains.
window.auditCore = {
  state: { value: { versionsRevision: 1 } },
  status: { value: null },
  queries: [],
  query: async (name) => {
    this?.queries?.push?.(name)
    window.__coreQueries = window.__coreQueries || []
    window.__coreQueries.push(name)
    if (name === 'audio.dsp')
      return {
        revision,
        processing: { ...defaultAudioProcessing, dspEnabled: false, eqMode: 'parametric', eqEnabled: true },
        autoPreamp: null,
        scenes: plain(state),
        convolver: { loaded: false, active: false, bypassed: false, irResampled: false, path: '', sampleRate: 0 }
      }
    if (name === 'audio.dsp.status') return window.api.audioEngine.getDspGraphStatus()
    if (name === 'audio.dsp.assets') { const items = window.api.audioEngine.getDspAssets(); return { revision, total: items.length, items } }
    if (name === 'audio.vst3')
      return { revision, enabled: false, searchPaths: [], total: 0, items: [] }
    if (name === 'opra.status') return window.api.opra.getStatus()
    if (name === 'opra.search') return { status: window.api.opra.getStatus(), items: [] }
    throw new Error('unexpected workbench query ' + name)
  },
  command: async (name, payload) => {
    if (name === 'audio.dsp.edit') {
      const edit = payload.edit
      if (edit.kind === 'scenes') await window.api.audioEngine.setDspScenes(edit.scenes, edit.pinnedSceneId)
      else if (edit.kind === 'apply') await window.api.audioEngine.applyDspScene(edit.id, edit.confirmDsdPcmFallback)
      else throw new Error('unexpected workbench edit ' + edit.kind)
      return null
    }
    throw new Error('unexpected workbench command ' + name)
  }
}
const pinia = createPinia()
app.config.errorHandler = (error) => { console.error('WORKBENCH-VUE-ERROR', error && error.stack ? error.stack : error) }
app.use(pinia).mount('#app')
const output = useAudioOutputDspStore()
const player = usePlayerStore()
const tick = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await nextTick()
}
const check = (value, message) => {
  if (!value) throw Error(message)
}
const buttons = (root) => [...(root ?? document).querySelectorAll('button')]
const click = async (text, root) => {
  const node = buttons(root).find((node) => node.textContent.trim() === text)
  check(node && !node.disabled, 'button unavailable: ' + text)
  node.click()
  await tick()
}
const change = async (node, value) => {
  check(node, 'missing input for change to ' + String(value))
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
  node.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
window.runWorkbenchCases = async () => {
  await tick()
  check(writes === 0 && !output.audioProcessing.dspEnabled, 'opening enabled DSP or wrote a graph')
  check(
    document.querySelector('.workspace-tabs button[aria-current]').textContent.trim() === '总览',
    'DSP does not open on the overview'
  )
  check(
    document.querySelector('.workspace-tabs button').textContent.trim() === '总览',
    'overview is not first'
  )
  check(
    !document.querySelector('.signal-dialog').open && document.querySelector('.signal-summary'),
    'signal details should start collapsed, with a compact path summary'
  )
  const beforeDisclosure = JSON.stringify(output.audioProcessing)
  document.querySelector('.monitor-tuning-zone').open = true
  document.querySelector('.diagnostic-details').open = true
  await tick()
  check(document.querySelector('.diagnostic-timing').textContent.includes('512'), 'actual buffer missing from diagnostics')
  check(JSON.stringify(output.audioProcessing) === beforeDisclosure && writes === 0, 'disclosure changed audio settings')
  document.querySelector('.monitor-tuning-zone').open = false
  document.querySelector('.diagnostic-details').open = false
  check(
    !document.querySelector('.scope-grid path[stroke]').getAttribute('d'),
    'idle scope fabricates a spectrum'
  )
  player.isPlaying.value = true
  player.visualizationData.value = {
    active: true,
    spectrum: Array.from({ length: 256 }, (_, i) => 0.3 + 0.15 * Math.sin(i / 10)),
    sampleRate: 48000,
    peakDb: -5.3,
    rmsDb: -18.2
  }
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 80))
  check(
    document.querySelector('.scope-grid path[stroke]').getAttribute('d')?.startsWith('M'),
    'live source did not draw spectrum'
  )
  check(player.consumers.value === 1, 'scope did not acquire one shared consumer')
  output.audioProcessing = { ...output.audioProcessing, fftEnabled: false }
  await tick()
  check(player.consumers.value === 0, 'FFT off retained spectrum demand')
  check(document.querySelector('.scope-empty')?.textContent.includes('FFT 采集未开启'), 'FFT off state is missing')
  output.audioProcessing = { ...output.audioProcessing, fftEnabled: true }
  await tick()
  document.querySelector('[aria-label="冻结频谱"]').click()
  await tick()
  const frozenPath = document.querySelector('.scope-grid path[stroke]').getAttribute('d')
  player.visualizationData.value = {
    ...player.visualizationData.value,
    spectrum: Array(256).fill(0.8)
  }
  await tick()
  check(
    document.querySelector('.scope-grid path[stroke]').getAttribute('d') === frozenPath,
    'freeze changed the displayed spectrum'
  )
  check(player.consumers.value === 0, 'frozen spectrum retained expensive demand')
  document.querySelector('[aria-label="继续频谱"]').click()
  await tick()
  active.value = false
  await tick()
  check(player.consumers.value === 0, 'hidden spectrum retained visualization consumer')
  active.value = true
  player.isPlaying.value = false
  player.visualizationData.value = {
    ...player.visualizationData.value,
    active: false,
    spectrum: []
  }
  await tick()
  await click('效果链')
  await click('场景规则')
  check(document.querySelector('.scene-settings'), 'scene rules missing: rack-error=' + (document.querySelector('.rack-message.error')?.textContent ?? 'none') + ' queries=' + (window.__coreQueries ?? []).join(','))
  await change(document.querySelector('.scene-settings input'), 'Headphones edited')
  check(
    document.querySelector('.draft-toolbar').textContent.includes('未保存'),
    'draft marker missing'
  )
  await click('均衡器')
  check(document.querySelector('[role=dialog]'), 'EQ did not protect scene draft')
  await click('取消', document.querySelector('[role=dialog]'))
  check(
    document.querySelector('.workspace-tabs [aria-current]').textContent.includes('效果链'),
    'cancel switched tab'
  )
  document.querySelector('[title="撤销 · Ctrl+Z"]').click()
  await tick()
  check(
    document.querySelector('.scene-settings input').value !== 'Headphones edited',
    'undo failed'
  )
  document.querySelector('[title="重做 · Ctrl+Shift+Z"]').click()
  await tick()
  check(
    document.querySelector('.scene-settings input').value === 'Headphones edited',
    'redo failed'
  )
  failSave = true
  await click('保存更改')
  check(
    document.querySelector('[role=alert]').textContent.includes('rejected'),
    'save failure invisible'
  )
  check(
    document.querySelector('.scene-settings input').value === 'Headphones edited',
    'failure discarded draft'
  )
  failSave = false
  await click('保存更改')
  check(state.pinnedSceneId === null, 'save pinned selected scene')
  check(
    document.querySelector('.workspace-status').textContent.includes(`ACK ${ack} / ${revision}`) &&
      !document.querySelector('.workspace-status').textContent.includes('已生效'),
    'submission reported applied without ACK'
  )
  ack = revision
  await new Promise((resolve) => setTimeout(resolve, 1600))
  await click('固定使用此场景')
  check(pins.at(-1)[0] === 'headphones', 'pin did not apply selected scene')
  await click('恢复自动匹配')
  check(pins.at(-1)[0] === null, 'automatic scene matching not restored')
  await click('信号链')
  await click('添加处理器')
  check(
    document.querySelector('.node-picker[role=dialog]'),
    'processor picker is not presented as a dialog'
  )
  check(
    document.querySelectorAll('.node-picker-results button').length === 17,
    'missing processor types'
  )
  await change(document.querySelector('[aria-label="搜索处理器"]'), 'compressor')
  check(
    document.querySelectorAll('.node-picker-results button').length >= 2,
    'processor search failed'
  )
  document.querySelector('.node-picker-results [data-node-type="compressor"]').click()
  await tick()
  check(
    document.querySelector('.detail-pane').textContent.includes('Compressor'),
    'processor editor missing'
  )
  const graphNodes = document.querySelectorAll('.graph-node')
  const compressor = [...graphNodes].find((node) => node.textContent.includes('Compressor'))
  const beforeOrder = [...graphNodes].map((node) => node.textContent)
  compressor.querySelector('[title="上移 · Alt+↑"]').click()
  await tick()
  check(
    [...document.querySelectorAll('.graph-node')].map((node) => node.textContent).join() !==
      beforeOrder.join(),
    'sort did not update chain'
  )
  await click('还原')
  // Bind a managed IR into the selected room scene, then protect draft references.
  await change(document.querySelector('.compact-scene-select'), 'speakers')
  check(
    document.querySelector('.scene-row.selected')?.textContent.includes('Room Correction'),
    'scene list did not follow the draft scene selector'
  )
  const convolver = [...document.querySelectorAll('.node-select')].find((node) =>
    node.textContent.includes('卷积')
  )
  convolver.click()
  await tick()
  await click('资料库')
  const firstAsset = document.querySelector('.asset-row')
  check(!firstAsset.querySelector('button')?.disabled || firstAsset.textContent.includes('绑定'), 'x')
  check(document.querySelector('.bind-target')?.classList.contains('ready'), 'bind target not ready: ' + (document.querySelector('.bind-target')?.textContent.slice(0,200) ?? 'NO BIND TARGET'))
  await click('绑定', firstAsset)
  check(
    firstAsset.querySelector('[title="请先解除保存场景和草稿中的引用"]').disabled,
    'draft resource deletion unprotected'
  )
  await click('总览')
  check(
    document.querySelector('.monitor-page').textContent.includes('-19.7'),
    'real meter fields not rendered'
  )
  const readsBefore = assetReads
  await new Promise((resolve) => setTimeout(resolve, 1700))
  check(assetReads === readsBefore, 'diagnostics reload resources')
  active.value = false
  await tick()
  const hiddenPolls = polls
  await new Promise((resolve) => setTimeout(resolve, 1700))
  check(polls === hiddenPolls, 'hidden workspace keeps polling')
  active.value = true
  await tick()
  await click('输出')
  document.querySelector('[aria-label="重采样质量"] input[value="soxrVhq"]').click()
  await tick()
  const resamplerNotice = () =>
    document.querySelector('.output-stage-panel .notice')?.textContent ?? ''
  check(
    resamplerNotice().includes('实际 SRC 未验证'),
    'a saved SoX choice claimed effective SRC without evidence'
  )
  resamplerObservation = {
    effectiveResampler: 'swr',
    effectiveResamplerQuality: 'ultra',
    effectiveResamplerFallback: true,
    resampled: true
  }
  await new Promise((resolve) => setTimeout(resolve, 1800))
  await tick()
  check(
    resamplerNotice().includes('实际 SWR Ultra'),
    'observed SoX fallback is missing from the output panel'
  )
  resamplerObservation = { effectiveResampler: 'none', resampled: false }
  await new Promise((resolve) => setTimeout(resolve, 1800))
  await tick()
  check(
    resamplerNotice().includes('本引擎未重采样'),
    'an equal-rate path claimed an active resampler'
  )
  resamplerObservation = {}
  const savedRate = state.scenes.find((scene) => scene.id === 'speakers').graph.outputStage
    .targetSampleRate
  const rateChoice = document.querySelector('[aria-label="输出采样率"] input[value="96000"]')
  check(rateChoice, 'output sample rate choices missing')
  rateChoice.click()
  await tick()
  check(
    state.scenes.find((scene) => scene.id === 'speakers').graph.outputStage.targetSampleRate ===
      savedRate,
    'output draft wrote before save'
  )
  check(
    document.querySelector('.draft-toolbar').textContent.includes('未保存'),
    'output draft not marked'
  )
  await click('保存更改')
  check(
    state.scenes.find((scene) => scene.id === 'speakers').graph.outputStage.targetSampleRate ===
      96000,
    'output rate not saved into selected scene'
  )
  await change(document.querySelector('[aria-label="请求缓冲大小"]'), '1024')
  check(output.bufferRequests.length === 0, 'buffer selection reopened device before apply')
  await click('应用缓冲')
  check(output.audioOutputConfig.preferredBufferSize === 1024, 'buffer request not applied')
  check(
    document.querySelector('.buffer-readouts').textContent.includes('512'),
    'requested buffer replaced actual device buffer'
  )
  output.bufferFailure = true
  await change(document.querySelector('[aria-label="请求缓冲大小"]'), '2048')
  await click('应用缓冲')
  check(
    document
      .querySelector('.buffer-panel [role=alert]')
      .textContent.includes('driver rejected buffer'),
    'buffer failure invisible'
  )
  check(
    output.audioOutputConfig.preferredBufferSize === 1024,
    'failed buffer request overwrote applied config'
  )
  output.bufferFailure = false
  await click('应用缓冲')
  check(
    !document.querySelector('.buffer-panel [role=alert]'),
    'successful buffer retry did not clear failure'
  )
  await click('效果链')
  await click('均衡器')
  check(document.querySelector('.eq-embedded'), 'real-time EQ not mounted: tab=' + (document.querySelector('.workspace-tabs button[aria-current]')?.textContent.trim() ?? '?'))
  check(!output.audioProcessing.dspEnabled, 'opening real-time EQ enabled master DSP')
  check(document.querySelector('.eq-band-table'), 'real-time frequency table missing: eq=' + (document.querySelector('.eq-page')?.textContent.slice(0, 260) ?? 'NO EQ PAGE'))
  check(document.querySelector('.workbench-opra'), 'OPRA not accessible from parameter EQ')
  await click('效果链')
  return { writes, sceneReads, assetReads, polls, pins: pins.length }
}
window.renderWorkbench = async (tab, tone = 'pureWhite', large = false) => {
  document.documentElement.dataset.theme = tone
  document.documentElement.style.setProperty('--te-font-size-body', large ? '20px' : '14px')
  await click(
    {
      chain: '效果链',
      monitor: '总览',
      library: '资料库',
      equalizer: '均衡器',
      output: '输出'
    }[tab]
  )
  if (tab === 'chain') document.querySelector('.node-select')?.click()
  await tick()
  const surface = document.querySelector('.audio-workspace')
  check(surface.scrollWidth <= surface.clientWidth, 'workspace horizontal overflow')
  check(document.documentElement.scrollWidth <= innerWidth, 'document horizontal overflow')
  const page = document.querySelector('.workspace-content')
  check(page.scrollWidth <= page.clientWidth, `${tab} content horizontal overflow`)
  return {
    width: surface.clientWidth,
    content: document.querySelector('.workspace-content').clientWidth
  }
}
window.renderGraphicWorkbench = async () => {
  await window.renderWorkbench('equalizer', 'pureWhite')
  await click('图形')
  await tick()
}
window.runPopoutCases = async () => {
  await click('场景规则')
  await change(document.querySelector('.scene-settings input'), 'Window draft')
  const editor = document.querySelector('.audio-workspace')
  const sceneInput = document.querySelector('.scene-settings input')
  const reads = sceneReads,
    beforeWrites = writes
  let child
  const nativeOpen = window.open.bind(window)
  window.open = (...args) => (child = nativeOpen(...args))
  try {
    await click('弹出窗口')
    check(child && !child.closed, 'DSP window did not open')
    check(
      child.document.querySelector('.audio-workspace') === editor,
      'popout recreated editor DOM'
    )
    check(
      child.document.querySelector('.scene-settings input') === sceneInput,
      'popout recreated draft editor'
    )
    check(sceneReads === reads && writes === beforeWrites, 'popout reloaded or wrote scene state')
    await change(sceneInput, 'Detached edit')
    await click('收回', child.document)
    check(document.querySelector('.audio-workspace') === editor, 'docking recreated editor DOM')
    check(sceneInput.value === 'Detached edit', 'docking lost draft')
    await click('弹出窗口')
    child.close()
    await tick()
    check(
      document.querySelector('.audio-workspace') === editor,
      'native close did not recover editor'
    )
    check(sceneInput.value === 'Detached edit', 'native close lost draft')
    check(
      sceneReads === reads && writes === beforeWrites,
      'window lifecycle initialized another writer'
    )
    await click('还原')
    return { sameEditor: true, sameDraft: true, additionalSceneReads: sceneReads - reads }
  } finally {
    window.open = nativeOpen
    if (child && !child.closed) child.close()
  }
}
window.workspaceForTest = workspace
window.appForTest = app
window.openDrawerForTest = async () => {
  const button = document.querySelector('.workspace-signal-button')
  button.focus()
  button.click()
  await tick()
  const drawer = document.querySelector('.signal-dialog')
  check(drawer.open, 'signal drawer did not open')
  check(drawer.contains(document.activeElement), 'signal drawer did not receive focus')
  check(drawer.textContent.includes('512'), 'actual buffer missing from signal details')
  check(!output.audioProcessing.dspEnabled, 'opening the signal path enabled DSP')
}
window.checkDrawerClosed = async () => {
  await tick()
  check(!document.querySelector('.signal-dialog').open, 'Escape did not close the signal drawer')
  check(document.activeElement === document.querySelector('.workspace-signal-button'), 'signal drawer did not restore focus')
}
