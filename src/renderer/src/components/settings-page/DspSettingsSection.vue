<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import { useAudioOutputDspStore } from '../../stores/useAudioOutputDspStore'
import {
  LOUDNORM_TARGET_LUFS,
  LOUDNORM_TRUE_PEAK_CEILING_DB,
  loudnormStatusCopy
} from '../../../../shared/audioProcessingOptions.ts'
import type { Vst3CatalogState } from '../../../../shared/dspGraph.ts'
import type {
  AudioProcessingSettings,
  DsdOutputMode,
  DsdRatePolicy,
  SacdProgramMode,
  VolumeNormalizationMode
} from '../../types/settings'
import {
  dsdOutputModeOptions,
  dsdRatePolicyOptions,
  fftResolutionOptions,
  replayGainOptions,
  sacdProgramModeOptions
} from './types.ts'

const emit = defineEmits<{
  openEqualizer: []
  openDspRack: []
}>()

const audioOutputDspStore = useAudioOutputDspStore()
const { audioOutput, audioProcessing, playbackInfo, outputInfo, loudnormStatus } =
  storeToRefs(audioOutputDspStore)

const {
  setAudioProcessing,
  setReplayGainMode,
  setCrossfeedStrength,
  selectImpulseResponse,
  clearImpulseResponse
} = audioOutputDspStore

// DSP 信号链状态
const eqChainActive = computed(
  () => audioProcessing.value.dspEnabled && audioProcessing.value.eqEnabled
)
const crossfeedChainActive = computed(
  () => audioProcessing.value.dspEnabled && audioProcessing.value.crossfeedEnabled
)
const convolverChainActive = computed(
  () => audioProcessing.value.dspEnabled && audioProcessing.value.convolverEnabled
)

// Crossfeed 百分比
const crossfeedPercent = computed(() => Math.round(audioProcessing.value.crossfeedStrength * 100))

function compactRate(rate: number): string {
  return rate > 0 ? `${Math.round(rate / 100) / 10}kHz` : ''
}

const dspInputText = computed(() => {
  const info = playbackInfo.value
  if (!info) return '待命'
  const depth = info.sourceBitDepth > 0 ? `${info.sourceBitDepth}bit` : ''
  const rate = info.sourceSampleRate > 0 ? compactRate(info.sourceSampleRate) : ''
  const codec = info.codec || 'PCM'
  return [codec, depth, rate].filter(Boolean).join(' ') || 'PCM'
})

const dspProcessText = computed(() => {
  if (!audioProcessing.value.dspEnabled) return 'Bypass'
  return playbackInfo.value?.dspActive ? '正在处理' : '处理链待命'
})

const dspOutputText = computed(() => {
  const out = outputInfo.value
  if (!out) return audioOutput.value.toUpperCase()
  const backend = out.actualBackend || audioOutput.value
  const mode = out.accessMode ? ` · ${out.accessMode}` : ''
  return `${backend}${mode}`
})

const outputFormatText = computed(() => {
  const info = outputInfo.value
  if (!info) return '等待音频引擎'
  const format = info.actualOutputFormat || playbackInfo.value?.actualOutputFormat || ''
  const rate =
    info.actualSampleRate || info.outputSampleRate || playbackInfo.value?.actualSampleRate || 0
  const bitDepth =
    info.actualBitDepth || info.outputBitDepth || playbackInfo.value?.actualBitDepth || 0
  const channels = info.actualChannels || playbackInfo.value?.actualChannels || 0
  const parts = [
    format,
    rate > 0 ? `${rate} Hz` : '',
    bitDepth > 0 ? `${bitDepth} bit` : '',
    channels > 0 ? `${channels} ch` : ''
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '未开始播放'
})

const dspModuleCount = computed(() => {
  const p = audioProcessing.value
  let count = 0
  if (p.eqEnabled) count++
  if (p.volumeNormalization !== 'off') count++
  if (p.crossfeedEnabled) count++
  if (p.convolverEnabled) count++
  return count
})

const convolverPathLabel = computed(() => {
  const path = audioProcessing.value.convolverIrPath
  if (!path) return '未加载'
  return path.split(/[\\/]/).pop() || path
})

const replayGainModeLabel = computed(
  () =>
    replayGainOptions.find((option) => option.value === audioProcessing.value.volumeNormalization)
      ?.label ?? 'Off'
)
const eqSummaryText = computed(() =>
  audioProcessing.value.eqEnabled
    ? `${audioProcessing.value.eqMode === 'parametric' ? '参数' : '图形'} · Preamp ${audioProcessing.value.eqPreamp.toFixed(1)} dB`
    : '未启用'
)
const loudnormStatusText = computed(() => {
  if (audioProcessing.value.volumeNormalization !== 'loudnorm') return ''
  return loudnormStatusCopy(loudnormStatus.value ?? 'idle')
})

function updateAudioProcessing(patch: Partial<AudioProcessingSettings>): void {
  void setAudioProcessing(patch)
}

function setReplayGainFromSelect(event: Event): void {
  void setReplayGainMode((event.target as HTMLSelectElement).value as VolumeNormalizationMode)
}

function setReplayGainPreamp(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  updateAudioProcessing({ dspEnabled: true, replayGainPreamp: value })
}

function setReplayGainFallback(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  updateAudioProcessing({ dspEnabled: true, replayGainFallback: value })
}

function toggleReplayGainClip(): void {
  updateAudioProcessing({ dspEnabled: true, replayGainClip: !audioProcessing.value.replayGainClip })
}

function setCrossfeedFromInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  setCrossfeedPercent(value)
}

