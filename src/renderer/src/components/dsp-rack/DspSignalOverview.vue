<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { dspApplyLabel } from '@renderer/utils/dspWorkbench'
import { dspSampleRate, dspSignalNodes } from '@renderer/utils/dspSignalOverview'
import { nodeLabel } from '@renderer/utils/dspNodeParams'
import type { DspGraphStatus, DspSceneState } from '../../../../shared/dspGraph.ts'

const props = defineProps<{
  status: DspGraphStatus | null
  sceneState: DspSceneState | null
  sceneName: string
  disabled: boolean
}>()
const emit = defineEmits<{ node: [id: string]; output: [] }>()
const {
  audioProcessing,
  outputInfo,
  playbackInfo,
  audioOutputConfig,
  audioEngineReady,
  audioDevice,
  audioDeviceOptions
} = storeToRefs(useAudioOutputDspStore())
const { isPlaying } = usePlayerStore()
const bypassed = computed(
  () =>
    !audioProcessing.value.dspEnabled ||
    audioProcessing.value.directMode ||
    !!props.sceneState?.effectiveBypassReason
)
const nodes = computed(() => dspSignalNodes(props.sceneState, props.status, bypassed.value))
const flowing = computed(() => audioEngineReady.value && isPlaying.value)
const rate = computed(
  () => outputInfo.value?.actualSampleRate || outputInfo.value?.outputSampleRate
)
const outputName = computed(
  () =>
    outputInfo.value?.actualDeviceName ||
    audioDeviceOptions.value.find((device) => device.id === audioDevice.value)?.label ||
    '等待输出设备'
)
const buffer = computed(() => outputInfo.value?.bufferSizeFrames)
const requestedBuffer = computed(() => audioOutputConfig.value?.preferredBufferSize || 0)
const sceneTitle = computed(() =>
  audioProcessing.value.directMode
    ? `${props.sceneName} · Direct 直通`
    : !audioProcessing.value.dspEnabled
      ? `${props.sceneName} · DSP 已旁路`
      : props.sceneState?.effectiveBypassReason
        ? `${props.sceneName} · ${props.sceneState.effectiveBypassReason}`
        : `${props.sceneName} · ${dspApplyLabel(props.status)}`
)
const sourceFormat = computed(() => {
  const info = playbackInfo.value
  const parts = [dspSampleRate(info?.sourceSampleRate)]
  if (info?.sourceBitDepth) parts.push(`${info.sourceBitDepth} bit`)
  return parts.join(' · ')
})
</script>

<template>
  <section
    class="signal-overview"
    :class="{ 'is-bypassed': bypassed, 'is-flowing': flowing, 'is-offline': !audioEngineReady }"
    aria-label="实时音频链路"
  >
    <div class="signal-path">
      <span
        class="signal-terminal signal-source"
        :title="`输入 · ${playbackInfo?.codec?.toUpperCase() || '音频源'} · ${sourceFormat}`"
      >
        <i class="signal-led" aria-hidden="true"></i
        ><strong>{{ playbackInfo?.codec?.toUpperCase() || '音频源' }}</strong
        ><em>{{ sourceFormat }}</em>
      </span>
      <span class="signal-wire" aria-hidden="true"></span>
      <div class="signal-scene" :title="sceneTitle">
        <span class="signal-scene-name">{{ sceneName }}</span>
        <ol class="overview-nodes" aria-label="当前引擎链路">
          <li v-for="node in nodes" :key="node.id">
            <button
              class="rail-node"
              :class="{ 'is-active': node.active, 'is-off': node.state === '已旁路' }"
              :disabled="disabled || !node.configured"
              :title="node.reason || `${node.state} · 编辑 ${nodeLabel(node.type)}`"
              @click="emit('node', node.id)"
            >
              <i class="rail-led" aria-hidden="true"></i>{{ nodeLabel(node.type) }}
            </button>
          </li>
        </ol>
        <span v-if="!nodes.length" class="route-empty">{{
          status ? '无处理节点' : '等待引擎报告'
        }}</span>
      </div>
      <span class="signal-wire" aria-hidden="true"></span>
      <button
        class="signal-terminal signal-output"
        :disabled="disabled"
        :title="`输出 · ${outputName} · ${outputInfo?.actualBitDepth ? `${outputInfo.actualBitDepth} bit` : '—'} · ${outputInfo?.actualChannels || '—'} ch · 打开输出设置`"
        @click="emit('output')"
      >
        <i class="signal-led" aria-hidden="true"></i><strong>{{ outputName }}</strong
        ><em
          >{{ outputInfo?.actualBackend || outputInfo?.backend || '—' }} ·
          {{ outputInfo?.exclusive ? '独占' : '共享' }}</em
        >
      </button>
    </div>
    <dl class="rail-readouts">
      <div :title="`输出采样率 ${dspSampleRate(rate)}`">
        <dt>采样率</dt>
        <dd>{{ dspSampleRate(rate) }}</dd>
      </div>
      <div
        :title="requestedBuffer ? `请求 ${requestedBuffer} frames` : '请求缓冲：自动（由驱动决定）'"
      >
        <dt>缓冲</dt>
        <dd>{{ buffer && buffer > 0 ? buffer : '—' }}</dd>
      </div>
      <div :title="`DSP 算法延迟 ${status?.totalLatencyFrames ?? '—'} frames`">
        <dt>延迟</dt>
        <dd>
          {{ outputInfo && outputInfo.latencyMs > 0 ? outputInfo.latencyMs.toFixed(1) : '—' }} ms
        </dd>
      </div>
    </dl>
  </section>
</template>
