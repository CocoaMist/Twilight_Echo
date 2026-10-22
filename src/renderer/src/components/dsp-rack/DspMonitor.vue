<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { DspGraphStatus } from '../../../../shared/dspGraph.ts'
import { describeResampler } from '../../../../shared/resamplerStatus.ts'
import { dspApplyLabel, type DspWorkspaceTab } from '@renderer/utils/dspWorkbench'
import { dspSampleRate } from '@renderer/utils/dspSignalOverview'
import { nodeLabel } from '@renderer/utils/dspNodeParams'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { projectSpectrumLevels } from '@renderer/utils/parametricEqInteraction'
import { useEqSpectrum } from '@renderer/composables/useEqSpectrum'

const props = defineProps<{
  status: DspGraphStatus | null
  error: string
  visible?: boolean
  hostDocument?: Document
}>()
const emit = defineEmits<{ navigate: [tab: DspWorkspaceTab]; refresh: [] }>()
const { outputInfo, audioProcessing, audioEngineReady } = storeToRefs(useAudioOutputDspStore())
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
const processMs = computed(() =>
  props.status ? props.status.nodes.reduce((sum, node) => sum + node.lastProcessMs, 0) : null
)
const processingBypassed = computed(
  () =>
    audioProcessing.value.directMode ||
    !audioProcessing.value.dspEnabled ||
    props.status?.compileState === 'bypassed'
)
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
const loudness = computed(() => [
  { label: '瞬时', value: props.status?.meter?.momentaryLufs },
  { label: '短时', value: props.status?.meter?.shortTermLufs },
  { label: '综合', value: props.status?.meter?.integratedLufs }
])
const meterWidth = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, ((value + 60) / 60) * 100))
    : 0
</script>