function setCrossfeedPercent(value: number): void {
  void setCrossfeedStrength(value)
}

function setCrossfeedDelay(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  updateAudioProcessing({ dspEnabled: true, crossfeedDelayMs: value })
}

function setCrossfeedCutoff(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  updateAudioProcessing({ dspEnabled: true, crossfeedCutoffHz: value })
}

async function selectDsdOutputMode(value: DsdOutputMode): Promise<void> {
  await setAudioProcessing({ dsdOutputMode: value, dsdToPcm: value === 'pcm' })
}

function setDsdOutputMode(event: Event): void {
  void selectDsdOutputMode((event.target as HTMLSelectElement).value as DsdOutputMode)
}

function setDsdRatePolicy(event: Event): void {
  updateAudioProcessing({
    dsdRatePolicy: (event.target as HTMLSelectElement).value as DsdRatePolicy
  })
}

function setSacdProgramMode(event: Event): void {
  updateAudioProcessing({
    sacdProgramMode: (event.target as HTMLSelectElement).value as SacdProgramMode
  })
}

function setFftResolution(event: Event): void {
  updateAudioProcessing({ fftResolution: Number((event.target as HTMLSelectElement).value) })
}

function toggleFftEnabled(): void {
  updateAudioProcessing({ fftEnabled: !audioProcessing.value.fftEnabled })
}

function toggleClipGuard(): void {
  updateAudioProcessing({ clipGuard: !audioProcessing.value.clipGuard })
}

function toggleConvolver(): void {
  updateAudioProcessing({
    dspEnabled: true,
    convolverEnabled: !audioProcessing.value.convolverEnabled
  })
}

function applyDspPreset(preset: 'headphone' | 'dynamic' | 'bypass'): void {
  if (preset === 'bypass') {
    updateAudioProcessing({ dspEnabled: false })
    return
  }
  if (preset === 'headphone') {
    updateAudioProcessing({
      dspEnabled: true,
      crossfeedEnabled: true,
      crossfeedStrength: 0.4,
      eqEnabled: false
    })
    return
  }
  if (preset === 'dynamic') {
    updateAudioProcessing({
      dspEnabled: true,
      eqEnabled: true,
      crossfeedEnabled: false
    })
  }
}

function toggleDspMaster(): void {
  updateAudioProcessing({ dspEnabled: !audioProcessing.value.dspEnabled })
}

function toggleEqFromDsp(): void {
  updateAudioProcessing({
    dspEnabled: true,
    eqEnabled: !audioProcessing.value.eqEnabled
  })
}

function toggleCrossfeedFromDsp(): void {
  updateAudioProcessing({
    dspEnabled: true,
    crossfeedEnabled: !audioProcessing.value.crossfeedEnabled
  })
}

function openEqualizerFromDsp(): void {
  emit('openEqualizer')
}

function openDspRackFromDsp(): void {
  emit('openDspRack')
}

// VST3 宿主设置（目录状态持久化在主进程 Vst3CatalogService，不新增设置字段）
const vst3Catalog = ref<Vst3CatalogState | null>(null)
const vst3Busy = ref(false)
const vst3Scanning = ref(false)
const vst3Error = ref('')

