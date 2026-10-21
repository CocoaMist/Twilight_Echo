<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
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
const bypassed = computed(
  () =>
    !audioProcessing.value.dspEnabled ||
    audioProcessing.value.directMode ||
    !!props.sceneState?.effectiveBypassReason
)
const nodes = computed(() => dspSignalNodes(props.sceneState, props.status, bypassed.value))
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
const stateLabel = computed(() =>
  audioProcessing.value.directMode
    ? 'Direct 直通'
    : !audioProcessing.value.dspEnabled
      ? 'DSP 已旁路'
      : dspApplyLabel(props.status)
)
</script>

<template>
  <aside class="signal-overview" aria-label="实时音频链路总览">
    <div class="overview-heading">
      <div>
        <p class="eyebrow">SIGNAL PATH</p>
        <h2>你的音频链路</h2>
      </div>
      <span class="overview-live" :class="{ ready: audioEngineReady }"
        ><i></i>{{ audioEngineReady ? '已连接' : '未连接' }}</span
      >
    </div>
    <div class="overview-scene">
      <i class="pi pi-sliders-h"></i><span>{{ sceneName }}</span
      ><small>当前场景</small>
    </div>
    <div class="signal-route">
      <div class="route-terminal">
        <span class="route-icon"><i class="pi pi-play-circle"></i></span>
        <div>
          <span class="route-kicker">SOURCE / 输入</span
          ><strong>{{ playbackInfo?.codec?.toUpperCase() || '音频源' }}</strong>
          <small
            >{{ dspSampleRate(playbackInfo?.sourceSampleRate)
            }}<template v-if="playbackInfo?.sourceBitDepth">
              · {{ playbackInfo.sourceBitDepth }} bit</template
            ></small
          >
        </div>
      </div>
      <div class="route-processing">
        <div class="route-processing-heading">
          <span>DSP 处理</span
          ><small :class="{ 'signal-active': !bypassed }">{{ stateLabel }}</small>
        </div>
        <ol class="overview-nodes">
          <li v-for="(node, index) in nodes" :key="node.id" :class="{ 'is-active': node.active }">
            <button
              :disabled="disabled || !node.configured"
              :title="node.reason || `编辑 ${nodeLabel(node.type)}`"
              @click="emit('node', node.id)"
            >
              <span class="route-node-dot"></span
              ><span class="route-node-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="route-node-name">{{ nodeLabel(node.type) }}</span
              ><small>{{ node.state }}</small>
            </button>
          </li>
        </ol>
        <p v-if="!nodes.length" class="route-empty">
          {{ status ? '直达输出 · 无处理节点' : '等待引擎报告链路' }}
        </p>
      </div>
      <button class="route-terminal route-output" :disabled="disabled" @click="emit('output')">
        <span class="route-icon"><i class="pi pi-headphones"></i></span>
        <span
          ><span class="route-kicker">OUTPUT / 输出</span
          ><strong :title="outputName">{{ outputName }}</strong>
          <small
            >{{ outputInfo?.actualBackend || outputInfo?.backend || '—' }} ·
            {{ outputInfo?.exclusive ? '独占' : '共享 / 默认' }}</small
          ></span
        ><i class="pi pi-arrow-up-right"></i>
      </button>
    </div>
    <div class="overview-parameters">
      <div class="overview-section-label"><span>运行参数</span><i class="pi pi-microchip"></i></div>
      <dl>
        <div>
          <dt>采样率</dt>
          <dd>{{ dspSampleRate(rate) }}</dd>
        </div>
        <div>
          <dt>位深 / 声道</dt>
          <dd>
            {{ outputInfo?.actualBitDepth ? `${outputInfo.actualBitDepth} bit` : '—' }} /
            {{ outputInfo?.actualChannels || '—' }}
          </dd>
        </div>
        <div>
          <dt>Buffer size</dt>
          <dd>{{ buffer && buffer > 0 ? buffer : '—' }} <small>frames</small></dd>
        </div>
        <div>
          <dt>请求缓冲</dt>
          <dd>
            {{ audioOutputConfig?.preferredBufferSize || '自动'
            }}<small v-if="audioOutputConfig?.preferredBufferSize"> frames</small>
          </dd>
        </div>
        <div>
          <dt>输出延迟</dt>
          <dd>
            {{ outputInfo && outputInfo.latencyMs > 0 ? outputInfo.latencyMs.toFixed(1) : '—' }}
            <small>ms</small>
          </dd>
        </div>
        <div>
          <dt>DSP 延迟</dt>
          <dd>{{ status?.totalLatencyFrames ?? '—' }} <small>frames</small></dd>
        </div>
      </dl>
    </div>
    <div class="overview-footnote">
      <i class="pi pi-info-circle"></i><span>显示当前引擎链路，草稿保存后生效。</span>
    </div>
  </aside>
</template>
