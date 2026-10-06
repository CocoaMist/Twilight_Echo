<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import type { AudioDeviceOption } from '@renderer/types/settings'

const props = defineProps<{ audioExclusiveMode: boolean }>()
const emit = defineEmits<{ 'update:audioExclusiveMode': [value: boolean] }>()

const audioStore = useAudioOutputDspStore()
const { audioDevice, audioOutputDeviceOptions, audioOutput, audioOutputOptions, audioProcessing } =
  storeToRefs(audioStore)
const { setAudioDevice, refreshAudioOutputState, setReplayGainMode } = audioStore

// Device picks apply immediately (like library folders on the local step) so
// the user hears the change without waiting for the wizard to finish.
onMounted(() => {
  void refreshAudioOutputState()
})

const exclusiveAvailable = computed(
  () =>
    audioOutputOptions.value.find((option) => option.id === audioOutput.value)?.supportsExclusive ??
    false
)

const loudnessMatched = computed(() => audioProcessing.value.volumeNormalization !== 'off')

function toggleLoudnessMatch(): void {
  void setReplayGainMode(loudnessMatched.value ? 'off' : 'track')
}

function selectDevice(id: string): void {
  if (audioDevice.value === id) return
  void setAudioDevice(id)
}

function deviceIcon(device: AudioDeviceOption): string {
  const text = `${device.id} ${device.label} ${device.backend || ''}`.toLowerCase()
  if (/speaker|soundbar|monitor|音响|音箱|扬声器|喇叭/.test(text)) return 'ph ph-speaker-hifi'
  if (/usb|dac|asio|hifi|exclusive/.test(text)) return 'ph ph-cpu'
  return 'ph ph-headphones'
}

function deviceSpec(device: AudioDeviceOption): string {
  const parts: string[] = []
  if (typeof device.channels === 'number' && device.channels > 0) parts.push(`${device.channels}ch`)
  if (device.sampleRates && device.sampleRates.length > 0) {
    const max = Math.max(...device.sampleRates)
    parts.push(max >= 1000 ? `${(max / 1000).toFixed(max % 1000 === 0 ? 0 : 1)}kHz` : `${max}Hz`)
  }
  if (device.bitDepths && device.bitDepths.length > 0)
    parts.push(`${Math.max(...device.bitDepths)}bit`)
  if (parts.length > 0) return parts.join(' · ')
  if (device.id === 'auto') return '跟随系统默认输出'
  if (device.isDefault) return '系统默认设备'
  return '原生输出设备'
}

function deviceBadges(device: AudioDeviceOption): string[] {
  const badges: string[] = []
  if (device.supportsExclusive) badges.push('独占')
  if (device.nativeDsdSupportState === 'verified' || device.supportsNativeDsd)
    badges.push('Native DSD')
  else if (device.dopSupportState === 'verified' || device.supportsDop) badges.push('DoP')
  return badges
}
</script>

<template>
  <section class="onb-stage" data-scene="06">
    <p class="onb-kicker">声音输出</p>
    <h1 class="onb-title">让声音去<em>对的地方</em></h1>
    <p class="onb-subtitle">
      选择输出设备与模式。独占模式绕过系统混音器，把声卡完全交给音乐，按位精确、无重采样。
    </p>
    <div class="onb-panel onb-device-panel" role="radiogroup" aria-label="输出设备">
      <button
        v-for="device in audioOutputDeviceOptions"
        :key="device.id"
        type="button"
        class="onb-device-row"
        :class="{ 'is-selected': audioDevice === device.id }"
        role="radio"
        :aria-checked="audioDevice === device.id"
        @click="selectDevice(device.id)"
      >
        <i class="onb-device-icon" :class="deviceIcon(device)"></i>
        <span class="onb-device-copy">
          <strong>{{ device.label }}</strong>
          <small>{{ deviceSpec(device) }}</small>
        </span>
        <span v-for="badge in deviceBadges(device)" :key="badge" class="onb-device-badge">
          {{ badge }}
        </span>
        <span v-if="audioDevice === device.id" class="onb-device-check">
          <i class="ph ph-check"></i>
        </span>
      </button>
    </div>
    <div class="onb-cards has-selection" role="radiogroup" aria-label="音频输出模式">
      <button
        type="button"
        class="onb-card is-compact"
        :class="{ 'is-selected': !props.audioExclusiveMode }"
        role="radio"
        :aria-checked="!props.audioExclusiveMode"
        @click="emit('update:audioExclusiveMode', false)"
      >
        <span v-if="!props.audioExclusiveMode" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon ph ph-circles-three-plus"></i>
        <span class="onb-card-title">兼容模式</span>
        <span class="onb-card-desc">与其他应用共享声音输出，省心的默认选择</span>
      </button>
      <button
        type="button"
        class="onb-card is-compact"
        :class="{ 'is-selected': props.audioExclusiveMode }"
        role="radio"
        :aria-checked="props.audioExclusiveMode"
        :disabled="!exclusiveAvailable"
        @click="emit('update:audioExclusiveMode', true)"
      >
        <span v-if="props.audioExclusiveMode" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon ph ph-lightning"></i>
        <span class="onb-card-title">HiFi 独占</span>
        <span class="onb-card-desc">
          {{
            exclusiveAvailable ? 'WASAPI 独占输出，按位精确、无重采样' : '当前输出后端不支持独占'
          }}
        </span>
      </button>
    </div>
    <div class="onb-panel">
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>响度匹配</strong>
          <span>抹平不同专辑之间的音量差异，深夜切歌不再被吓一跳。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': loudnessMatched }"
          role="switch"
          :aria-checked="loudnessMatched"
          aria-label="响度匹配"
          @click="toggleLoudnessMatch"
        ></button>
      </div>
    </div>
    <p class="onb-hint">设备与链路可随时在 设置 → 播放 中调整；DSD、ASIO 等进阶选项也在那里。</p>
  </section>
</template>