const vst3Enabled = computed(() => vst3Catalog.value?.enabled === true)
const vst3SearchPaths = computed(() => vst3Catalog.value?.searchPaths ?? [])
const vst3Helpers = computed(() => vst3Catalog.value?.helpers ?? null)
const vst3HelpersReady = computed(() => {
  if (!vst3Helpers.value) return true
  return (
    vst3Helpers.value.platformSupported &&
    vst3Helpers.value.scannerPresent &&
    vst3Helpers.value.hostPresent
  )
})
const vst3PlatformSupported = computed(() => vst3Helpers.value?.platformSupported !== false)
const vst3ToggleUnavailable = computed(
  () =>
    vst3Busy.value ||
    !vst3Catalog.value ||
    !vst3PlatformSupported.value ||
    (!vst3Enabled.value && !vst3HelpersReady.value)
)
const vst3HelpersNotice = computed(() => {
  if (!vst3Catalog.value || vst3HelpersReady.value || !vst3Helpers.value) return ''
  if (!vst3Helpers.value.platformSupported) return '当前系统不支持 VST3 插件运行组件。'
  if (!vst3Helpers.value.scannerPresent || !vst3Helpers.value.hostPresent) {
    return '此版本未包含 VST3 运行或扫描组件。请安装包含这些组件的完整 Windows 版本。'
  }
  return ''
})
const vst3ScanSummary = computed(() => {
  const catalog = vst3Catalog.value
  if (!catalog) return '尚未读取 VST3 目录状态'
  const total = catalog.entries.length
  if (total === 0) return '尚未发现任何 VST3 模块'
  const available = catalog.entries.filter((entry) => entry.status === 'available').length
  const quarantined = catalog.entries.filter((entry) => entry.status === 'quarantined').length
  const parts = [`共 ${total} 个模块`, `${available} 个可用`]
  if (quarantined > 0) parts.push(`${quarantined} 个已隔离`)
  return parts.join(' · ')
})

function vst3ErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'VST3 操作失败'
}

async function refreshVst3Catalog(): Promise<void> {
  if (!window.api?.audioEngine?.getVst3Catalog) return
  try {
    vst3Catalog.value = await window.api.audioEngine.getVst3Catalog()
    vst3Error.value = ''
  } catch (error) {
    vst3Error.value = vst3ErrorMessage(error)
  }
}

async function toggleVst3Enabled(): Promise<void> {
  if (!vst3Catalog.value || vst3ToggleUnavailable.value) return
  vst3Busy.value = true
  try {
    vst3Catalog.value = await window.api.audioEngine.setVst3Enabled(!vst3Catalog.value.enabled)
    vst3Error.value = ''
  } catch (error) {
    vst3Error.value = vst3ErrorMessage(error)
  } finally {
    vst3Busy.value = false
  }
}

async function addVst3SearchPath(): Promise<void> {
  if (vst3Busy.value || !vst3Catalog.value) return
  vst3Busy.value = true
  try {
    const selected = await window.api.audioEngine.selectVst3SearchPath()
    if (selected && !vst3SearchPaths.value.includes(selected)) {
      vst3Catalog.value = await window.api.audioEngine.setVst3SearchPaths([
        ...vst3SearchPaths.value,
        selected
      ])
    }
    vst3Error.value = ''
  } catch (error) {
    vst3Error.value = vst3ErrorMessage(error)
  } finally {
    vst3Busy.value = false
  }
}

async function removeVst3SearchPath(path: string): Promise<void> {
  if (vst3Busy.value || !vst3Catalog.value) return
  vst3Busy.value = true
  try {
    vst3Catalog.value = await window.api.audioEngine.setVst3SearchPaths(
      vst3SearchPaths.value.filter((candidate) => candidate !== path)
    )
    vst3Error.value = ''
  } catch (error) {
    vst3Error.value = vst3ErrorMessage(error)
  } finally {
    vst3Busy.value = false
  }
}

async function rescanVst3Plugins(): Promise<void> {
  if (vst3Scanning.value || !vst3Enabled.value) return
  vst3Scanning.value = true
  try {
    vst3Catalog.value = await window.api.audioEngine.scanVst3Plugins()
    vst3Error.value = ''
  } catch (error) {
    vst3Error.value = vst3ErrorMessage(error)
  } finally {
    vst3Scanning.value = false
  }
}

onMounted(() => {
  void refreshVst3Catalog()
})
</script>

