<script setup lang="ts">
import PlayerControlIcon from '@renderer/components/player-bar/PlayerControlIcon.vue'

defineProps<{
  name: 'play' | 'pause' | 'previous' | 'next'
}>()
</script>

<template>
  <PlayerControlIcon class="mini-glyph" :name="name" filled />
</template>

<style scoped>
.mini-glyph {
  display: block;
  width: 1em;
  height: 1em;
  flex-shrink: 0;
}
</style>
