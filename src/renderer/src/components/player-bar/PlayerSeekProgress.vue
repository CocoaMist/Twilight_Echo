<script setup lang="ts">
import { computed } from 'vue'
import { useSeekGesture } from './useSeekGesture'
import SmoothedProgressFill from '../SmoothedProgressFill.vue'

const props = withDefaults(
  defineProps<{
    position: number
    duration: number
    live: boolean
    abStart: number | null
    abEnd: number | null
    formatTime: (seconds: number) => string
    variant?: 'default' | 'mini' | 'compact'
  }>(),
  { variant: 'default' }
)
const emit = defineEmits<{ seek: [seconds: number] }>()
const disabled = computed(
  () => props.live || !Number.isFinite(props.duration) || props.duration <= 0
)
const {
  preview,
  keyboardFocus,
  onInput,
  startPointer,
  endPointer,
  commit,
  cancel,
  onFocus,
  onBlur
} = useSeekGesture({
  duration: () => props.duration,
  disabled: () => disabled.value,
  identity: () => props.variant,
  commit: (seconds) => emit('seek', seconds)
})
const position = computed(() => preview.value ?? props.position)
const percent = computed(() =>
  props.live
    ? 100
    : props.duration > 0
      ? Math.min(100, Math.max(0, (position.value / props.duration) * 100))
      : 0
)
const loopStyle = computed(() => {
  const total = props.duration || 1
  const start = Math.min(total, Math.max(0, props.abStart ?? 0))
  const end = Math.min(total, Math.max(start, props.abEnd ?? start))
  return { left: `${(start / total) * 100}%`, width: `${((end - start) / total) * 100}%` }
})
</script>

<template>
  <div
    class="player-seek-progress"
    :style="{
      '--te-progress-time-characters': live ? 4 : Math.max(4, formatTime(duration).length)
    }"
    :class="[
      variant === 'default' ? 'progress-area' : `${variant}-progress-rail`,
      { 'is-scrubbing': preview !== null, 'is-keyboard-focus': keyboardFocus }
    ]"
  >
    <span v-if="variant === 'default'" class="time-label">{{
      live ? 'LIVE' : formatTime(position)
    }}</span>
    <div
      :class="[
        variant === 'default' ? 'progress-slider-wrap' : `${variant}-progress-slider-wrap`,
        { 'is-disabled': disabled }
      ]"
    >
      <div
        :class="variant === 'default' ? 'progress-track' : `${variant}-progress-track`"
        aria-hidden="true"
      >
        <div
          v-if="preview !== null"
          :class="variant === 'default' ? 'progress-fill' : `${variant}-progress-fill`"
          :style="{ transform: `scaleX(${percent / 100})` }"
        ></div>
        <SmoothedProgressFill
          v-else
          :class="[variant === 'default' ? 'progress-fill' : `${variant}-progress-fill`, { live }]"
          :percent="percent"
        />
      </div>
      <div
        v-if="abStart != null && abEnd != null && duration > 0 && !live"
        class="ab-loop-range"
        :style="loopStyle"
        aria-hidden="true"
      ></div>
      <input
        type="range"
        :class="[
          variant === 'default' ? 'progress-slider' : `${variant}-progress-slider`,
          { live }
        ]"
        :value="live ? 0 : position"
        min="0"
        :max="duration || 1"
        step="0.1"
        :disabled="disabled"
        aria-label="播放进度"
        :aria-valuetext="live ? 'LIVE' : `${formatTime(position)} / ${formatTime(duration)}`"
        @pointerdown.stop="startPointer"
        @pointermove.stop
        @pointerup="endPointer"
        @input="onInput"
        @change="commit"
        @pointercancel="cancel"
        @focus="onFocus"
        @keydown="keyboardFocus = true"
        @blur="onBlur"
      />
    </div>
    <span v-if="variant === 'default'" class="time-label">{{
      live ? 'LIVE' : formatTime(duration)
    }}</span>
    <span v-else-if="variant === 'mini'" class="mini-progress-time" aria-hidden="true">
      {{ live ? 'LIVE' : `${formatTime(position)} / ${formatTime(duration)}` }}
    </span>
  </div>
</template>
