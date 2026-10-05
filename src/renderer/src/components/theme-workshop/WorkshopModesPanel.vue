<script setup lang="ts">
import { computed } from 'vue'
import {
  THEME_MODE_DEFINITIONS,
  resolveThemeModes,
  type ThemeModes
} from '../../../../shared/theme.ts'
import { WORKSHOP_LAYOUTS } from '../../../../shared/themeWorkshopLayouts.ts'
import { copyWorkshopDraft, type WorkshopProject } from '../../../../shared/themeWorkshop.ts'
import { studioModeLabels } from '@renderer/components/theme-studio/themeVisualControls'
const props = defineProps<{ project: WorkshopProject; busy?: boolean; domain?: string }>()
const emit = defineEmits<{ change: [project: WorkshopProject] }>()
const selectedLayout = computed(() =>
  props.project.layout === null
    ? 'default'
    : props.project.layout === undefined
      ? ''
      : (WORKSHOP_LAYOUTS.find(
          (preset) => JSON.stringify(preset.layout) === JSON.stringify(props.project.layout)
        )?.id ?? 'custom')
)
const modes = computed(() =>
  THEME_MODE_DEFINITIONS.filter((mode) => !props.domain || mode.id.startsWith(props.domain + '.'))
)
function read(id: string): string {
  const base = props.project.base.structured
  const resolved = resolveThemeModes(
    props.project.modes ?? (base && base.schemaVersion !== 1 ? base.modes : undefined)
  )
  const [domain, key] = id.split('.')
  return String((resolved[domain as keyof ThemeModes] as Record<string, unknown>)?.[key] ?? '')
}
function set(id: string, value: string): void {
  const next = copyWorkshopDraft(props.project)
  const base = next.base.structured
  next.modes ??= JSON.parse(
    JSON.stringify(base && base.schemaVersion !== 1 ? (base.modes ?? {}) : {})
  )
  const [domain, key] = id.split('.')
  Object.assign(next.modes!, {
    [domain]: { ...next.modes![domain as keyof ThemeModes], [key]: value }
  })
  emit('change', next)
}
function layout(id: string): void {
  const next = copyWorkshopDraft(props.project)
  next.layout =
    WORKSHOP_LAYOUTS.find((preset) => preset.id === id)?.layout ??
    (id === 'default' ? null : undefined)
  emit('change', next)
}
function reset(): void {
  const next = copyWorkshopDraft(props.project)
  if (props.domain) {
    const base = next.base.structured
    const modes = base && base.schemaVersion !== 1 ? base.modes : undefined
    if (next.modes)
      Object.assign(next.modes, { [props.domain]: modes?.[props.domain as keyof ThemeModes] })
  } else {
    next.modes = undefined
    next.layout = undefined
  }
  emit('change', next)
}
</script>
<template>
  <template v-if="!domain"
    ><label
      >窗口布局<select
        :disabled="busy"
        :value="selectedLayout"
        @change="layout(($event.target as HTMLSelectElement).value)"
      >
        <option value="">继承来源</option>
        <option v-if="selectedLayout === 'custom'" value="custom" disabled>自定义布局</option>
        <option value="default">默认布局</option>
        <option v-for="preset in WORKSHOP_LAYOUTS" :key="preset.id" :value="preset.id">
          {{ preset.name }}
        </option>
      </select></label
    >
  </template>
  <label v-for="mode in modes" :key="mode.id" :data-workshop-mode="mode.id" tabindex="-1"
    >{{ studioModeLabels[mode.id] ?? mode.label
    }}<select
      :disabled="busy"
      :value="read(mode.id)"
      @change="set(mode.id, ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in mode.options" :key="option" :value="option">{{ option }}</option>
    </select></label
  >
  <button :disabled="busy" @click="reset">恢复来源{{ domain ? '组件模式' : '布局与模式' }}</button>
</template>
