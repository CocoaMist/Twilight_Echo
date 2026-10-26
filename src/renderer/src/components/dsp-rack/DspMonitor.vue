<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  DEFAULT_DSP_STEREO_IMAGE,
  extractStereoImageFromGraph,
  type DspGraphStatus,
  type DspScene,
  type DspSceneState,
  type DspStereoImageConfig
} from '../../../../shared/dspGraph.ts'
import type {
  AudioProcessingSettings,
  DsdOutputMode,
  VolumeNormalizationMode
} from '../../../../shared/audioEngineTypes.ts'
import { describeResampler } from '../../../../shared/resamplerStatus.ts'
import { dspApplyLabel, type DspWorkspaceTab } from '@renderer/utils/dspWorkbench'
import { dspSampleRate } from '@renderer/utils/dspSignalOverview'
import { nodeLabel } from '@renderer/utils/dspNodeParams'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { projectSpectrumLevels } from '@renderer/utils/parametricEqInteraction'
import { frequencyToPercent, formatFrequency } from '@renderer/utils/eqViewport'
import { useEqSpectrum } from '@renderer/composables/useEqSpectrum'

const props = defineProps<{
  status: DspGraphStatus | null
  error: string
  visible?: boolean
  hostDocument?: Document
  scene?: DspScene | null
  sceneState?: DspSceneState | null
  assetCount?: number
  masterBusy?: boolean
}>()
const emit = defineEmits<{ navigate: [tab: DspWorkspaceTab]; refresh: []; master: [] }>()
const outputStore = useAudioOutputDspStore()
const {
  outputInfo,
  playbackInfo,
  audioProcessing,
  audioEngineReady,
  dspStereoImage,
  dspGraphStatus
} = storeToRefs(outputStore)
const { visualizationData, isPlaying, acquireVisualizationConsumer } = usePlayerStore()
const expanded = ref(false)
const frozen = ref(false)
const tuningBusy = ref(false)

const effectiveStatus = computed(() => props.status ?? dspGraphStatus?.value ?? null)

async function updateProcessing(patch: Partial<AudioProcessingSettings>): Promise<void> {
  if (tuningBusy.value) return
  tuningBusy.value = true
  try {
    await outputStore.setAudioProcessing(patch)
  } finally {
    tuningBusy.value = false
  }
}

const stereoImage = computed<DspStereoImageConfig>(() => {
  if (dspStereoImage?.value) return dspStereoImage.value
  const graph = props.sceneState?.effectiveGraph ?? props.sceneState?.graph ?? props.scene?.graph
  return graph ? extractStereoImageFromGraph(graph) : DEFAULT_DSP_STEREO_IMAGE
})

const stereoWidthPct = computed(() => Math.round(Number(stereoImage.value.width ?? 1) * 100))
const stereoBalancePct = computed(() => Math.round(Number(stereoImage.value.balance ?? 0) * 100))
const crossfeedStrengthPct = computed(() => {
  const raw = Number(audioProcessing.value.crossfeedStrength ?? 0)
  return Math.round(raw <= 1 ? raw * 100 : raw)
})
const convolverFileName = computed(() => {
  const path = audioProcessing.value.convolverIrPath
  return path ? path.split(/[\\/]/).pop() || path : ''
})

async function updateStereo(patch: Partial<DspStereoImageConfig>): Promise<void> {
  if (tuningBusy.value) return
  tuningBusy.value = true
  try {
    if (typeof outputStore.setStereoImage === 'function') {
      await outputStore.setStereoImage(patch)
    }
  } finally {
    tuningBusy.value = false
  }
}

async function resetStereoField(): Promise<void> {
  await updateStereo({
    balance: 0,
    width: 1,
    midGainDb: 0,
    sideGainDb: 0,
    mono: false,
    swap: false,
    invertLeft: false,
    invertRight: false
  })
}

const stereoModified = computed(() => {
  const st = stereoImage.value
  return (
    Math.abs(st.balance) > 1e-4 ||
    Math.abs(st.width - 1) > 1e-4 ||
    st.mono ||
    st.swap ||
    st.invertLeft ||
    st.invertRight
  )
})

const normalizationModes: Array<{
  id: VolumeNormalizationMode
  label: string
}> = [
  { id: 'off', label: '关闭' },
  { id: 'track', label: '单曲增益' },
  { id: 'album', label: '专辑增益' },
  { id: 'loudnorm', label: 'R128 响度' }
]

const dsdModes: Array<{ id: DsdOutputMode; label: string }> = [
  { id: 'auto', label: '自动策略' },
  { id: 'dop', label: 'DoP 封装' },
  { id: 'native', label: 'Native 直通' },
  { id: 'pcm', label: '转 PCM' }
]

