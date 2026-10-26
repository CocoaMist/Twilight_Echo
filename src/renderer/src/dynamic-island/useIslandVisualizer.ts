import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { VisualizationOptions } from '../../../shared/audioEngineTypes.ts'
import type { CorePlayerClient } from '../stores/player/corePlayerTypes.ts'

export const VISUALIZER_BAR_COUNT = 6
const VISUALIZER_OPTIONS: VisualizationOptions = {
  spectrumPoints: 256,
  waveformPoints: 16,
  spectrogramFrames: 0,
  oscilloscopePoints: 0,
  visualizerBarCount: VISUALIZER_BAR_COUNT
}

/** The island consumes the Core tap only while its visualizer is visible. */
export function useIslandVisualizer(enabled: Ref<boolean>, core: CorePlayerClient) {
  const bars = ref<number[]>(Array.from({ length: VISUALIZER_BAR_COUNT }, () => 0))
  const visible = ref(document.visibilityState !== 'hidden')
  const energy = computed(() =>
    Math.min(
      1,
      Math.sqrt(bars.value.reduce((total, value) => total + value * value, 0) / bars.value.length)
    )
  )
  let active: { id: string; epoch: string; sequence: number } | null = null
  function setBars(values: readonly number[] = []): void {
    bars.value = Array.from({ length: VISUALIZER_BAR_COUNT }, (_, index) => {
      const value = values[index]
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
    })
  }
  const removeMessage = core.subscribe((event) => {
    if (
      event.kind !== 'visualization' ||
      !active ||
      event.epoch !== active.epoch ||
      event.subscriptionId !== active.id ||
      event.sequence <= active.sequence
    )
      return
    active.sequence = event.sequence
    const frame = event.data
    setBars(frame?.active && frame.tapStatus === 'active' ? frame.visualizerBars : [])
  })
  watch(
    () =>
      [enabled.value, visible.value, core.state.value?.epoch, core.status.value?.phase] as const,
    ([enabled, visible, epoch, phase], _previous, cleanup) => {
      setBars()
      if (!enabled || !visible || !epoch || phase !== 'ready') return
      const subscription = { id: crypto.randomUUID(), epoch, sequence: 0 }
      active = subscription
      const accepted = core.command('visualization.subscribe', {
        subscriptionId: subscription.id,
        options: VISUALIZER_OPTIONS
      })
      void accepted.catch((error) => console.error('[island.visualization]', error))
      cleanup(() => {
        if (active === subscription) active = null
        void accepted
          .then(async () => {
            if (core.state.value?.epoch === epoch && core.status.value?.phase === 'ready')
              await core.command('visualization.unsubscribe', { subscriptionId: subscription.id })
          })
          .catch(() => {})
      })
    },
    { immediate: true }
  )
  const visibilityChanged = () => {
    visible.value = document.visibilityState !== 'hidden'
  }
  onMounted(() => {
    document.addEventListener('visibilitychange', visibilityChanged)
    void core.attach().catch((error) => console.error('[island.core]', error))
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', visibilityChanged)
    removeMessage()
  })
  function barStyle(index: number): Record<'--visualizer-level' | '--visualizer-opacity', string> {
    const level = Math.pow(bars.value[index] ?? 0, 0.58)
    return {
      '--visualizer-level': level.toFixed(3),
      '--visualizer-opacity': (0.24 + level * 0.76).toFixed(3)
    }
  }
  return { energy, barStyle }
}
