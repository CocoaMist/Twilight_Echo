<script setup lang="ts">
defineProps<{
  name: 'play' | 'pause' | 'previous' | 'next'
}>()
</script>

<template>
  <svg class="mini-glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path
      v-if="name === 'play'"
      d="M8.2 4.9v14.2c0 .86.94 1.4 1.68.95l11.2-7.1a1.12 1.12 0 0 0 0-1.9L9.88 3.95c-.74-.46-1.68.08-1.68.95Z"
    />
    <template v-else-if="name === 'pause'">
      <rect x="5.6" y="4.4" width="4.4" height="15.2" rx="1.5" />
      <rect x="14" y="4.4" width="4.4" height="15.2" rx="1.5" />
    </template>
    <g v-else :transform="name === 'previous' ? 'translate(24 0) scale(-1 1)' : undefined">
      <path
        d="M4.6 6.1v11.8c0 .78.86 1.26 1.52.84l8.95-5.9a1 1 0 0 0 0-1.68L6.12 5.26c-.66-.42-1.52.06-1.52.84Z"
      />
      <rect x="16.8" y="5.2" width="2.6" height="13.6" rx="1.3" />
    </g>
  </svg>
</template>

<style scoped>
.mini-glyph {
  display: block;
  width: 1em;
  height: 1em;
  flex-shrink: 0;
}
</style>
