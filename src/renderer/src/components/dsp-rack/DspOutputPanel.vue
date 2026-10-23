<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { dspSampleRate } from '@renderer/utils/dspSignalOverview'
import { describeResampler } from '../../../../shared/resamplerStatus.ts'
import {
  DSP_OUTPUT_SAMPLE_RATE_OPTIONS,
  DSP_RESAMPLER_QUALITY_OPTIONS,
  DSP_DITHER_MODE_OPTIONS,
  type DspScene,
  type DspGraphStatus
} from '../../../../shared/dspGraph.ts'

const scene = defineModel<DspScene | null>('scene', { required: true })
defineProps<{ status: DspGraphStatus | null }>()
const emit = defineEmits<{ busy: [busy: boolean] }>()
const store = useAudioOutputDspStore()
const { outputInfo, audioOutputConfig, audioOutputConfigApplyStatus } = storeToRefs(store)
const bufferDraft = ref(audioOutputConfig.value?.preferredBufferSize ?? 0)
const bufferBusy = ref(false)
const bufferMessage = ref('')
const bufferError = ref('')
const resamplerLabels: Record<string, [string, string]> = {
  native: ['原生', 'Native'],
  high: ['高品质', 'High'],
  ultra: ['超高品质', 'Ultra'],
  soxrHq: ['SoX HQ', 'libsoxr · 需运行时验证'],
  soxrVhq: ['SoX VHQ', '最高品质 · 需运行时验证']
}
}
const ditherLabels: Record<string, [string, string]> = {
  off: ['关闭', '推荐'],
  tpdf: ['TPDF', '三角分布'],
  highpassTpdf: ['高通 TPDF', '更少可闻噪声'],
  noiseShaped: ['噪声整形', '移至高频']
}
const bufferOptions = computed(() =>
  [
    ...new Set([
      0,
      64,
      128,
      256,
      512,
      1024,
      2048,
      4096,
      8192,
      16384,
      32768,
      audioOutputConfig.value?.preferredBufferSize ?? 0
    ])
  ].sort((a, b) => a - b)
)
const pending = computed(
  () => bufferBusy.value || audioOutputConfigApplyStatus.value?.state === 'pending'
)
const actualRate = computed(
  () => outputInfo.value?.actualSampleRate || outputInfo.value?.outputSampleRate || 0
)
const actualBuffer = computed(() =>
  outputInfo.value && outputInfo.value.bufferSizeFrames > 0 ? outputInfo.value.bufferSizeFrames : 0
)
/** Logarithmic position of a buffer size between 64 and 32768 frames. */
function bufferPosition(frames: number): number {
  if (!frames) return 0
  return Math.max(0, Math.min(100, ((Math.log2(frames) - 6) / 9) * 100))
}
const draftDuration = computed(() =>
  bufferDraft.value && actualRate.value ? (bufferDraft.value / actualRate.value) * 1000 : null
)
const processingCount = computed(
  () => scene.value?.graph.nodes.filter((node) => node.enabled && node.type !== 'meter').length ?? 0
)
const targetLabel = computed(() => {
  const target = scene.value?.graph.outputStage.targetSampleRate
  return target === 'device' || !target ? '跟随设备' : dspSampleRate(target)
})
watch(
  () => audioOutputConfig.value?.preferredBufferSize,
  (value) => {
    bufferDraft.value = value ?? 0
  }
)
async function applyBuffer(): Promise<void> {
  if (pending.value) return
  bufferBusy.value = true
  emit('busy', true)
  bufferMessage.value = ''
  bufferError.value = ''
  try {
    await store.setAudioOutputConfig({ preferredBufferSize: bufferDraft.value })
    if (audioOutputConfigApplyStatus.value?.state !== 'failed')
      bufferMessage.value =
        audioOutputConfigApplyStatus.value?.state === 'pending'
          ? '已提交，等待设备确认。'
          : '缓冲请求已应用；实际值以设备报告为准。'
  } catch (cause) {
    bufferError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    bufferBusy.value = false
    emit('busy', false)
  }
}
</script>

