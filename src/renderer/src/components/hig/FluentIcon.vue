<script setup lang="ts">
import { computed } from 'vue'
import { fluentIconPaths } from './fluentIconPaths'
import { fluentCompactIconPaths } from './fluentCompactIconPaths'
const props = defineProps<{ name: keyof typeof fluentIconPaths; size?: 16 | 20 }>()
const compact: Partial<Record<keyof typeof fluentIconPaths, readonly string[]>> =
  fluentCompactIconPaths
const nativeSize = computed(() => (props.size === 16 && compact[props.name] ? 16 : 20))
const paths = computed(() =>
  nativeSize.value === 16 ? compact[props.name]! : fluentIconPaths[props.name]
)
</script>
<template>
  <svg
    class="fluent-icon"
    :viewBox="`0 0 ${nativeSize} ${nativeSize}`"
    :width="size ?? 20"
    :height="size ?? 20"
    :style="size ? { '--hig-icon-size': `${size}px` } : undefined"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(path, index) in paths" :key="index" :d="path" />
  </svg>
</template>
<style scoped>
.fluent-icon {
  display: inline-block;
  flex: 0 0 auto;
  width: var(--hig-icon-size, 20px);
  height: var(--hig-icon-size, 20px);
  vertical-align: middle;
}
</style>
