<script setup lang="ts">
import { fluentIconPaths } from './fluentIconPaths'
defineProps<{ name: keyof typeof fluentIconPaths }>()
</script>
<template>
  <svg
    class="fluent-icon"
    viewBox="0 0 20 20"
    width="20"
    height="20"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(path, index) in fluentIconPaths[name]" :key="index" :d="path" />
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
