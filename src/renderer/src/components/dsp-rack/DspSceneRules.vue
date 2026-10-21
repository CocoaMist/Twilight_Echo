<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import type { DspScene, DspSceneRule } from '../../../../shared/dspGraph.ts'

const scene = defineModel<DspScene>({ required: true })
const { audioDeviceOptions, audioOutputOptions } = storeToRefs(useAudioOutputDspStore())
const devices = computed(() => {
  const known = audioDeviceOptions.value.map((item) => ({ value: item.id, label: item.label }))
  for (const id of scene.value.rules.deviceIds ?? [])
    if (!known.some((item) => item.value === id))
      known.push({ value: id, label: `${id}（离线 / 未知）` })
  return known
})
const backends = computed(() => [
  ...new Set([
    ...audioOutputOptions.value.map((item) => item.id),
    ...(scene.value.rules.backends ?? [])
  ])
])
function setList(key: keyof DspSceneRule, event: Event): void {
  const values = [...(event.target as HTMLSelectElement).selectedOptions].map((item) => item.value)
  if (values.length) scene.value.rules[key] = values as never
  else delete scene.value.rules[key]
}
function setRate(key: 'minSampleRate' | 'maxSampleRate', event: Event): void {
  const input = event.target as HTMLInputElement
  if (!input.value) delete scene.value.rules[key]
  else if (Number.isFinite(input.valueAsNumber))
    scene.value.rules[key] = Math.max(0, input.valueAsNumber)
}
</script>

<template>
  <section class="scene-settings">
    <header class="pane-heading">
      <h2>场景设置</h2>
      <span class="muted">自动匹配 · 所有条件同时满足</span>
    </header>
    <div class="settings-grid">
      <label>名称<input v-model="scene.name" maxlength="64" /></label>
      <label>优先级<input v-model.number="scene.priority" type="number" step="1" /></label>
      <label class="switch-field"><input v-model="scene.enabled" type="checkbox" />参与匹配</label>
      <label
        >设备 <small>不选则不限；Ctrl / ⌘ 多选</small>
        <select
          multiple
          :value="scene.rules.deviceIds ?? []"
          @change="setList('deviceIds', $event)"
        >
          <option v-for="device in devices" :key="device.value" :value="device.value">
            {{ device.label }}
          </option>
        </select>
      </label>
      <label
        >音频后端
        <select multiple :value="scene.rules.backends ?? []" @change="setList('backends', $event)">
          <option v-for="backend in backends" :key="backend" :value="backend">{{ backend }}</option>
        </select>
      </label>
      <label
        >声道布局
        <select
          multiple
          :value="scene.rules.channelLayouts ?? []"
          @change="setList('channelLayouts', $event)"
        >
          <option v-for="layout in ['mono', 'stereo', '5.1', '7.1']" :key="layout">
            {{ layout }}
          </option>
        </select>
      </label>
      <label
        >源格式
        <select
          multiple
          :value="scene.rules.sourceKinds ?? []"
          @change="setList('sourceKinds', $event)"
        >
          <option value="pcm">PCM</option>
          <option value="dsd">DSD</option>
        </select>
      </label>
      <label
        >最低采样率 · Hz<input
          type="number"
          min="0"
          :value="scene.rules.minSampleRate"
          placeholder="不限"
          @change="setRate('minSampleRate', $event)"
      /></label>
      <label
        >最高采样率 · Hz<input
          type="number"
          min="0"
          :value="scene.rules.maxSampleRate"
          placeholder="不限"
          @change="setRate('maxSampleRate', $event)"
      /></label>
    </div>
  </section>
</template>