function signedDb(value: number | undefined): string {
  const num = Number(value ?? 0)
  return `${num >= 0 ? `+${num.toFixed(1)}` : num.toFixed(1)} dB`
}

const actualRate = computed(
  () =>
    !audioEngineReady.value ? 0 :
    outputInfo.value?.actualSampleRate ||
    outputInfo.value?.outputSampleRate ||
    effectiveStatus.value?.outputStage?.actualSampleRate ||
    playbackInfo.value?.actualSampleRate ||
    playbackInfo.value?.outputSampleRate ||
    0
)

const effectiveBuffer = computed(
  () => !audioEngineReady.value ? 0 : outputInfo.value?.bufferSizeFrames || playbackInfo.value?.bufferSizeFrames || 0
)

const effectiveLatencyMs = computed(() => {
  if (!audioEngineReady.value) return null
  const direct =
    outputInfo.value?.latencyMs ||
    outputInfo.value?.latencyInfo?.totalLatencyMs ||
    outputInfo.value?.latencyInfo?.outputLatencyMs ||
    outputInfo.value?.latencyInfo?.bufferLatencyMs ||
    playbackInfo.value?.latencyMs ||
    playbackInfo.value?.latencyInfo?.totalLatencyMs ||
    0
  if (direct > 0) return direct
  if (effectiveBuffer.value > 0 && actualRate.value > 0) {
    return (effectiveBuffer.value / actualRate.value) * 1000
  }
  return null
})

const levels = computed(() =>
  audioEngineReady.value &&
  audioProcessing.value.fftEnabled &&
  isPlaying.value &&
  visualizationData.value.active &&
  visualizationData.value.spectrum.length > 1 &&
  (visualizationData.value.sampleRate || actualRate.value) > 0
    ? projectSpectrumLevels(
        visualizationData.value.spectrum,
        visualizationData.value.sampleRate || actualRate.value,
        240
      )
    : null
)
const spectrum = useEqSpectrum({
  levels: () => levels.value,
  visible: () => props.visible !== false,
  frozen: () => frozen.value,
  document: () => props.hostDocument ?? document
})
const peakHold = spectrum.peakHold
let release: (() => void) | null = null
let mounted = false
function updateConsumer(): void {
  const needed =
    mounted &&
    props.visible !== false &&
    audioEngineReady.value &&
    audioProcessing.value.fftEnabled &&
    isPlaying.value &&
    !frozen.value &&
    !(props.hostDocument ?? document).hidden
  if (needed && !release) release = acquireVisualizationConsumer({ spectrumPoints: 2048 })
  if (!needed && release) {
    release()
    release = null
  }
}
watch(
  () => [props.visible, isPlaying.value, frozen.value, audioProcessing.value.fftEnabled, audioEngineReady.value],
  updateConsumer
)
watch(
  () => props.hostDocument,
  (next, previous) => {
    ;(previous ?? document).removeEventListener('visibilitychange', updateConsumer)
    if (mounted) (next ?? document).addEventListener('visibilitychange', updateConsumer)
    updateConsumer()
  }
)
onMounted(() => {
  mounted = true
  ;(props.hostDocument ?? document).addEventListener('visibilitychange', updateConsumer)
  updateConsumer()
})
onBeforeUnmount(() => {
  mounted = false
  release?.()
  ;(props.hostDocument ?? document).removeEventListener('visibilitychange', updateConsumer)
})
function metric(value: unknown, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}
function dbReadout(value: number | null | undefined, digits = 1): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  if (value === -Infinity) return '−∞'
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}
const meter = computed(() => (audioEngineReady.value ? effectiveStatus.value?.meter : undefined))
const processMs = computed(() =>
  audioEngineReady.value && effectiveStatus.value?.nodes.some(node => typeof node.lastProcessMs === 'number')
    ? effectiveStatus.value.nodes.reduce((sum, node) => sum + (node.lastProcessMs || 0), 0)
    : null
)
const dspLatencyMs = computed(() =>
  audioEngineReady.value && effectiveStatus.value && actualRate.value > 0
    ? (effectiveStatus.value.totalLatencyFrames / actualRate.value) * 1000
    : null
)
const processingBypassed = computed(
  () =>
    audioProcessing.value.directMode ||
    !audioProcessing.value.dspEnabled ||
    effectiveStatus.value?.compileState === 'bypassed'
)
const sceneNodes = computed(
  () => props.scene?.graph.nodes.filter((node) => node.enabled && node.type !== 'meter') ?? []
)
const hero = computed(() => {
  const applyLabel = dspApplyLabel(effectiveStatus.value)
  if (!audioEngineReady.value)
    return {
      state: 'offline',
      title: '音频引擎未连接',
      detail: '开始播放或检查输出设备后，这里会显示实时链路状态与硬件缓冲遥测。'
    }
  if (audioProcessing.value.directMode)
    return {
      state: 'direct',
      title: 'Direct 直通中',
      detail: '音频绕过全部 DSP 处理，原样送往输出设备。退出 Direct 后效果链才会生效。'
    }
  if (!audioProcessing.value.dspEnabled)
    return {
      state: 'bypassed',
      title: 'DSP 已旁路',
      detail: '信号直达输出：均衡器与效果链暂不处理音频，但仍可编辑，开启后立即生效。'
    }
  if (props.sceneState?.effectiveBypassReason)
    return {
      state: 'warning',
      title: '当前场景已旁路',
      detail: props.sceneState.effectiveBypassReason
    }
  if (
    effectiveStatus.value?.applyState === 'failed' ||
    effectiveStatus.value?.compileState === 'failed'
  )
    return {
      state: 'error',
      title: '处理链应用失败',
      detail:
        effectiveStatus.value.applyError ||
        effectiveStatus.value.compileError ||
        '引擎未能应用最新配置。'
    }
  if (applyLabel === '已生效')
    return {
      state: 'live',
      title: isPlaying.value ? 'DSP 正在处理' : 'DSP 已就绪',
      detail: sceneNodes.value.length
        ? `${sceneNodes.value.map((node) => nodeLabel(node.type)).join(' → ')} → 输出级`
        : '当前场景没有启用的串行处理器，信号经过实时调音与输出级后送往设备。'
    }
  return {
    state: 'pending',
    title: '等待引擎确认',
    detail: '配置已提交，正在等待音频引擎确认最新版本。'
  }
})
function formatCleanDeviceName(raw: string | undefined | null, backend?: string | null): string {
  const trimmed = raw?.trim()
  if (!trimmed) return '系统默认输出'
  const guidMatch = trimmed.match(/^(?:([a-z0-9_-]+):)?\{[0-9a-f-]{8,}\}$/i)
  if (guidMatch) {
    const prefix = (guidMatch[1] || backend || '').toUpperCase()
    return prefix ? `${prefix} 硬件输出` : '音频输出设备'
  }
  return trimmed
}

