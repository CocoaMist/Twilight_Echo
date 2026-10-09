<script setup lang="ts">
import SettingsDisclosure from './SettingsDisclosure.vue'
import { useSettingsDisclosure } from './settingsDisclosureRegistry.ts'

const props = withDefaults(
  defineProps<{
    id: string
    title: string
    summary?: string
    attention?: string
    initiallyOpen?: boolean
  }>(),
  { summary: '', attention: '', initiallyOpen: false }
)
const open = useSettingsDisclosure(props.id, props.initiallyOpen)
</script>

<template>
  <div :id="id" class="settings-group section-block" :class="{ 'has-attention': attention }">
    <button
      type="button"
      class="settings-group-trigger"
      :aria-expanded="open"
      :aria-controls="`${id}-content`"
      @click="open = !open"
    >
      <span class="settings-group-copy">
        <span class="settings-group-title">{{ title }}</span>
        <span v-if="summary" class="settings-group-summary">{{ summary }}</span>
        <span v-if="attention" class="settings-group-attention" role="status">{{ attention }}</span>
      </span>
      <i class="pi pi-chevron-down" :class="{ rotated: open }" aria-hidden="true" />
    </button>
    <SettingsDisclosure
      :id="`${id}-content`"
      :open="open"
      keep-mounted
      class="settings-group-content"
    >
      <slot />
    </SettingsDisclosure>
  </div>
</template>