<template>
  <section id="dsp" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-sliders-v"></i>
      <h2>音效</h2>
    </div>
    <div class="setting-item">
      <div class="setting-copy">
        <strong>启用 DSP 声音处理</strong>
        <span>开启均衡器、交叉馈送等模块会同时启用 DSP；格式转换或音效可能改变原始信号。</span>
      </div>
      <button
        type="button"
        class="toggle-switch"
        :class="{ active: audioProcessing.dspEnabled, inactive: !audioProcessing.dspEnabled }"
        role="switch"
        :aria-checked="audioProcessing.dspEnabled"
        @click="toggleDspMaster"
        aria-label="启用 DSP 声音处理"
      ></button>
    </div>
    <details class="settings-advanced-details">
      <summary>音频链路与处理状态</summary>
      <div class="dsp-signal-chain">
        <div class="signal-node static" :class="{ active: true }">
          <div class="signal-node-circle active">
            <i class="pi pi-file"></i>
          </div>
          <span class="signal-node-label">输入</span>
          <span class="signal-node-name">音源</span>
        </div>
        <div class="signal-line" :class="{ active: eqChainActive }"></div>
        <div
          class="signal-node"
          data-te-interactive
          role="switch"
          tabindex="0"
          aria-label="均衡器"
          :aria-checked="eqChainActive"
          :class="{ active: eqChainActive }"
          @click="toggleEqFromDsp"
          @keydown.enter.prevent="toggleEqFromDsp"
          @keydown.space.prevent="toggleEqFromDsp"
        >
          <div class="signal-node-circle" :class="{ active: eqChainActive }">
            <i class="pi pi-sliders-h"></i>
          </div>
          <span class="signal-node-label">{{ eqChainActive ? '已启用' : '已跳过' }}</span>
          <span class="signal-node-name">EQ</span>
        </div>
        <div class="signal-line" :class="{ active: crossfeedChainActive }"></div>
        <div
          class="signal-node"
          data-te-interactive
          role="switch"
          tabindex="0"
          aria-label="Crossfeed"
          :aria-checked="crossfeedChainActive"
          :class="{ active: crossfeedChainActive }"
          @click="toggleCrossfeedFromDsp"
          @keydown.enter.prevent="toggleCrossfeedFromDsp"
          @keydown.space.prevent="toggleCrossfeedFromDsp"
        >
          <div class="signal-node-circle" :class="{ active: crossfeedChainActive }">
            <i class="pi pi-arrows-h"></i>
          </div>
          <span class="signal-node-label">{{ crossfeedChainActive ? '已启用' : '已跳过' }}</span>
          <span class="signal-node-name">CROSSFEED</span>
        </div>
        <div class="signal-line" :class="{ active: convolverChainActive }"></div>
        <div
          class="signal-node"
          data-te-interactive
          role="switch"
          tabindex="0"
          aria-label="卷积混响"
          :aria-checked="convolverChainActive"
          :class="{ active: convolverChainActive }"
          @click="toggleConvolver"
          @keydown.enter.prevent="toggleConvolver"
          @keydown.space.prevent="toggleConvolver"
        >
          <div class="signal-node-circle" :class="{ active: convolverChainActive }">
            <i class="pi pi-microchip"></i>
          </div>
          <span class="signal-node-label">{{ convolverChainActive ? '已启用' : '已跳过' }}</span>
          <span class="signal-node-name">CONVOLVER</span>
        </div>
        <div class="signal-line active"></div>
        <div class="signal-node static" :class="{ active: true }">
          <div class="signal-node-circle active">
            <i class="pi pi-volume-up"></i>
          </div>
          <span class="signal-node-label">DAC</span>
          <span class="signal-node-name">OUTPUT</span>
        </div>
      </div>

      <div class="dsp-status-grid">
        <div class="dsp-meter">
          <span>输入</span>
          <strong>{{ dspInputText }}</strong>
          <small>源信号格式</small>
        </div>
        <div class="dsp-meter">
          <span>处理</span>
          <strong>{{ dspProcessText }}</strong>
          <small>{{ dspModuleCount }} 个模块激活</small>
        </div>
        <div class="dsp-meter">
          <span>输出</span>
          <strong>{{ dspOutputText }}</strong>
          <small>{{ outputFormatText }}</small>
        </div>
      </div>
    </details>

    <div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>音效面板</strong>
          <span>编辑完整的声音处理链，调整模块顺序与参数。</span>
        </div>
        <button class="soft-button" type="button" @click="openDspRackFromDsp">打开音效面板</button>
      </div>

      <h3 class="settings-group-heading">快速预设</h3>
      <div class="dsp-presets" role="group" aria-label="快速预设">
        <button
          class="preset-btn"
          type="button"
          title="启用交叉馈送，强度 40%，关闭均衡器"
          @click="applyDspPreset('headphone')"
        >
          <i class="pi pi-headphones"></i> 耳机交叉馈送
        </button>
        <button
          class="preset-btn"
          type="button"
          title="启用当前均衡器曲线，关闭交叉馈送"
          @click="applyDspPreset('dynamic')"
        >
          <i class="pi pi-bolt"></i> 使用当前均衡器
        </button>
        <button class="preset-btn" type="button" @click="applyDspPreset('bypass')">
          <i class="pi pi-stop-circle"></i> 关闭 DSP 处理
        </button>
      </div>

      <div class="dsp-module-grid">
        <div class="dsp-module-card">
          <h3>基础处理</h3>
          <div class="mini-setting">
            <div>
              <strong>削波保护</strong>
              <span>动态压缩超载信号，防止数字削波失真</span>
            </div>
            <button
              type="button"
              class="toggle-switch"
              :class="{
                active: audioProcessing.clipGuard,
                inactive: !audioProcessing.clipGuard
              }"
              role="switch"
              :aria-checked="audioProcessing.clipGuard"
              @click="toggleClipGuard"
              aria-label="削波保护"
            ></button>
          </div>
          <div class="mini-setting">
            <div>
              <strong>响度均衡（ReplayGain / Loudnorm）</strong>
              <span>
                {{
                  audioProcessing.volumeNormalization === 'loudnorm'
                    ? `EBU R128 Loudnorm · 缓存命中用测量增益（${LOUDNORM_TARGET_LUFS} LUFS / ${LOUDNORM_TRUE_PEAK_CEILING_DB} dBTP）；首次播放无缓存时用 Fallback 并后台测量`
                    : `响度归一化 · ${replayGainModeLabel}`
                }}
              </span>
            </div>
            <select
              aria-label="响度均衡（ReplayGain / Loudnorm）"
              class="preview-select"
              :value="audioProcessing.volumeNormalization"
              @change="setReplayGainFromSelect"
            >
              <option v-for="option in replayGainOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
          <p v-if="loudnormStatusText" class="setting-hint" data-testid="settings-loudnorm-status">
            {{ loudnormStatusText }}
          </p>
          <div class="mini-setting">
            <div>
              <strong>响度预增益</strong>
              <span>预增益 (dB)</span>
            </div>
            <input
              aria-label="响度预增益"
              class="number-input"
              type="number"
              step="0.1"
              :value="audioProcessing.replayGainPreamp"
              @input="setReplayGainPreamp"
            />
          </div>
          <div class="mini-setting">
            <div>
              <strong>缺少响度信息时的增益</strong>
              <span>曲目缺少 ReplayGain/R128 标签时使用的增益 (dB)</span>
            </div>
            <input
              aria-label="缺少响度信息时的增益"
              class="number-input"
              type="number"
              step="0.1"
              min="-12"
              max="12"
              :value="audioProcessing.replayGainFallback"
              @input="setReplayGainFallback"
            />
          </div>
          <div class="mini-setting">
            <div>
              <strong>响度均衡后的削波限制</strong>
              <span>应用 ReplayGain 后限制到 [-1, 1]，避免标准化造成数字削波。</span>
            </div>
            <button
              type="button"
              class="toggle-switch"
              :class="{
                active: audioProcessing.replayGainClip,
                inactive: !audioProcessing.replayGainClip
              }"
              role="switch"
              :aria-checked="audioProcessing.replayGainClip"
              @click="toggleReplayGainClip"
              aria-label="响度均衡后的削波限制"
            ></button>
          </div>
        </div>

        <div class="dsp-module-card">
          <h3>空间与声学</h3>
          <div class="mini-setting">
            <div>
              <strong>参数均衡器（EQ）</strong>
              <span>{{ eqSummaryText }}</span>
            </div>
            <div class="inline-controls">
              <button
                type="button"
                class="toggle-switch"
                :class="{
                  active: audioProcessing.eqEnabled,
                  inactive: !audioProcessing.eqEnabled
                }"
                role="switch"
                :aria-checked="audioProcessing.eqEnabled"
                @click="toggleEqFromDsp"
                aria-label="参数均衡器（EQ）"
              ></button>
              <button class="soft-button compact" type="button" @click="openEqualizerFromDsp">
                <i class="pi pi-sliders-h"></i>
                打开面板
              </button>
            </div>
          </div>
          <div class="mini-setting">
            <div>
              <strong>耳机交叉馈送（Crossfeed）</strong>
              <span>将少量左右声道互相混合，减轻耳机声像过宽。此功能不提供听力保护。</span>
            </div>
            <div class="inline-controls">
              <input
                aria-label="耳机交叉馈送（Crossfeed）"
                class="range-input"
                type="range"
                min="0"
                max="100"
                :value="crossfeedPercent"
                @input="setCrossfeedFromInput"
              />
              <EditableRangeValue
                :value="crossfeedPercent"
                :min="0"
                :max="100"
                suffix="%"
                aria-label="编辑耳机交叉馈电强度"
                @change="setCrossfeedPercent"
              />
              <button
                type="button"
                class="toggle-switch"
                :class="{
                  active: audioProcessing.crossfeedEnabled,
                  inactive: !audioProcessing.crossfeedEnabled
                }"
                role="switch"
                :aria-checked="audioProcessing.crossfeedEnabled"
                @click="
                  updateAudioProcessing({
                    dspEnabled: true,
                    crossfeedEnabled: !audioProcessing.crossfeedEnabled
                  })
                "
                aria-label="耳机交叉馈送（Crossfeed）"
              ></button>
            </div>
          </div>
          <div class="mini-setting">
            <div>
              <strong>交叉馈送延迟</strong>
              <span>左右声道串音延迟，范围 0.05-2.0 ms。</span>
            </div>
            <input
              aria-label="交叉馈送延迟"
              class="number-input"
              type="number"
              step="0.05"
              min="0.05"
              max="2"
              :value="audioProcessing.crossfeedDelayMs"
              @input="setCrossfeedDelay"
            />
          </div>
          <div class="mini-setting">
            <div>
              <strong>交叉馈送截止频率</strong>
              <span>串音低通截止频率，范围 80-4000 Hz。</span>
            </div>
            <input
              aria-label="交叉馈送截止频率"
              class="number-input"
              type="number"
              step="10"
              min="80"
              max="4000"
              :value="audioProcessing.crossfeedCutoffHz"
              @input="setCrossfeedCutoff"
            />
          </div>
          <div class="mini-setting">
            <div>
              <strong>
                卷积脉冲响应 (Convolver)
                <span class="compute-badge"><i class="pi pi-microchip"></i> 高算力消耗</span>
              </strong>
              <span>加载 IR 脉冲文件用于空间音效。当前路径：{{ convolverPathLabel }}</span>
            </div>
            <div class="inline-controls">
              <button class="soft-button compact" type="button" @click="selectImpulseResponse">
                <i class="pi pi-folder-open"></i>
                选择文件
              </button>
              <button
                v-if="audioProcessing.convolverIrPath"
                class="soft-button compact"
                type="button"
                @click="clearImpulseResponse"
              >
                移除文件
              </button>
              <button
                type="button"
                class="toggle-switch"
                :class="{
                  active: audioProcessing.convolverEnabled,
                  inactive: !audioProcessing.convolverEnabled
                }"
                role="switch"
                :aria-checked="audioProcessing.convolverEnabled"
                @click="toggleConvolver"
                aria-label="启用卷积脉冲响应"
              ></button>
            </div>
          </div>
        </div>

        <details class="dsp-module-card settings-advanced-details">
          <summary>格式与频谱（高级）</summary>
          <p class="setting-hint">
            DSD 输出方式与播放设置共用同一选项。频谱分析用于可视化，不会提升音质。
          </p>
          <div class="decode-grid">
            <label>
              <span>DSD 输出方式</span>
              <select
                class="preview-select"
                :value="audioProcessing.dsdOutputMode"
                @change="setDsdOutputMode"
              >
                <option
                  v-for="option in dsdOutputModeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label>
              <span>DSD 采样率策略</span>
              <select
                class="preview-select"
                :value="audioProcessing.dsdRatePolicy"
                @change="setDsdRatePolicy"
              >
                <option
                  v-for="option in dsdRatePolicyOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label>
              <span>SACD 声道版本</span>
              <select
                class="preview-select"
                :value="audioProcessing.sacdProgramMode"
                @change="setSacdProgramMode"
              >
                <option
                  v-for="option in sacdProgramModeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label>
              <span>频谱分析（FFT）</span>
              <div class="mini-highres">
                <select
                  class="preview-select"
                  :value="audioProcessing.fftResolution"
                  :disabled="!audioProcessing.fftEnabled"
                  @change="setFftResolution"
                >
                  <option v-for="option in fftResolutionOptions" :key="option" :value="option">
                    {{ option }}
                  </option>
                </select>
                <button
                  type="button"
                  class="toggle-switch"
                  :class="{
                    active: audioProcessing.fftEnabled,
                    inactive: !audioProcessing.fftEnabled
                  }"
                  role="switch"
                  :aria-checked="audioProcessing.fftEnabled"
                  @click="toggleFftEnabled"
                  aria-label="启用频谱分析"
                ></button>
              </div>
            </label>
            <label class="decode-highres">
              <span>高解析度处理 (High-Res)</span>
              <div class="mini-highres">
                <small>由音源格式和输出设备自动决定，当前没有手动开关。</small>
                <span class="read-only-pill" title="当前版本暂未接入原生处理链">自动</span>
              </div>
            </label>
          </div>
        </details>
      </div>
    </div>

    <div class="dsp-module-card vst3-settings-card" data-testid="settings-vst3-card">
      <h3>VST3 插件 (VST3 Host)</h3>
      <div class="mini-setting">
        <div>
          <strong>启用 VST3 音效插件</strong>
          <span
            >在音效面板中使用已扫描到的 VST3
            插件。需要此版本包含插件运行与扫描组件；不可用时请查看下方状态。</span
          >
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{
            active: vst3Enabled,
            inactive: !vst3Enabled,
            disabled: vst3ToggleUnavailable
          }"
          role="switch"
          data-testid="settings-vst3-toggle"
          :aria-checked="vst3Enabled"
          :aria-disabled="vst3ToggleUnavailable"
          :disabled="vst3ToggleUnavailable"
          @click="toggleVst3Enabled"
          aria-label="启用 VST3 音效插件"
        ></button>
      </div>
      <p v-if="vst3HelpersNotice" class="setting-hint" data-testid="settings-vst3-helpers">
        {{ vst3HelpersNotice }}
      </p>
      <div class="mini-setting top-align">
        <div>
          <strong>搜索目录</strong>
          <span>扫描 VST3 模块的目录列表。修改后需重新扫描才会生效。</span>
        </div>
        <div class="folder-list" data-testid="settings-vst3-paths">
          <div v-for="path in vst3SearchPaths" :key="path" class="folder-chip">
            <span :title="path">{{ path }}</span>
            <i
              class="pi pi-times"
              data-te-interactive
              role="button"
              tabindex="0"
              :aria-label="`移除 VST3 搜索目录 ${path}`"
              @click="removeVst3SearchPath(path)"
              @keydown.enter.prevent="removeVst3SearchPath(path)"
              @keydown.space.prevent="removeVst3SearchPath(path)"
            ></i>
          </div>
          <div v-if="vst3SearchPaths.length === 0" class="folder-empty-hint">
            暂未配置任何搜索目录
          </div>
          <button
            type="button"
            class="dashed-button"
            :disabled="!vst3Catalog || vst3Busy"
            @click="addVst3SearchPath"
          >
            <i class="pi pi-plus"></i>
            添加目录
          </button>
        </div>
      </div>
      <div class="mini-setting">
        <div>
          <strong>插件目录状态</strong>
          <span data-testid="settings-vst3-summary">{{ vst3ScanSummary }}</span>
        </div>
        <button
          class="soft-button compact"
          type="button"
          data-testid="settings-vst3-rescan"
          :disabled="!vst3Enabled || vst3Scanning || !vst3HelpersReady"
          @click="rescanVst3Plugins"
        >
          <i class="pi pi-refresh" :class="{ 'pi-spin': vst3Scanning }"></i>
          {{ vst3Scanning ? '扫描中…' : '重新扫描' }}
        </button>
      </div>
      <p v-if="vst3Error" class="setting-hint" data-testid="settings-vst3-error">
        {{ vst3Error }}
      </p>
    </div>
  </section>
</template>