<template>
  <section class="monitor-page">
    <header class="workspace-page-heading">
      <div>
        <p class="eyebrow">01 / SIGNAL CHECK</p>
        <h2>先了解声音，再开始调音<span class="heading-period">.</span></h2>
        <p>检查信号、处理状态与输出，让每一步调整都有依据。</p>
      </div>
      <button @click="emit('refresh')"><i class="pi pi-refresh"></i>重新检测</button>
    </header>
    <p
      v-if="error || status?.applyError || status?.compileError"
      class="rack-message error"
      role="alert"
    >
      {{ error || status?.applyError || status?.compileError }}
    </p>
    <div class="signal-metrics">
      <div class="signal-metric">
        <span>综合响度 <small>INTEGRATED</small></span
        ><strong>{{ metric(status?.meter?.integratedLufs) }}<small>LUFS</small></strong
        ><span class="metric-caption">整首音乐的平均听感响度</span>
      </div>
      <div
        class="signal-metric"
        :class="{ 'metric-warning': (status?.meter?.truePeakDb ?? -1) >= 0 }"
      >
        <span>真峰值 <small>TRUE PEAK</small></span
        ><strong>{{ metric(status?.meter?.truePeakDb) }}<small>dBTP</small></strong
        ><span class="metric-caption">{{
          (status?.meter?.clipCount ?? 0) > 0
            ? `已记录 ${status?.meter?.clipCount} 次削波`
            : '观察数字满幅与削波风险'
        }}</span>
      </div>
      <div class="signal-metric">
        <span>DSP 处理耗时 <small>PROCESSING</small></span
        ><strong>{{ metric(processMs, 2) }}<small>ms</small></strong
        ><span class="metric-caption">{{
          status
            ? `${status.nodes.filter((node) => node.active && !node.bypassed).length} 个节点正在处理`
            : '等待引擎报告'
        }}</span>
      </div>
      <div class="signal-metric">
        <span>输出延迟 <small>LATENCY</small></span
        ><strong
          >{{ metric(outputInfo && outputInfo.latencyMs > 0 ? outputInfo.latencyMs : null)
          }}<small>ms</small></strong
        ><span class="metric-caption">{{
          outputInfo && outputInfo.bufferSizeFrames > 0
            ? `${outputInfo.bufferSizeFrames} frames 缓冲`
            : '等待设备报告实际缓冲'
        }}</span>
      </div>
    </div>
    <section class="signal-scope" aria-label="实时音频频谱">
      <header>
        <div>
          <span class="scope-light" :class="{ active: !!levels }"></span>
          <h3>实时频谱</h3>
          <span class="scope-subtitle">SPECTRUM ANALYZER</span>
        </div>
        <div>
          <span>{{ dspSampleRate(outputInfo?.actualSampleRate) }}</span
          ><button
            :aria-pressed="frozen"
            :disabled="!levels && !frozen"
            :aria-label="frozen ? '继续频谱' : '冻结频谱'"
            @click="frozen = !frozen"
          >
            <i :class="frozen ? 'pi pi-play' : 'pi pi-pause'"></i>
          </button>
        </div>
      </header>
      <div class="scope-plot">
        <div class="scope-db-axis" aria-hidden="true">
          <span>0</span><span>−30</span><span>−60</span><span>−90 <small>dB</small></span>
        </div>
        <div class="scope-grid">
          <svg viewBox="0 20.6 100 77.4" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="dsp-spectrum-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="currentColor" stop-opacity=".32" />
                <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path :ref="spectrum.fillRef" fill="url(#dsp-spectrum-fill)" />
            <path
              :ref="spectrum.lineRef"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <div v-if="!levels && !frozen" class="scope-empty">
            <i class="pi pi-wave-pulse"></i
            ><span>{{
              !audioProcessing.fftEnabled
                ? 'FFT 采集未开启'
                : isPlaying
                  ? '等待频谱数据'
                  : '播放音乐，查看声音的实时轮廓'
            }}</span
            ><small>{{
              !audioProcessing.fftEnabled
                ? '可在下方「采集与详细诊断」中开启'
                : '20 Hz — 20 kHz · 对数频率'
            }}</small>
          </div>
        </div>
      </div>
      <div class="scope-frequency-axis" aria-hidden="true">
        <span>20 Hz</span><span>100</span><span>1k</span><span>5k</span><span>20k</span>
      </div>
      <footer>
        <span
          ><i class="pi pi-circle-fill"></i
          >{{ frozen ? '显示已冻结的频谱' : levels ? '来自实时音频采集' : '等待音频信号' }}</span
        ><span
          >峰值 {{ metric(visualizationData.active ? visualizationData.peakDb : null) }} dBFS
          <span class="scope-separator">/</span> RMS
          {{ metric(visualizationData.active ? visualizationData.rmsDb : null) }} dBFS</span
        >
      </footer>
    </section>
    <div class="diagnostics-panels">
      <section class="surface-panel health-panel">
        <header class="panel-heading">
          <h3>链路检查</h3>
          <span class="section-tag">运行事实</span>
        </header>
        <div v-for="check in checks" :key="check.label" class="health-row">
          <span class="health-icon"><i :class="check.icon"></i></span>
          <div>
            <strong>{{ check.label }}</strong
            ><span>{{ check.detail }}</span>
          </div>
          <i
            :class="[
              'health-result',
              check.tone,
              check.tone === 'success'
                ? 'pi pi-check-circle'
                : check.tone === 'warning'
                  ? 'pi pi-exclamation-circle'
                  : 'pi pi-minus-circle'
            ]"
          ></i>
        </div>
      </section>
      <section class="surface-panel loudness-panel">
        <header class="panel-heading">
          <h3>响度与声道</h3>
          <span class="section-tag">EBU R128</span>
        </header>
        <div v-for="item in loudness" :key="item.label" class="loudness-row">
          <span>{{ item.label }}</span>
          <div class="loudness-track"><i :style="{ width: `${meterWidth(item.value)}%` }"></i></div>
          <strong>{{ metric(item.value) }}<small> LUFS</small></strong>
        </div>
        <div class="stereo-readings">
          <div>
            <span>响度范围</span
            ><strong>{{ metric(status?.meter?.loudnessRangeLu) }} <small>LU</small></strong>
          </div>
          <div>
            <span>声道相关性</span><strong>{{ metric(status?.meter?.correlation, 2) }}</strong>
          </div>
          <div>
            <span>削波次数</span><strong>{{ status?.meter?.clipCount ?? '—' }}</strong>
          </div>
        </div>
      </section>
    </div>
    <div class="diagnostics-next">
      <div>
        <p class="eyebrow">MAKE IT YOURS</p>
        <h3>接下来，塑造你喜欢的声音</h3>
      </div>
      <button @click="emit('navigate', 'equalizer')">
        均衡与耳机校正<i class="pi pi-arrow-right"></i></button
      ><button @click="emit('navigate', 'chain')">
        构建效果链<i class="pi pi-arrow-right"></i>
      </button>
    </div>
    <details
      class="raw-config diagnostic-details"
      @toggle="expanded = ($event.target as HTMLDetailsElement).open"
    >
      <summary>采集与详细诊断 <span>FFT · 节点耗时 · 引擎数据</span></summary>
      <template v-if="expanded"
        ><slot name="capture" />
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
            </tbody>
          </table>
        </div>
        <details>
          <summary>完整引擎数据</summary>
          <pre>{{ JSON.stringify(status, null, 2) }}</pre>
        </details></template
      >
    </details>
  </section>
</template>