<template>
  <div class="output-workspace">
    <section v-if="scene" class="output-stage-panel surface-panel">
      <header class="panel-heading">
        <div>
          <h2>输出级</h2>
          <p>属于场景「{{ scene.name }}」，保存更改后应用。</p>
        </div>
        <span class="section-tag" data-mode="draft">场景草稿</span>
      </header>
      <ol class="stage-flow" aria-label="输出级处理顺序">
        <li>
          <small>DSP 链</small><strong>{{ processingCount }} 个处理器</strong>
        </li>
        <li>
          <small>目标采样率</small><strong>{{ targetLabel }}</strong>
        </li>
        <li>
          <small>重采样</small
          ><strong>{{ resamplerLabels[scene.graph.outputStage.resamplerQuality]?.[0] }}</strong>
        </li>
        <li>
          <small>抖动</small
          ><strong>{{ ditherLabels[scene.graph.outputStage.dither]?.[0] }}</strong>
        </li>
        <li :class="{ off: !scene.graph.outputStage.safetyClamp }">
          <small>安全限幅</small
          ><strong>{{ scene.graph.outputStage.safetyClamp ? '开启' : '关闭' }}</strong>
        </li>
        <li class="is-device">
          <small>设备实际</small><strong>{{ dspSampleRate(actualRate) }}</strong>
        </li>
      </ol>
      <div class="option-group">
        <div class="option-copy">
          <strong>输出采样率</strong><small>默认跟随设备；固定后由 DSP 重采样到目标采样率。</small>
        </div>
        <div class="option-chips" role="radiogroup" aria-label="输出采样率">
          <label
            v-for="item in DSP_OUTPUT_SAMPLE_RATE_OPTIONS"
            :key="item.value"
            class="option-chip"
            :class="{ wide: item.value === 'device' }"
            ><input
              v-model="scene.graph.outputStage.targetSampleRate"
              type="radio"
              name="dsp-output-sample-rate"
              :value="item.value"
            /><span
              ><strong>{{ item.value === 'device' ? '跟随设备' : item.label }}</strong></span
            ></label
          >
        </div>
      </div>
      <div class="option-group">
        <div class="option-copy">
          <strong>重采样质量</strong><small>仅在采样率改变时生效；更高质量需要更多计算资源。</small>
        </div>
        <div class="option-chips" role="radiogroup" aria-label="重采样质量">
          <label
            v-for="item in DSP_RESAMPLER_QUALITY_OPTIONS"
            :key="item.value"
            class="option-chip stacked"
            ><input
              v-model="scene.graph.outputStage.resamplerQuality"
              type="radio"
              name="dsp-output-resampler"
              :value="item.value"
            /><span
              ><strong>{{ resamplerLabels[item.value]?.[0] ?? item.label }}</strong
              ><small>{{ resamplerLabels[item.value]?.[1] }}</small></span
            ></label
          >
        </div>
      </div>
      <div class="option-group">
        <div class="option-copy">
          <strong>量化抖动 · Dither</strong><small>降低输出位深时使用，通常保持关闭。</small>
        </div>
        <div class="option-chips" role="radiogroup" aria-label="量化抖动">
          <label
            v-for="item in DSP_DITHER_MODE_OPTIONS"
            :key="item.value"
            class="option-chip stacked"
            ><input
              v-model="scene.graph.outputStage.dither"
              type="radio"
              name="dsp-output-dither"
              :value="item.value"
            /><span
              ><strong>{{ ditherLabels[item.value]?.[0] ?? item.label }}</strong
              ><small>{{ ditherLabels[item.value]?.[1] }}</small></span
            ></label
          >
        </div>
      </div>
      <label class="option-group option-switch">
        <span class="option-copy"
          ><strong>安全限幅</strong><small>将 PCM 输出限制在数字满幅范围内，防止削波。</small></span
        ><input
          v-model="scene.graph.outputStage.safetyClamp"
          type="checkbox"
          aria-label="安全限幅"
        />
      </label>
      <p class="notice" aria-live="polite">
        <i class="pi pi-info-circle"></i>{{
          describeResampler(scene.graph.outputStage.resamplerQuality, status?.outputStage)
        }}
      </p>
    </section>
    <section class="buffer-panel surface-panel">
      <header class="panel-heading">
        <div>
          <h2>缓冲与延迟</h2>
          <p>在响应速度与播放稳定性之间取得平衡。</p>
        </div>
        <span class="section-tag" data-mode="live">设备 · 立即应用</span>
      </header>
      <div class="buffer-readouts">
        <div>
          <span>实际缓冲</span><strong>{{ actualBuffer || '—' }}<small>frames</small></strong>
        </div>
        <div>
          <span>输出延迟</span
          ><strong
            >{{ outputInfo && outputInfo.latencyMs > 0 ? outputInfo.latencyMs.toFixed(1) : '—'
            }}<small>ms</small></strong
          >
        </div>
        <div>
          <span>设备采样率</span
          ><strong class="buffer-rate">{{ dspSampleRate(actualRate) }}</strong>
        </div>
      </div>
      <div class="buffer-scale" aria-hidden="true">
        <div class="buffer-track">
          <i
            v-if="actualBuffer"
            class="buffer-marker actual"
            :style="{ left: `${bufferPosition(actualBuffer)}%` }"
            ><b>实际</b></i
          >
          <i
            v-if="bufferDraft"
            class="buffer-marker draft"
            :style="{ left: `${bufferPosition(bufferDraft)}%` }"
            ><b>请求</b></i
          >
        </div>
        <div class="buffer-scale-labels">
          <span>64 · 更低延迟</span><span>32768 · 更高稳定性</span>
        </div>
      </div>
      <div class="buffer-adjustment">
        <label class="field"
          ><span>请求缓冲大小</span
          ><select v-model="bufferDraft" aria-label="请求缓冲大小" :disabled="pending">
            <option v-for="size in bufferOptions" :key="size" :value="size">
              {{ size === 0 ? '自动 · 由驱动决定' : `${size} frames` }}
            </option>
          </select></label
        >
        <span class="buffer-duration">{{
          draftDuration !== null
            ? `缓冲时长 ≈ ${draftDuration.toFixed(1)} ms @ ${dspSampleRate(actualRate)}`
            : '由驱动选择缓冲时长'
        }}</span>
        <button
          class="primary-button"
          :disabled="pending || bufferDraft === (audioOutputConfig?.preferredBufferSize ?? 0)"
          @click="applyBuffer"
        >
          <i :class="pending ? 'pi pi-spinner pi-spin' : 'pi pi-check'"></i
          >{{ pending ? '正在应用…' : '应用缓冲' }}
        </button>
      </div>
      <p class="buffer-notice">
        <i class="pi pi-info-circle"></i
        ><span>应用缓冲会重新打开输出设备，播放可能短暂停顿；驱动可能采用不同于请求的实际值。</span>
      </p>
      <p
        v-if="bufferError || audioOutputConfigApplyStatus?.state === 'failed'"
        class="error"
        role="alert"
      >
        <i class="pi pi-exclamation-triangle"></i
        >{{ bufferError || audioOutputConfigApplyStatus?.error }}
      </p>
      <p v-else-if="bufferMessage" class="buffer-feedback" role="status">
        <i class="pi pi-check-circle"></i>{{ bufferMessage }}
      </p>
    </section>
  </div>
</template>
