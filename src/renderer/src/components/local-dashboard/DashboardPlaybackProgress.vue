<script setup lang="ts">
import { computed } from 'vue'
import { usePlayerStore } from '../../stores/usePlayerStore'
import SmoothedProgressFill from '../SmoothedProgressFill.vue'

// Keep playback ticks out of the dashboard's large render tree.
const { currentTime, duration, progress, seek, formatTime } = usePlayerStore()
const heroProgressPercent = computed(() => Math.min(100, Math.max(0, progress.value)))

function handleHeroSeek(event: MouseEvent): void {
  if (duration.value <= 0) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  seek(duration.value * ratio)
}
</script>

<template>
  <div class="hero-progress">
    <button
      class="hero-progress-track"
      title="点击跳转播放进度"
      aria-label="播放进度"
      @click="handleHeroSeek"
    >
      <SmoothedProgressFill as="span" :percent="heroProgressPercent" />
    </button>
    <div class="hero-time">
      <span>{{ formatTime(currentTime) }}</span>
      <span>{{ formatTime(duration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.hero-progress {
  width: min(100%, 460px);
  margin-top: 22px;
}

.hero-progress-track {
  position: relative;
  display: block;
  width: 100%;
  height: 14px;
  padding: 5px 0;
  border: none;
  border-radius: 999px;
  overflow: hidden;
  background: transparent;
  cursor: pointer;
}

.hero-progress-track::before {
  content: '';
  position: absolute;
  inset: 5px 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--home-ink) 12%, transparent);
}

.hero-progress-track span {
  position: absolute;
  inset: 5px auto 5px 0;
  width: 100%;
  background: linear-gradient(90deg, var(--home-accent), var(--te-accent-cyan));
  transform: scaleX(0);
  transform-origin: 0 50%;
  will-change: transform;
  transition: none;
}

.hero-progress-track:hover::before {
  inset: 4px 0;
}

.hero-time {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: calc(var(--te-font-size-body, 14px) * 11.5 / 14);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--home-muted);
}
</style>
