<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { DspGraphStatus, DspScene, DspSceneState } from '../../../../shared/dspGraph.ts'
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
const { outputInfo, audioProcessing, audioEngineReady, audioOutputConfig } =
  storeToRefs(useAudioOutputDspStore())
const { visualizationData, isPlaying, acquireVisualizationConsumer } = usePlayerStore()
const expanded = ref(false)
const frozen = ref(false)
const levels = computed(() =>
  isPlaying.value && visualizationData.value.active && visualizationData.value.spectrum.length > 1
    ? projectSpectrumLevels(
        visualizationData.value.spectrum,
        visualizationData.value.sampleRate || outputInfo.value?.actualSampleRate || 48000,
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
    isPlaying.value &&
    !frozen.value &&
    !(props.hostDocument ?? document).hidden
  if (needed && !release) release = acquireVisualizationConsumer({ spectrumPoints: 2048 })
  if (!needed && release) {
    release()
    release = null
  }
}
watch(() => [props.visible, isPlaying.value, frozen.value], updateConsumer)
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
const meter = computed(() => props.status?.meter)
const processMs = computed(() =>
  props.status ? props.status.nodes.reduce((sum, node) => sum + node.lastProcessMs, 0) : null
)
const runningNodes = computed(
  () => props.status?.nodes.filter((node) => node.active && !node.bypassed).length ?? 0
)
const actualRate = computed(() => outputInfo.value?.actualSampleRate || 0)
const dspLatencyMs = computed(() =>
  props.status && actualRate.value > 0
    ? (props.status.totalLatencyFrames / actualRate.value) * 1000
    : null
)
const processingBypassed = computed(
  () =>
    audioProcessing.value.directMode ||
    !audioProcessing.value.dspEnabled ||
    props.status?.compileState === 'bypassed'
)
const sceneNodes = computed(
  () => props.scene?.graph.nodes.filter((node) => node.enabled && node.type !== 'meter') ?? []
)
const hero = computed(() => {
  const applyLabel = dspApplyLabel(props.status)
  if (!audioEngineReady.value)
    return {
      state: 'offline',
      title: '音频引擎未连接',
      detail: '开始播放或检查输出设备后，这里会显示实时链路状态。'
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
  if (props.status?.applyState === 'failed' || props.status?.compileState === 'failed')
    return {
      state: 'error',
      title: '处理链应用失败',
      detail: props.status.applyError || props.status.compileError || '引擎未能应用最新配置。'
    }
  if (applyLabel === '已生效')
    return {
      state: 'live',
      title: 'DSP 正在处理',
      detail: sceneNodes.value.length
        ? `${sceneNodes.value.map((node) => nodeLabel(node.type)).join(' → ')} → 输出级`
        : '当前场景没有启用的处理器，信号经过输出级后送往设备。'
    }
  return {
    state: 'pending',
    title: '等待引擎确认',
    detail: '配置已提交，正在等待音频引擎确认最新版本。'
  }
})
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
      outputInfo.value && outputInfo.value.actualSampleRate > 0
        ? `${dspSampleRate(outputInfo.value.actualSampleRate)} · ${outputInfo.value.actualDeviceName || outputInfo.value.actualBackend || '设备已就绪'}`
        : '播放后读取实际输出格式',
    tone: outputInfo.value && outputInfo.value.actualSampleRate > 0 ? 'success' : 'muted',
    icon: 'pi pi-headphones'
  },
  {
    label: 'DSP 处理',
    detail: processingBypassed.value
      ? audioProcessing.value.directMode
        ? 'Direct 直通，处理已旁路'
        : 'DSP 已旁路，音频不经过处理'
      : dspApplyLabel(props.status),
    tone: processingBypassed.value
      ? 'muted'
      : props.status?.applyState === 'failed'
        ? 'warning'
        : props.status?.applyState === 'applied' && dspApplyLabel(props.status) === '已生效'
          ? 'success'
          : 'muted',
    icon: 'pi pi-sliders-h'
  },
  {
    label: '播放稳定性',
    detail: outputInfo.value?.diagnostics
      ? `本次会话 ${outputInfo.value.diagnostics.sessionUnderrunCount} 次欠载 · ${outputInfo.value.diagnostics.sessionBufferDropCount} 次丢缓冲`
      : '等待设备运行数据',
    tone: !outputInfo.value?.diagnostics
      ? 'muted'
      : outputInfo.value.diagnostics.sessionUnderrunCount ||
          outputInfo.value.diagnostics.sessionBufferDropCount
        ? 'warning'
        : 'success',
    icon: 'pi pi-shield'
  }
])
const passed = computed(() => checks.value.filter((check) => check.tone === 'success').length)
const heroStateLabel = computed(
  () =>
    ({
      offline: '离线',
      direct: '直通',
      bypassed: '已旁路',
      warning: '场景旁路',
      error: '异常',
      live: '处理中',
      pending: '等待确认'
    })[hero.value.state] ?? hero.value.state
)
const rateValue = computed(() =>
  actualRate.value > 0 ? String(Number((actualRate.value / 1000).toFixed(1))) : '—'
)
/** Fills a bar between −60 and 0 on the R128 / dBTP scale. */
function meterFill(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, ((value + 60) / 60) * 100))
    : 0
}
const meters = computed(() => [
  { key: 'M', label: '瞬时', unit: 'LUFS', value: meter.value?.momentaryLufs },
  { key: 'S', label: '短时', unit: 'LUFS', value: meter.value?.shortTermLufs },
  {
    key: 'TP',
    label: '真峰值',
    unit: 'dBTP',
    value: meter.value?.truePeakDb,
    warn: (meter.value?.truePeakDb ?? -100) >= -1
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
const nextSteps = computed(() => [
  {
    tab: 'equalizer' as const,
    title: '均衡与耳机校正',
    detail: '用 OPRA 校正耳机频响，再按喜好微调音色。',
    meta: `${audioProcessing.value.eqEnabled ? '已启用' : '已旁路'} · ${audioProcessing.value.eqBands?.length ?? 0} 段`,
    mode: '实时'
  },
  {
    tab: 'chain' as const,
    title: '编排效果链',
    detail: '组合压缩、卷积、声场与插件，按场景自动切换。',
    meta: `${props.scene?.name ?? '自动匹配'} · ${sceneNodes.value.length} 个处理器`,
    mode: '草稿'
  },
  {
    tab: 'output' as const,
    title: '输出与性能',
    detail: '设定目标采样率、重采样与缓冲，兼顾音质与稳定。',
    meta: `${dspSampleRate(actualRate.value)} · ${outputInfo.value && outputInfo.value.bufferSizeFrames > 0 ? `${outputInfo.value.bufferSizeFrames} frames` : `请求 ${audioOutputConfig.value?.preferredBufferSize || '自动'}`}`,
    mode: '草稿 + 设备'
  },
  {
    tab: 'library' as const,
    title: '资料库',
    detail: '管理脉冲响应、校正文件与 VST3 插件。',
    meta: `${props.assetCount ?? 0} 份资料`,
    mode: '资源'
  }
])
</script>

<template>
  <section class="monitor-page">
    <p
      v-if="error || status?.applyError || status?.compileError"
      class="rack-message error"
      role="alert"
    >
      <i class="pi pi-exclamation-triangle"></i
      ><span>{{ error || status?.applyError || status?.compileError }}</span>
    </p>

    <header class="monitor-hero" :data-state="hero.state" aria-live="polite">
      <div class="hero-copy">
        <p class="hero-kicker">
          <i class="hero-led" aria-hidden="true"></i>系统状态<span>{{ heroStateLabel }}</span>
        </p>
        <h2>{{ hero.title }}</h2>
        <p class="hero-detail">{{ hero.detail }}</p>
        <div class="hero-actions">
          <button
            v-if="!audioProcessing.dspEnabled && !audioProcessing.directMode"
            class="primary-button"
            :disabled="masterBusy"
            @click="emit('master')"
          >
            <i class="pi pi-power-off"></i>开启 DSP
          </button>
          <button class="ghost-button" @click="emit('refresh')">
            <i class="pi pi-refresh"></i>重新检测
          </button>
        </div>
      </div>
      <dl class="hero-readouts">
        <div>
          <dt>处理耗时</dt>
          <dd class="readout-value">{{ metric(processMs, 2) }}<small>ms</small></dd>
          <dd class="readout-caption">
            {{ status ? `${runningNodes} 个节点运行中` : '等待引擎报告' }}
          </dd>
        </div>
        <div>
          <dt>输出延迟</dt>
          <dd class="readout-value">
            {{ metric(outputInfo && outputInfo.latencyMs > 0 ? outputInfo.latencyMs : null)
            }}<small>ms</small>
          </dd>
          <dd class="readout-caption">
            {{
              outputInfo && outputInfo.bufferSizeFrames > 0
                ? `${outputInfo.bufferSizeFrames} frames 设备缓冲`
                : '等待设备报告缓冲'
            }}
          </dd>
        </div>
        <div>
          <dt>算法延迟</dt>
          <dd class="readout-value">{{ metric(dspLatencyMs, 2) }}<small>ms</small></dd>
          <dd class="readout-caption">
            {{
              status
                ? `${status.totalLatencyFrames} frames · 尾音 ${status.totalTailFrames}`
                : '等待引擎报告'
            }}
          </dd>
        </div>
        <div>
          <dt>输出采样率</dt>
          <dd class="readout-value">{{ rateValue }}<small>kHz</small></dd>
          <dd class="readout-caption">
            {{ scene?.name ?? '自动匹配' }} · {{ sceneNodes.length }} 个处理器
          </dd>
        </div>
      </dl>
    </header>

    <div class="monitor-console">
      <section class="signal-scope instrument" aria-label="实时音频频谱">
        <header class="instrument-header">
          <div class="instrument-title">
            <span class="scope-light" :class="{ active: !!levels && !frozen }"></span>
            <h3>频谱</h3>
            <span class="scope-subtitle"
              >20 Hz – 20 kHz · {{ dspSampleRate(outputInfo?.actualSampleRate) }}</span
            >
          </div>
          <div class="instrument-tools">
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
              <defs>
                <linearGradient id="dsp-spectrum-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="currentColor" stop-opacity=".26" />
                  <stop offset="65%" stop-color="currentColor" stop-opacity=".06" />
                  <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path :ref="spectrum.fillRef" class="scope-fill" fill="url(#dsp-spectrum-fill)" />
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
                stroke-dasharray="1 3"
                vector-effect="non-scaling-stroke"
              />
            </svg>
            <div v-if="!levels && !frozen" class="scope-empty">
              <span>{{
                !audioProcessing.fftEnabled
                  ? 'FFT 采集未开启'
                  : isPlaying
                    ? '等待频谱数据'
                    : '播放音乐，查看声音的实时轮廓'
              }}</span
              ><small>{{
                !audioProcessing.fftEnabled
                  ? '可在下方「采集与详细诊断」中开启'
                  : '对数频率 · 0 至 −90 dBFS'
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
            <b>{{ metric(visualizationData.active ? visualizationData.peakDb : null) }}</b>
            <span class="scope-separator">·</span> RMS
            <b>{{ metric(visualizationData.active ? visualizationData.rmsDb : null) }}</b>
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
        <div class="loudness-hero" :class="{ warn: (meter?.clipCount ?? 0) > 0 }">
          <strong>{{ metric(meter?.integratedLufs) }}</strong
          ><span><b>LUFS</b>综合响度</span>
        </div>
        <div class="meter-rows">
          <div
            v-for="item in meters"
            :key="item.key"
            class="meter-row"
            :class="{ warn: item.warn }"
            :title="`${item.label} ${metric(item.value)} ${item.unit}`"
          >
            <span class="meter-key"
              >{{ item.key }}<small>{{ item.label }}</small></span
            >
            <span class="meter-bar"><i :style="{ width: `${meterFill(item.value)}%` }"></i></span>
            <strong>{{ metric(item.value) }}</strong>
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
            <dd>{{ metric(meter?.loudnessRangeLu) }}<small>LU</small></dd>
          </div>
          <div>
            <dt>削波</dt>
            <dd :class="{ warn: (meter?.clipCount ?? 0) > 0 }">{{ meter?.clipCount ?? '—' }}</dd>
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

    <div class="monitor-lower">
      <section class="health-panel">
        <header class="panel-heading">
          <h3>链路检查</h3>
          <span class="health-score"
            ><b>{{ passed }}</b> / {{ checks.length }} 项正常</span
          >
        </header>
        <ul class="health-list">
          <li v-for="check in checks" :key="check.label" class="health-row" :data-tone="check.tone">
            <i class="health-dot" aria-hidden="true"></i>
            <span class="health-copy"
              ><strong>{{ check.label }}</strong
              ><span>{{ check.detail }}</span></span
            >
            <span class="health-result">{{
              check.tone === 'success' ? '正常' : check.tone === 'warning' ? '注意' : '待检测'
            }}</span>
          </li>
        </ul>
      </section>
      <section class="next-steps" aria-label="接下来">
        <header class="panel-heading">
          <h3>塑造你的声音</h3>
          <p>从校正开始，再到效果与输出；每一步都会反映在底部的信号链中。</p>
        </header>
        <ol class="step-list">
          <li v-for="(step, index) in nextSteps" :key="step.tab">
            <button class="step-card" :data-tab="step.tab" @click="emit('navigate', step.tab)">
              <span class="step-number">{{ String(index + 1).padStart(2, '0') }}</span
              ><span class="step-copy"
                ><strong>{{ step.title }}</strong
                ><small>{{ step.detail }}</small></span
              ><span class="step-meta"
                ><em>{{ step.mode }}</em
                >{{ step.meta }}</span
              ><i class="pi pi-arrow-right step-go" aria-hidden="true"></i>
            </button>
          </li>
        </ol>
      </section>
    </div>

    <details
      class="diagnostic-details"
      @toggle="expanded = ($event.target as HTMLDetailsElement).open"
    >
      <summary>
        <span class="summary-copy"
          ><strong>采集与详细诊断</strong><small>FFT 采集 · 节点耗时 · 原始引擎数据</small></span
        ><i class="pi pi-chevron-down summary-chevron" aria-hidden="true"></i>
      </summary>
      <div v-if="expanded" class="diagnostic-body">
        <slot name="capture" />
        <dl class="engine-facts">
          <div>
            <dt>编译状态</dt>
            <dd>{{ status?.compileState ?? '—' }}</dd>
          </div>
          <div>
            <dt>总延迟 / 尾音</dt>
            <dd>
              {{ status?.totalLatencyFrames ?? '—' }} / {{ status?.totalTailFrames ?? '—' }} frames
            </dd>
          </div>
          <div>
            <dt>请求 / 确认 / 原生版本</dt>
            <dd>
              {{ status?.requestedRevision ?? '—' }} / {{ status?.appliedRevision ?? '—' }} /
              {{ status?.revision ?? '—' }}
            </dd>
          </div>
          <div>
            <dt>输出级</dt>
            <dd>
              {{
                describeResampler(
                  status?.outputStage?.resamplerQuality ?? 'native',
                  status?.outputStage
                )
              }}
              /
              {{ status?.outputStage?.dither ?? '—' }}
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
              <tr v-for="node in status?.nodes ?? []" :key="node.id">
                <th :title="node.id">{{ nodeLabel(node.type) }}</th>
                <td>
                  {{
                    node.bypassed ? node.bypassReason || '旁路' : node.active ? '运行中' : '待命'
                  }}
                </td>
                <td>{{ metric(node.lastProcessMs, 3) }}</td>
                <td>{{ metric(node.averageProcessMs, 3) }}</td>
                <td>{{ metric(node.maxProcessMs, 3) }}</td>
                <td>{{ node.overrunCount ?? '—' }}</td>
                <td>{{ node.clipCount ?? '—' }}</td>
                <td>{{ node.latencyFrames }} / {{ node.tailFrames }} frames</td>
              </tr>
              <tr v-if="!status?.nodes.length">
                <td colspan="8" class="muted">引擎尚未报告处理节点。</td>
              </tr>
            </tbody>
          </table>
        </div>
        <details class="raw-config">
          <summary>完整引擎数据 · JSON</summary>
          <pre>{{ JSON.stringify(status, null, 2) }}</pre>
        </details>
      </div>
    </details>
  </section>
</template>
