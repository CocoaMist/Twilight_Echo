<script setup lang="ts">
const icons = {
  volume: 'speaker-high',
  muted: 'speaker-slash',
  queue: 'list-bullets',
  hifi: 'faders',
  equalizer: 'sliders',
  miniPlayer: 'picture-in-picture',
  favorite: 'heart',
  previous: 'skip-back',
  next: 'skip-forward',
  play: 'play',
  pause: 'pause',
  sequential: 'list-numbers',
  listLoop: 'repeat',
  repeat: 'repeat-once',
  heart: 'heart',
  shuffle: 'shuffle'
} as const

defineProps<{ name: keyof typeof icons; filled?: boolean }>()
</script>

<template>
  <i
    class="player-control-icon"
    :class="[filled ? 'ph-fill' : 'ph', `ph-${icons[name]}`]"
    aria-hidden="true"
  ></i>
</template>

<style scoped>
.player-control-icon {
  width: 1em;
  height: 1em;
  display: block;
  flex-shrink: 0;
}
</style>
