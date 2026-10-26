<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import type { DspScene, DspSceneRule } from '../../../../shared/dspGraph.ts'

type ListRule = 'deviceIds' | 'backends' | 'channelLayouts' | 'sourceKinds'
const scene = defineModel<DspScene>({ required: true })
const { audioDeviceOptions, audioOutputOptions } = storeToRefs(useAudioOutputDspStore())
const devices = computed(() => {
  const known = audioDeviceOptions.value.map((item) => ({ value: item.id, label: item.label }))
  for (const id of scene.value.rules.deviceIds ?? [])
    if (!known.some((item) => item.value === id))
      known.push({ value: id, label: `${id}（离线 / 未知）` })
  return known
})
const backends = computed(() =>
  [
    ...new Set([
      ...audioOutputOptions.value.map((item) => item.id),
      ...(scene.value.rules.backends ?? [])
    ])
  ].map((value) => ({ value, label: value }))
)
const groups = computed<
  Array<{ key: ListRule; label: string; hint: string; options: { value: string; label: string }[] }>
>(() => [
  { key: 'deviceIds', label: '输出设备', hint: '不选则不限设备', options: devices.value },
  { key: 'backends', label: '音频后端', hint: '不选则不限后端', options: backends.value },
  {
    key: 'channelLayouts',
    label: '声道布局',
    hint: '按输出声道数匹配',
    options: ['mono', 'stereo', '5.1', '7.1'].map((value) => ({ value, label: value }))
  },
  {
    key: 'sourceKinds',
    label: '音源格式',
    hint: 'PCM 或 DSD 音源',
    options: [
      { value: 'pcm', label: 'PCM' },
      { value: 'dsd', label: 'DSD' }
    ]
  }
])
function selected(key: ListRule, value: string): boolean {
  return ((scene.value.rules[key] as string[] | undefined) ?? []).includes(value)
}
function toggle(key: ListRule, value: string, checked: boolean): void {
  const current = new Set((scene.value.rules[key] as string[] | undefined) ?? [])
  if (checked) current.add(value)
  else current.delete(value)
  const values = [...current]
  if (values.length) scene.value.rules[key] = values as never
  else delete scene.value.rules[key]
}
function setRate(key: 'minSampleRate' | 'maxSampleRate', event: Event): void {
  const input = event.target as HTMLInputElement
  if (!input.value) delete scene.value.rules[key]
  else if (Number.isFinite(input.valueAsNumber))
    scene.value.rules[key] = Math.max(0, input.valueAsNumber)
}
const ruleCount = computed(
  () =>
    (Object.keys(scene.value.rules) as Array<keyof DspSceneRule>).filter((key) => {
      const value = scene.value.rules[key]
      return Array.isArray(value) ? value.length > 0 : value !== undefined
    }).length
)
</script>

<template>
  <section class="scene-settings">
    <header class="pane-heading">
      <div>
        <h2>场景规则</h2>
        <small class="muted">{{
          ruleCount ? `${ruleCount} 项条件需同时满足` : '尚未设置条件 · 匹配任意设备与格式'
        }}</small>
      </div>
    </header>
    <div class="rule-identity">
      <label class="field"
        ><span>场景名称</span><input v-model="scene.name" maxlength="64"
      /></label>
      <label class="field narrow"
        ><span>优先级</span><input v-model.number="scene.priority" type="number" step="1"
      /></label>
      <label class="switch-field rule-enabled"
        ><input v-model="scene.enabled" type="checkbox" /><span
          ><strong>参与自动匹配</strong><small>关闭后仅能通过固定使用启用</small></span
        ></label
      >
    </div>
    <div v-for="group in groups" :key="group.key" class="rule-group">
      <div class="rule-label">
        <strong>{{ group.label }}</strong
        ><small>{{ group.hint }}</small>
      </div>
      <div class="chip-row" role="group" :aria-label="group.label">
        <label v-for="option in group.options" :key="option.value" class="toggle-chip"
          ><input
            type="checkbox"
            :checked="selected(group.key, option.value)"
            @change="toggle(group.key, option.value, ($event.target as HTMLInputElement).checked)"
          /><span :title="option.label">{{ option.label }}</span></label
        >
        <span v-if="!group.options.length" class="muted">暂无可选项</span>
      </div>
    </div>
    <div class="rule-group">
      <div class="rule-label"><strong>采样率范围</strong><small>留空表示不限 · 单位 Hz</small></div>
      <div class="rate-range">
        <label class="field"
          ><span>最低</span
          ><input
            type="number"
            min="0"
            :value="scene.rules.minSampleRate"
            placeholder="不限"
            aria-label="最低采样率 · Hz"
            @change="setRate('minSampleRate', $event)"
        /></label>
        <span class="range-dash" aria-hidden="true">—</span>
        <label class="field"
          ><span>最高</span
          ><input
            type="number"
            min="0"
            :value="scene.rules.maxSampleRate"
            placeholder="不限"
            aria-label="最高采样率 · Hz"
            @change="setRate('maxSampleRate', $event)"
        /></label>
      </div>
    </div>
  </section>
</template>
