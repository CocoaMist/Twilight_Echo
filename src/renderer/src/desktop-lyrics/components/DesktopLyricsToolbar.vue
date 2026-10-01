<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEscapeToClose } from '../../app/useDismissLayer'
import { getTabDestination } from '../../app/tabNavigation'
import type {
  DesktopLyricsPalette,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction
} from '../../../../shared/desktopLyrics.ts'

defineProps<{ settings: DesktopLyricsSettingsV3; playing: boolean }>()
const emit = defineEmits<{
  transport: [action: DesktopLyricsTransportAction]
  patch: [patch: Partial<DesktopLyricsSettingsV3>]
  lock: []
  close: []
}>()
const paletteOpen = ref(false)
const paletteAnchor = ref<HTMLElement | null>(null)
const paletteTrigger = ref<HTMLButtonElement | null>(null)
function closePalette(restoreFocus = true): void {
  paletteOpen.value = false
  if (restoreFocus) paletteTrigger.value?.focus()
}
useEscapeToClose(paletteOpen, () => closePalette())
watch(paletteOpen, async (open) => {
  if (!open) return
  await nextTick()
  const menu = paletteAnchor.value?.querySelector('.dl-palette-menu:not(.dl-popover-leave-active)')
  const current = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
  const first = menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
  ;(current ?? first)?.focus()
})
function onOutsidePointer(event: PointerEvent): void {
  if (
    paletteOpen.value &&
    event.target instanceof Node &&
    !paletteAnchor.value?.contains(event.target)
  )
    closePalette(false)
}
function onPaletteFocusOut(event: FocusEvent): void {
  if (
    paletteOpen.value &&
    event.relatedTarget instanceof Node &&
    !paletteAnchor.value?.contains(event.relatedTarget)
  )
    closePalette(false)
}
function onDocumentFocusIn(event: FocusEvent): void {
  if (
    paletteOpen.value &&
    event.target instanceof Node &&
    !paletteAnchor.value?.contains(event.target)
  )
    closePalette(false)
}
function onPaletteKeydown(event: KeyboardEvent): void {
  const options = Array.from(
    paletteAnchor.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []
  )
  const index = options.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  const destination = getTabDestination(event.key, index, options.length, true)
  if (destination === null) return
  event.preventDefault()
  event.stopPropagation()
  options[destination].focus()
}
onMounted(() => {
  document.addEventListener('pointerdown', onOutsidePointer, true)
  document.addEventListener('focusin', onDocumentFocusIn, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  document.removeEventListener('focusin', onDocumentFocusIn, true)
})
const palettes: Array<{ id: DesktopLyricsPalette; label: string; color: string }> = [
  { id: 'accent', label: '封面强调色', color: 'var(--dl-accent)' },
  { id: 'sunset', label: '落日晖', color: '#f3a6a6' },
  { id: 'twilight', label: 'Twilight', color: '#7aa2ff' },
  { id: 'warm', label: '暖白', color: '#ffd27a' },
  { id: 'custom', label: '自定义', color: 'var(--dl-custom)' }
]

function resize(fontSize: number): void {
  emit('patch', { fontSize: Math.min(64, Math.max(20, fontSize)) })
}

function selectPalette(palette: DesktopLyricsPalette): void {
  emit('patch', { palette })
  closePalette()
}
</script>

<template>
  <div class="dl-toolbar" data-dl-interactive>
    <button type="button" title="上一首" aria-label="上一首" @click="emit('transport', 'previous')">
      <i aria-hidden="true" class="ph ph-skip-back"></i>
    </button>
    <button
      type="button"
      :title="playing ? '暂停' : '播放'"
      :aria-label="playing ? '暂停' : '播放'"
      @click="emit('transport', 'playPause')"
    >
      <i aria-hidden="true" :class="playing ? 'ph ph-pause' : 'ph ph-play'"></i>
    </button>
    <button type="button" title="下一首" aria-label="下一首" @click="emit('transport', 'next')">
      <i aria-hidden="true" class="ph ph-skip-forward"></i>
    </button>
    <span class="dl-toolbar-divider"></span>
    <button
      type="button"
      title="减小字号"
      aria-label="减小字号"
      @click="resize(settings.fontSize - 2)"
    >
      A−
    </button>
    <button
      type="button"
      title="增大字号"
      aria-label="增大字号"
      @click="resize(settings.fontSize + 2)"
    >
      A+
    </button>
    <div
      ref="paletteAnchor"
      class="dl-palette-anchor"
      @focusout="onPaletteFocusOut"
      @keydown="onPaletteKeydown"
    >
      <button
        ref="paletteTrigger"
        type="button"
        title="歌词配色"
        aria-label="歌词配色"
        aria-haspopup="menu"
        :aria-expanded="paletteOpen"
        @click="paletteOpen = !paletteOpen"
      >
        <i aria-hidden="true" class="ph ph-palette"></i>
      </button>
      <Transition name="dl-popover">
        <div v-if="paletteOpen" class="dl-palette-menu" role="menu" aria-label="歌词配色">
          <button
            :aria-label="palette.label"
            v-for="palette in palettes"
            :key="palette.id"
            type="button"
            role="menuitemradio"
            :aria-checked="settings.palette === palette.id"
            :class="{ 'is-selected': settings.palette === palette.id }"
            :title="palette.label"
            @click="selectPalette(palette.id)"
          >
            <span class="dl-swatch" :style="{ background: palette.color }"></span>
            {{ palette.label }}
          </button>
        </div>
      </Transition>
    </div>
    <button
      type="button"
      title="显示翻译"
      aria-label="显示翻译"
      :aria-pressed="settings.translationVisible"
      :class="{ 'is-selected': settings.translationVisible }"
      @click="emit('patch', { translationVisible: !settings.translationVisible })"
    >
      译
    </button>
    <button type="button" title="锁定桌面歌词" aria-label="锁定桌面歌词" @click="emit('lock')">
      <i aria-hidden="true" class="ph ph-lock"></i>
    </button>
    <button
      class="is-close"
      type="button"
      title="关闭桌面歌词"
      aria-label="关闭桌面歌词"
      @click="emit('close')"
    >
      <i aria-hidden="true" class="ph ph-x"></i>
    </button>
  </div>
</template>