const checks = computed(() => [
  {
    label: '音频引擎',
    detail: audioEngineReady.value ? '已连接，等待或处理音频' : '尚未连接音频引擎',
    tone: audioEngineReady.value ? 'success' : 'muted',
    icon: 'pi pi-microchip'
  },
  {
    label: '输出设备',
    detail:
      actualRate.value > 0
        ? `${dspSampleRate(actualRate.value)} · ${formatCleanDeviceName(outputInfo.value?.actualDeviceName || outputInfo.value?.actualBackend, outputInfo.value?.actualBackend)}`
        : '设备尚未报告实际输出格式',
    tone: audioEngineReady.value && actualRate.value > 0 ? 'success' : 'muted',
    icon: 'pi pi-headphones'
  },
  {
    label: 'DSP 处理',
    detail: !audioEngineReady.value ? '等待音频引擎连接' : processingBypassed.value
      ? audioProcessing.value.directMode
        ? 'Direct 直通，处理已旁路'
        : 'DSP 已旁路，音频不经过处理'
      : dspApplyLabel(effectiveStatus.value),
    tone: !audioEngineReady.value || processingBypassed.value
      ? 'muted'
      : effectiveStatus.value?.applyState === 'failed'
        ? 'warning'
        : effectiveStatus.value?.applyState === 'applied' &&
            dspApplyLabel(effectiveStatus.value) === '已生效'
          ? 'success'
          : 'muted',
    icon: 'pi pi-sliders-h'
  },
  {
    label: '播放稳定性',
    detail: outputInfo.value?.diagnostics
      ? `本次会话 ${outputInfo.value.diagnostics.sessionUnderrunCount} 次欠载 · ${outputInfo.value.diagnostics.sessionBufferDropCount} 次丢缓冲`
      : '尚无播放稳定性报告',
    tone: !audioEngineReady.value || !outputInfo.value?.diagnostics
      ? 'muted'
      : outputInfo.value.diagnostics.sessionUnderrunCount ||
          outputInfo.value.diagnostics.sessionBufferDropCount
        ? 'warning'
        : 'success',
    icon: 'pi pi-shield'
  }
])
const passed = computed(() => checks.value.filter((check) => check.tone === 'success').length)
/** Fills a bar between −60 and 0 on the R128 / dBTP scale. */
function meterFill(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, ((value + 60) / 60) * 100))
    : 0
}
const livePeakDb = computed(() =>
  audioEngineReady.value && isPlaying.value && visualizationData.value.active ? visualizationData.value.peakDb : null
)
const liveRmsDb = computed(() =>
  audioEngineReady.value && isPlaying.value && visualizationData.value.active ? visualizationData.value.rmsDb : null
)
const momentaryVal = computed(() => meter.value?.momentaryLufs ?? null)
const shortTermVal = computed(() => meter.value?.shortTermLufs ?? null)
const integratedVal = computed(() => meter.value?.integratedLufs ?? null)
const truePeakVal = computed(() => meter.value?.truePeakDb ?? null)
const loudnessRangeVal = computed(() => meter.value?.loudnessRangeLu ?? null)
const totalClipCount = computed(
  () =>
    meter.value?.clipCount ??
    (audioEngineReady.value && effectiveStatus.value?.nodes.some(node => typeof node.clipCount === 'number')
      ? effectiveStatus.value.nodes.reduce((sum, node) => sum + (node.clipCount ?? 0), 0)
      : null)
)
const clipping = computed(() => (totalClipCount.value ?? 0) > 0)
const meters = computed(() => [
  { key: 'M', label: '瞬时', unit: 'LUFS', value: momentaryVal.value },
  { key: 'S', label: '短时', unit: 'LUFS', value: shortTermVal.value },
  {
    key: 'TP',
    label: '真峰值',
    unit: 'dBTP',
    value: truePeakVal.value,
    warn: (truePeakVal.value ?? -100) >= -1
  }
])
const meterTicks = [-60, -48, -36, -24, -12, 0].map((value) => ({
  value,
  label: value === 0 ? '0' : `−${-value}`,
  position: ((value + 60) / 60) * 100
}))
const correlation = computed(() =>
  typeof meter.value?.correlation === 'number' && Number.isFinite(meter.value.correlation)
    ? meter.value.correlation
    : null
)
const frequencyLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((value) => ({
  value,
  label: formatFrequency(value),
  position: frequencyToPercent(value)
}))
const frequencyGuides = frequencyLabels.slice(1, -1)
</script>

