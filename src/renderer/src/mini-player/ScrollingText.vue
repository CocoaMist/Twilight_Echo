<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  text: string
}>()

const rootRef = ref<HTMLElement | null>(null)
const itemRef = ref<HTMLElement | null>(null)
const overflowing = ref(false)
const contentWidth = ref(0)

// Travel speed stays constant whatever the length; each loop also rests at the
// start (the first 40% of the keyframes) so the title mostly reads as still text.
const SCROLL_PX_PER_SECOND = 32
const ITEM_GAP_PX = 48
const durationSeconds = computed(() => {
  if (!overflowing.value || contentWidth.value <= 0) return 10
  const travel = Math.min(
    24,
    Math.max(6, (contentWidth.value + ITEM_GAP_PX) / SCROLL_PX_PER_SECOND)
  )
  return Math.round((travel / 0.6) * 10) / 10
})

// Measure the first copy alone: once scrolling, the inner row holds two copies
// and would read as overflowing forever, even after the window grows.
function measure(): void {
  const root = rootRef.value
  const item = itemRef.value
  if (!root || !item) {
    overflowing.value = false
    return
  }
  const textWidth = item.offsetWidth - (overflowing.value ? ITEM_GAP_PX : 0)
  const nextOverflowing = textWidth > root.clientWidth + 1
  overflowing.value = nextOverflowing
  contentWidth.value = nextOverflowing ? textWidth : 0
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measure)
    if (rootRef.value) resizeObserver.observe(rootRef.value)
  } else {
    window.addEventListener('resize', measure)
  }
})

watch(
  () => props.text,
  () => {
    requestAnimationFrame(measure)
  }
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <span
    ref="rootRef"
    class="te-scroll-text"
    :class="{ 'is-overflowing': overflowing }"
    :style="{ '--te-scroll-duration': `${durationSeconds}s` }"
  >
    <span class="te-scroll-text-inner">
      <span ref="itemRef" class="te-scroll-text-item">{{ text }}</span>
      <span v-if="overflowing" class="te-scroll-text-item" aria-hidden="true">{{ text }}</span>
    </span>
  </span>
</template>

<style scoped>
@property --te-scroll-fade-start {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

.te-scroll-text {
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.te-scroll-text-inner {
  display: inline-flex;
  min-width: 100%;
  white-space: nowrap;
  will-change: transform;
}

.te-scroll-text-item {
  display: inline-block;
  white-space: nowrap;
}

.te-scroll-text.is-overflowing .te-scroll-text-item {
  padding-right: 48px;
}

/* Soft edges instead of glyphs sliced by the clip: the trailing edge always
   fades, the leading edge only while the text is travelling. */
.te-scroll-text.is-overflowing {
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent,
    currentColor var(--te-scroll-fade-start),
    currentColor calc(100% - 18px),
    transparent
  );
  mask-image: linear-gradient(
    90deg,
    transparent,
    currentColor var(--te-scroll-fade-start),
    currentColor calc(100% - 18px),
    transparent
  );
  animation-name: te-scroll-text-edge;
  animation-duration: var(--te-scroll-duration, 10s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

.te-scroll-text.is-overflowing .te-scroll-text-inner {
  /* Longhand form only: Vue's scoped-style keyframe rewriting cannot parse a
     CSS variable inside the `animation` shorthand and would drop every
     longhand, so the marquee never runs. */
  animation-name: te-scroll-text-loop;
  animation-duration: var(--te-scroll-duration, 10s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

/* translateX(-50%) lands the second copy exactly where the first began, so the
   loop restarts on the resting frame. */
@keyframes te-scroll-text-loop {
  0%,
  40% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-50%);
  }
}

@keyframes te-scroll-text-edge {
  0%,
  40% {
    --te-scroll-fade-start: 0px;
  }
  44%,
  95% {
    --te-scroll-fade-start: 16px;
  }
  100% {
    --te-scroll-fade-start: 0px;
  }
}

/* The marquee carries information: a long title is unreadable when truncated,
   so the mini window's text keeps scrolling in the reduced tier — just slower.
   See docs/ui-playback-refactor-audit.md:696 for why the component's own
   prefers-reduced-motion disable rule was removed. */
:global(html[data-te-motion='reduced'] .te-scroll-text.is-overflowing) {
  animation-name: te-scroll-text-edge !important;
  animation-duration: calc(var(--te-scroll-duration, 10s) * 2) !important;
  animation-timing-function: linear !important;
  animation-iteration-count: infinite !important;
}

:global(html[data-te-motion='reduced'] .te-scroll-text.is-overflowing .te-scroll-text-inner) {
  animation-name: te-scroll-text-loop !important;
  animation-duration: calc(var(--te-scroll-duration, 10s) * 2) !important;
  animation-timing-function: linear !important;
  animation-iteration-count: infinite !important;
}
</style>
