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
const resamplerLabels = {
  native: '原生 · Native',
  high: '高品质 · High',
  ultra: '超高品质 · Ultra',
  soxrHq: 'SoX HQ（需运行时验证）',
  soxrVhq: 'SoX VHQ（需运行时验证）'
}
const ditherLabels = {
  off: '关闭',
  tpdf: 'TPDF · 三角分布',
  highpassTpdf: '高通 TPDF',
  noiseShaped: '噪声整形'
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
        <span class="panel-icon"><i class="pi pi-sliders-h"></i></span>
        <div>
          <h2>采样与输出处理</h2>
          <p>属于当前场景，保存更改后应用。</p>
        </div>
        <span class="section-tag">场景参数</span>
      </header>
      <div class="output-control-rows">
        <label class="output-control-row"
          ><span
            ><strong>输出采样率</strong><small>默认跟随设备；也可固定到指定采样率。</small></span
          ><select v-model="scene.graph.outputStage.targetSampleRate" aria-label="输出采样率">
            <option
              v-for="item in DSP_OUTPUT_SAMPLE_RATE_OPTIONS"
              :key="item.value"
              :value="item.value"
            >
              {{ item.value === 'device' ? '跟随输出设备' : item.label }}
            </option>
          </select></label
        >
        <label class="output-control-row"
          ><span><strong>重采样质量</strong><small>更高质量需要更多计算资源。</small></span
          ><select v-model="scene.graph.outputStage.resamplerQuality" aria-label="重采样质量">
            <option
              v-for="item in DSP_RESAMPLER_QUALITY_OPTIONS"
              :key="item.value"
              :value="item.value"
            >
              {{ resamplerLabels[item.value] }}
            </option>
          </select></label
        >
        <label class="output-control-row"
          ><span
            ><strong>量化抖动 · Dither</strong
            ><small>降低输出位深时使用，通常保持关闭。</small></span
          ><select v-model="scene.graph.outputStage.dither" aria-label="量化抖动">
            <option v-for="item in DSP_DITHER_MODE_OPTIONS" :key="item.value" :value="item.value">
              {{ ditherLabels[item.value] }}
            </option>
          </select></label
        >
        <label class="output-control-row"
          ><span><strong>安全限幅</strong><small>将 PCM 输出限制到数字满幅范围。</small></span
          ><input
            v-model="scene.graph.outputStage.safetyClamp"
            type="checkbox"
            class="dsp-toggle-input"
            aria-label="安全限幅"
        /></label>
      </div>
      <p class="notice" aria-live="polite">
        {{ describeResampler(scene.graph.outputStage.resamplerQuality, status?.outputStage) }}
      </p>
    </section>
    <section class="buffer-panel surface-panel">
      <header class="panel-heading">
        <span class="panel-icon"><i class="pi pi-microchip"></i></span>
        <div>
          <h2>缓冲与延迟</h2>
          <p>在响应速度与稳定播放之间取得平衡。</p>
        </div>
        <span class="section-tag">设备参数</span>
      </header>
      <div class="buffer-readouts">
        <div>
          <span>实际 Buffer size</span
          ><strong
            >{{ outputInfo && outputInfo.bufferSizeFrames > 0 ? outputInfo.bufferSizeFrames : '—'
            }}<small>frames</small></strong
          >
        </div>
        <div>
          <span>实际输出延迟</span
          ><strong
            >{{ outputInfo && outputInfo.latencyMs > 0 ? outputInfo.latencyMs.toFixed(1) : '—'
            }}<small>ms</small></strong
          >
        </div>
        <div>
          <span>当前采样率</span
          ><strong class="buffer-rate">{{ dspSampleRate(outputInfo?.actualSampleRate) }}</strong>
        </div>
      </div>
      <div class="buffer-adjustment">
        <label
          >请求缓冲大小<select v-model="bufferDraft" aria-label="请求缓冲大小" :disabled="pending">
            <option v-for="size in bufferOptions" :key="size" :value="size">
              {{ size === 0 ? '自动 · 由驱动决定' : `${size} frames` }}
            </option>
          </select></label
        ><button
          class="primary-button"
          :disabled="pending || bufferDraft === (audioOutputConfig?.preferredBufferSize ?? 0)"
          @click="applyBuffer"
        >
          {{ pending ? '正在应用…' : '应用缓冲' }}
        </button>
      </div>
      <div class="buffer-scale" aria-hidden="true">
        <span>更低延迟</span><span>更高稳定性</span>
      </div>
      <p class="buffer-notice">
        <i class="pi pi-info-circle"></i
        >应用缓冲会重新打开输出设备，播放可能短暂停顿。驱动可能采用不同于请求的实际值。
      </p>
      <p
        v-if="bufferError || audioOutputConfigApplyStatus?.state === 'failed'"
        class="error"
        role="alert"
      >
        {{ bufferError || audioOutputConfigApplyStatus?.error }}
      </p>
      <p v-else-if="bufferMessage" class="buffer-feedback" role="status">{{ bufferMessage }}</p>
    </section>
  </div>
</template>