<template>
  <section class="monitor-page">
    <header class="monitor-heading" :data-state="hero.state">
      <div class="monitor-heading-copy">
        <p class="monitor-state"><i class="hero-led" aria-hidden="true"></i>{{ hero.title }}</p>
      </div>
      <dl class="monitor-readouts">
        <div>
          <dt>处理耗时</dt>
          <dd>{{ metric(processMs, 2) }}<small>ms</small></dd>
        </div>
        <div>
          <dt>输出延迟</dt>
          <dd>{{ metric(effectiveLatencyMs) }}<small>ms</small></dd>
        </div>
      </dl>
      <button
        class="icon-button monitor-refresh"
        aria-label="重新检测"
        title="重新检测"
        @click="emit('refresh')"
      >
        <i class="pi pi-refresh" aria-hidden="true"></i>
      </button>
    </header>
    <p v-if="hero.state === 'warning'" class="notice" role="status">
      <i class="pi pi-info-circle" aria-hidden="true"></i>{{ hero.detail }}
    </p>

    <div class="monitor-metering-zone">
      <div class="monitor-console">
        <section class="signal-scope instrument" aria-label="实时音频频谱">
          <header class="instrument-header">
            <div class="instrument-title">
              <span class="scope-light" :class="{ active: !!levels && !frozen }"></span>
              <h3>频谱</h3>
              <span class="scope-subtitle">20 Hz – 20 kHz · {{ dspSampleRate(actualRate) }}</span>
            </div>
            <div class="instrument-tools">
              <slot name="capture" />
              <button
                class="scope-tool"
                :aria-pressed="peakHold"
                title="保留每个频点的最大值"
                @click="peakHold = !peakHold"
              >
                峰值保持
              </button>
              <button
                class="scope-tool icon"
                :aria-pressed="frozen"
                :disabled="!levels && !frozen"
                :aria-label="frozen ? '继续频谱' : '冻结频谱'"
                :title="frozen ? '继续频谱' : '冻结频谱'"
                @click="frozen = !frozen"
              >
                <i :class="frozen ? 'pi pi-play' : 'pi pi-pause'"></i>
              </button>
            </div>
          </header>
          <div class="scope-plot">
            <div class="scope-db-axis" aria-hidden="true">
              <span>0</span><span>−30</span><span>−60</span><span>−90</span>
            </div>
            <div class="scope-grid">
              <span class="scope-hline" style="top: 0%" aria-hidden="true"></span>
              <span class="scope-hline" style="top: 33.333%" aria-hidden="true"></span>
              <span class="scope-hline" style="top: 66.667%" aria-hidden="true"></span>
              <span
                v-for="guide in frequencyGuides"
                :key="guide.value"
                class="scope-vline"
                :class="{
                  major: guide.value === 100 || guide.value === 1000 || guide.value === 10000
                }"
                :style="{ left: `${guide.position}%` }"
                aria-hidden="true"
              ></span>
              <svg viewBox="0 20.6 100 77.4" preserveAspectRatio="none" aria-hidden="true">
                <path
                  :ref="spectrum.fillRef"
                  class="scope-fill"
                  fill="currentColor"
                  fill-opacity="0.06"
                />
                <path
                  :ref="spectrum.lineRef"
                  class="scope-line"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  vector-effect="non-scaling-stroke"
                />
                <path
                  :ref="spectrum.peakRef"
                  class="scope-peak"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1"
                  stroke-dasharray="2 3"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
              <div v-if="!levels && !frozen" class="scope-empty">
                <span>{{
                  !audioEngineReady
                    ? '音频引擎未连接'
                    : !audioProcessing.fftEnabled
                    ? 'FFT 采集未开启'
                    : isPlaying
                      ? '等待频谱数据'
                      : '播放音乐，查看声音的实时轮廓'
                }}</span
                ><small>{{
                  !audioProcessing.fftEnabled ? '使用上方开关开启采集' : '对数频率 · 0 至 −90 dBFS'
                }}</small>
              </div>
            </div>
          </div>
          <div class="scope-frequency-axis" aria-hidden="true">
            <span
              v-for="item in frequencyLabels"
              :key="item.value"
              :style="{ left: `${item.position}%` }"
              >{{ item.label }}</span
            >
          </div>
          <footer class="instrument-footer">
            <span class="scope-state">{{
              frozen ? '已冻结当前频谱' : levels ? '实时音频采集' : '等待音频信号'
            }}</span
            ><span class="scope-levels"
              >峰值
              <b>{{ dbReadout(livePeakDb) }}</b>
              <span class="scope-separator">·</span> RMS
              <b>{{ dbReadout(liveRmsDb) }}</b>
              dBFS</span
            >
          </footer>
        </section>

        <section class="loudness-panel instrument" aria-label="响度与声道">
          <header class="instrument-header">
            <div class="instrument-title">
              <span class="scope-light" :class="{ active: !!meter }"></span>
              <h3>响度</h3>
              <span class="scope-subtitle">EBU R128</span>
            </div>
          </header>
          <div class="loudness-hero" :class="{ warn: clipping }">
            <strong>{{ dbReadout(integratedVal) }}</strong
            ><span><b>LUFS</b>综合响度</span>
          </div>
          <div class="meter-rows">
            <div
              v-for="item in meters"
              :key="item.key"
              class="meter-row"
              :class="{ warn: item.warn }"
              :title="`${item.label} ${dbReadout(item.value)} ${item.unit}`"
            >
              <span class="meter-key"
                >{{ item.key }}<small>{{ item.label }}</small></span
              >
              <span class="meter-bar"><i :style="{ width: `${meterFill(item.value)}%` }"></i></span>
              <strong>{{ dbReadout(item.value) }}</strong>
            </div>
            <div class="meter-scale" aria-hidden="true">
              <span
                v-for="tick in meterTicks"
                :key="tick.value"
                :style="{ left: `${tick.position}%` }"
                >{{ tick.label }}</span
              >
            </div>
          </div>
          <dl class="stereo-readings">
            <div>
              <dt>响度范围</dt>
              <dd>{{ metric(loudnessRangeVal) }}<small>LU</small></dd>
            </div>
            <div>
              <dt>削波</dt>
              <dd :class="{ warn: clipping }">{{ totalClipCount ?? '—' }}</dd>
            </div>
            <div class="correlation">
              <dt>声道相关性</dt>
              <dd>{{ metric(correlation, 2) }}</dd>
              <span class="correlation-track" aria-hidden="true"
                ><i
                  v-if="correlation !== null"
                  :class="{ negative: correlation < 0 }"
                  :style="{ left: `${((correlation + 1) / 2) * 100}%` }"
                ></i
              ></span>
            </div>
          </dl>
        </section>
      </div>
    </div>

    <details class="monitor-tuning-zone disclosure">
      <summary>
        <span class="summary-copy"
          ><strong>常用调音</strong><small>声场、音量与播放衔接 · 实时调节</small></span
        ><span class="section-tag" :data-mode="processingBypassed ? 'draft' : 'live'">{{
          processingBypassed ? 'DSP 已旁路' : '实时生效'
        }}</span
        ><i class="pi pi-chevron-down summary-chevron" aria-hidden="true"></i>
      </summary>
      <div class="quick-dsp-grid">
        <!-- Bay A: 空间声场与耳机交叉馈送 -->
        <article class="dsp-tuning-card surface-panel" aria-label="耳机交叉馈送与立体声场">
          <header class="tuning-card-head">
            <div>
              <h4>空间与声场</h4>
            </div>
            <label class="switch-field compact-switch">
              <input
                type="checkbox"
                :checked="audioProcessing.crossfeedEnabled"
                @change="
                  updateProcessing({
                    crossfeedEnabled: ($event.target as HTMLInputElement).checked
                  })
                "
              />
              <span>交叉馈送</span>
            </label>
          </header>

          <div class="tuning-sliders">
            <label class="tuning-slider-row">
              <span class="slider-meta">
                <span>交叉馈送强度 · {{ audioProcessing.crossfeedCutoffHz ?? 700 }} Hz</span>
                <output>{{ crossfeedStrengthPct }}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                :value="crossfeedStrengthPct"
                @change="
                  updateProcessing({
                    crossfeedStrength: Number(($event.target as HTMLInputElement).value) / 100,
                    crossfeedEnabled: true
                  })
                "
              />
            </label>

            <label class="tuning-slider-row">
              <span class="slider-meta">
                <span>立体声宽度</span>
                <output>{{ stereoWidthPct }}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="200"
                step="5"
                :value="stereoWidthPct"
                @change="
                  updateStereo({
                    width: Number(($event.target as HTMLInputElement).value) / 100
                  })
                "
              />
            </label>

            <label class="tuning-slider-row">
              <span class="slider-meta">
                <span>左右声道平衡</span>
                <output>{{
                  stereoBalancePct === 0
                    ? '居中 0%'
                    : stereoBalancePct > 0
                      ? `R +${stereoBalancePct}%`
                      : `L ${stereoBalancePct}%`
                }}</output>
              </span>
              <input
                type="range"
                min="-100"
                max="100"
                step="1"
                :value="stereoBalancePct"
                @change="
                  updateStereo({
                    balance: Number(($event.target as HTMLInputElement).value) / 100
                  })
                "
              />
            </label>
          </div>

          <footer class="tuning-card-foot stereo-pills">
            <button
              type="button"
              class="chip"
              :aria-pressed="stereoImage.mono"
              @click="updateStereo({ mono: !stereoImage.mono })"
            >
              单声道 Mono
            </button>
            <button
              type="button"
              class="chip"
              :aria-pressed="stereoImage.swap"
              @click="updateStereo({ swap: !stereoImage.swap })"
            >
              左右互换 L↔R
            </button>
            <button
              type="button"
              class="chip"
              :aria-pressed="stereoImage.invertLeft"
              @click="updateStereo({ invertLeft: !stereoImage.invertLeft })"
            >
              左反相 ØL
            </button>
            <button
              type="button"
              class="chip"
              :aria-pressed="stereoImage.invertRight"
              @click="updateStereo({ invertRight: !stereoImage.invertRight })"
            >
              右反相 ØR
            </button>
            <button
              v-if="stereoModified"
              type="button"
              class="ghost-button reset-mini"
              @click="resetStereoField"
            >
              重置
            </button>
          </footer>
        </article>

        <!-- Bay B: 响度归一与前级增益 -->
        <article class="dsp-tuning-card surface-panel" aria-label="响度归一与增益保护">
          <header class="tuning-card-head">
            <div>
              <h4>响度归一与前级增益</h4>
            </div>
            <span
              class="tuning-badge"
              :class="{ active: (audioProcessing.volumeNormalization ?? 'off') !== 'off' }"
            >
              {{
                (audioProcessing.volumeNormalization ?? 'off') === 'off'
                  ? '直通 0.0 dB'
                  : (audioProcessing.volumeNormalization ?? 'off') === 'track'
                    ? '单曲归一'
                    : (audioProcessing.volumeNormalization ?? 'off') === 'album'
                      ? '专辑归一'
                      : 'R128 响度'
              }}
            </span>
          </header>

          <div class="segmented tuning-segmented" role="group" aria-label="音量归一化模式">
            <button
              v-for="mode in normalizationModes"
              :key="mode.id"
              type="button"
              :aria-pressed="(audioProcessing.volumeNormalization ?? 'off') === mode.id"
              @click="updateProcessing({ volumeNormalization: mode.id })"
            >
              {{ mode.label }}
            </button>
          </div>

          <div class="tuning-sliders">
            <label class="tuning-slider-row">
              <span class="slider-meta">
                <span>ReplayGain 预放增益</span>
                <output>{{ signedDb(audioProcessing.replayGainPreamp) }}</output>
              </span>
              <input
                type="range"
                min="-12"
                max="12"
                step="0.5"
                :value="audioProcessing.replayGainPreamp ?? 0"
                @change="
                  updateProcessing({
                    replayGainPreamp: Number(($event.target as HTMLInputElement).value)
                  })
                "
              />
            </label>
            <label class="tuning-slider-row">
              <span class="slider-meta">
                <span>无标签曲目回退增益</span>
                <output>{{ signedDb(audioProcessing.replayGainFallback) }}</output>
              </span>
              <input
                type="range"
                min="-12"
                max="12"
                step="0.5"
                :value="audioProcessing.replayGainFallback ?? 0"
                @change="
                  updateProcessing({
                    replayGainFallback: Number(($event.target as HTMLInputElement).value)
                  })
                "
              />
            </label>
            <label class="tuning-slider-row">
              <span class="slider-meta">
                <span>均衡器前级预放 (EQ Preamp)</span>
                <output>{{ signedDb(audioProcessing.eqPreamp) }}</output>
              </span>
              <input
                type="range"
                min="-12"
                max="12"
                step="0.5"
                :value="audioProcessing.eqPreamp ?? 0"
                @change="
                  updateProcessing({
                    eqPreamp: Number(($event.target as HTMLInputElement).value)
                  })
                "
              />
            </label>
          </div>

          <footer class="tuning-card-foot">
            <label class="switch-field">
              <input
                type="checkbox"
                :checked="audioProcessing.clipGuard !== false"
                @change="
                  updateProcessing({
                    clipGuard: ($event.target as HTMLInputElement).checked,
                    replayGainClip: ($event.target as HTMLInputElement).checked
                  })
                "
              />
              <span>开启峰值防削波保护 (Clip Guard)</span>
            </label>
          </footer>
        </article>

        <!-- Bay C: 全宽三栏核心模块与 DSD 策略横条 -->
        <article
          class="dsp-tuning-card dsp-master-strip surface-panel"
          aria-label="核心模块与输出策略"
        >
          <div class="strip-bay">
            <div class="strip-bay-head">
              <label class="switch-field compact-switch">
                <input
                  type="checkbox"
                  :checked="audioProcessing.eqEnabled"
                  @change="
                    updateProcessing({ eqEnabled: ($event.target as HTMLInputElement).checked })
                  "
                />
                <span>{{ audioProcessing.eqEnabled ? '已启用' : '已旁路' }}</span>
              </label>
            </div>
            <div class="strip-bay-body">
              <div>
                <strong>实时均衡器</strong>
                <p>
                  {{ audioProcessing.eqBands?.length ?? 10 }} 段频响 · 预放
                  {{ signedDb(audioProcessing.eqPreamp) }}
                </p>
              </div>
              <button
                type="button"
                class="ghost-button reset-mini"
                @click="emit('navigate', 'equalizer')"
              >
                调节曲线 <i class="pi pi-arrow-right"></i>
              </button>
            </div>
          </div>

          <div class="strip-bay">
            <div class="strip-bay-head">
              <label class="switch-field compact-switch">
                <input
                  type="checkbox"
                  :checked="audioProcessing.convolverEnabled"
                  @change="
                    updateProcessing({
                      convolverEnabled: ($event.target as HTMLInputElement).checked
                    })
                  "
                />
                <span>{{ audioProcessing.convolverEnabled ? '已启用' : '已旁路' }}</span>
              </label>
            </div>
            <div class="strip-bay-body">
              <div>
                <strong>脉冲响应卷积</strong>
                <p>{{ convolverFileName || '可在资料库导入或绑定房间 / 箱体 IR' }}</p>
              </div>
              <button
                type="button"
                class="ghost-button reset-mini"
                @click="emit('navigate', 'library')"
              >
                脉冲库 <i class="pi pi-arrow-right"></i>
              </button>
            </div>
          </div>

          <div class="strip-bay strip-bay-wide">
            <div class="strip-bay-head">
              <span class="strip-meta-tag">{{
                audioProcessing.gapless ? 'Gapless 无缝已开启' : 'Gapless 无缝已关闭'
              }}</span>
            </div>
            <div class="strip-controls-row">
              <label class="tuning-slider-row compact-slider">
                <span class="slider-meta">
                  <span>交叉淡出 (Crossfade)</span>
                  <output>{{
                    (audioProcessing.crossfadeSeconds ?? 0) > 0
                      ? `${Number(audioProcessing.crossfadeSeconds ?? 0).toFixed(1)} s`
                      : '0.0 s'
                  }}</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="12"
                  step="0.5"
                  :value="audioProcessing.crossfadeSeconds ?? 0"
                  @change="
                    updateProcessing({
                      crossfadeSeconds: Number(($event.target as HTMLInputElement).value)
                    })
                  "
                />
              </label>
              <div class="dsd-inline-group">
                <span class="dsd-label">DSD 策略</span>
                <div class="segmented" role="group" aria-label="DSD 策略">
                  <button
                    v-for="mode in dsdModes"
                    :key="mode.id"
                    type="button"
                    :aria-pressed="(audioProcessing.dsdOutputMode ?? 'auto') === mode.id"
                    @click="updateProcessing({ dsdOutputMode: mode.id })"
                  >
                    {{ mode.label }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
    </details>

    <details
      class="diagnostic-details"
      @toggle="expanded = ($event.target as HTMLDetailsElement).open"
    >
      <summary>
        <span class="summary-copy"
          ><strong>详细诊断</strong><small>链路检查、节点耗时与引擎数据</small></span
        ><i class="pi pi-chevron-down summary-chevron" aria-hidden="true"></i>
      </summary>
      <div v-if="expanded" class="diagnostic-body">
        <ul class="health-list" aria-label="链路检查">
          <li v-for="check in checks" :key="check.label" class="health-row" :data-tone="check.tone">
            <span class="health-copy">
              <strong>
                <i class="health-dot" aria-hidden="true"></i>
                {{ check.label }}
              </strong>
              <span>{{ check.detail }}</span>
            </span>
            <span class="health-result">
              {{ check.tone === 'success' ? '正常' : check.tone === 'warning' ? '注意' : '待命' }}
            </span>
          </li>
        </ul>
        <dl class="diagnostic-timing">
          <div>
            <dt>算法延迟</dt>
            <dd>{{ metric(dspLatencyMs, 2) }} ms</dd>
          </div>
          <div>
            <dt>设备缓冲</dt>
            <dd>{{ effectiveBuffer > 0 ? effectiveBuffer + ' frames' : '未报告' }}</dd>
          </div>
          <div>
            <dt>链路检查</dt>
            <dd>{{ passed }} / {{ checks.length }} 项正常</dd>
          </div>
        </dl>
        <dl class="engine-facts">
          <div>
            <dt>编译状态</dt>
            <dd>
              {{ effectiveStatus?.compileState ?? '未报告' }}
            </dd>
          </div>
          <div>
            <dt>总延迟 / 尾音</dt>
            <dd>
              {{ effectiveStatus?.totalLatencyFrames ?? '—' }} /
              {{ effectiveStatus?.totalTailFrames ?? '—' }} frames
            </dd>
          </div>
          <div>
            <dt>请求 / 确认 / 原生版本</dt>
            <dd>
              {{ effectiveStatus?.requestedRevision ?? '—' }} /
              {{ effectiveStatus?.appliedRevision ?? '—' }} /
              {{ effectiveStatus?.revision ?? '—' }}
            </dd>
          </div>
          <div>
            <dt>输出级</dt>
            <dd>
              {{
                effectiveStatus?.outputStage ? describeResampler(
                  effectiveStatus?.outputStage?.resamplerQuality ?? 'native',
                  effectiveStatus?.outputStage
                ) : '等待引擎报告'
              }}
              /
              {{ effectiveStatus?.outputStage?.dither ?? '未报告' }}
            </dd>
          </div>
        </dl>
        <div class="table-scroll">
          <table class="diagnostics-table">
            <caption>
              引擎节点 · 单次处理耗时（ms）
            </caption>
            <thead>
              <tr>
                <th>节点</th>
                <th>状态</th>
                <th>最近</th>
                <th>平均</th>
                <th>最高</th>
                <th>超时</th>
                <th>削波</th>
                <th>延迟 / 尾音</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="node in effectiveStatus?.nodes ?? []" :key="node.id">
                <th :title="node.id">{{ nodeLabel(node.type) }}</th>
                <td>
                  {{
                    node.bypassed ? node.bypassReason || '旁路' : node.active ? '运行中' : '待命'
                  }}
                </td>
                <td>{{ metric(node.lastProcessMs, 3) }}</td>
                <td>{{ metric(node.averageProcessMs, 3) }}</td>
                <td>{{ metric(node.maxProcessMs, 3) }}</td>
                <td>{{ node.overrunCount ?? 0 }}</td>
                <td>{{ node.clipCount ?? 0 }}</td>
                <td>{{ node.latencyFrames }} / {{ node.tailFrames }} frames</td>
              </tr>
              <tr v-if="!effectiveStatus?.nodes.length">
                <td colspan="8" class="muted">引擎尚未报告处理节点。</td>
              </tr>
            </tbody>
          </table>
        </div>
        <details class="raw-config">
          <summary>完整引擎数据 · JSON</summary>
          <pre>{{ JSON.stringify(effectiveStatus, null, 2) }}</pre>
        </details>
      </div>
    </details>
  </section>
</template>
