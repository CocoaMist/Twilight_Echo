import { computed, onScopeDispose, ref, shallowReadonly, shallowRef, watch, type Ref } from 'vue'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import {
  createInactiveVisualizationData,
  visualizationOptions,
  type VisualizationConsumerOptions
} from './useVisualizationPolling.ts'

export function createCorePlayerVisualization(
  core: CorePlayerClient,
  failed: (error: unknown) => void,
  visible: Readonly<Ref<boolean>>,
  newId: () => string = () => crypto.randomUUID()
) {
  const data = shallowRef(createInactiveVisualizationData())
  const consumers = new Map<string, VisualizationConsumerOptions>()
  const consumersRevision = ref(0)
  const visualizerActive = ref(false)
  let active: { id: string; epoch: string; sequence: number } | null = null
  const options = computed(() => {
    void consumersRevision.value
    return {
      ...visualizationOptions,
      spectrumPoints: Math.max(
        visualizationOptions.spectrumPoints,
        ...Array.from(consumers.values(), (value) => value.spectrumPoints ?? 0)
      ),
      visualizerBarCount: Math.max(0, ...Array.from(consumers.values(), value => value.visualizerBarCount ?? 0)),
      spectrogramFrames: Math.max(0, ...Array.from(consumers.values(), value => value.spectrogramFrames ?? 0)),
      oscilloscopePoints: Math.max(0, ...Array.from(consumers.values(), value => value.oscilloscopePoints ?? 0)),
      waveformPoints: Math.max(
        visualizationOptions.waveformPoints,
        ...Array.from(consumers.values(), (value) => value.waveformPoints ?? 0)
      )
    }
  })
  const unsubscribe = core.subscribe((event) => {
    if (
      event.kind !== 'visualization' ||
      !active ||
      event.epoch !== active.epoch ||
      event.subscriptionId !== active.id ||
      event.sequence <= active.sequence
    )
      return
    active.sequence = event.sequence
    data.value = event.data ?? createInactiveVisualizationData()
    if (event.error) failed(new Error(event.error))
  })
  watch(
    () =>
      [
        core.state.value?.epoch,
        core.status.value?.phase,
        visible.value,
        consumersRevision.value,
        options.value.spectrumPoints,
        options.value.waveformPoints
      ] as const,
    ([epoch, phase, isVisible], _previous, cleanup) => {
      data.value = createInactiveVisualizationData()
      if (!epoch || phase !== 'ready' || !isVisible || consumers.size === 0) return
      const subscription = { id: newId(), epoch, sequence: 0 }
      active = subscription
      let disposed = false
      const subscribed = core.command('visualization.subscribe', {
        subscriptionId: subscription.id,
        options: options.value
      })
      void subscribed.catch((error) => {
        if (!disposed) failed(error)
      })
      cleanup(() => {
        disposed = true
        if (active === subscription) active = null
        // Wait for the accepted subscription before removing it; never reissue a failed subscribe.
        void subscribed
          .then(async () => {
            if (core.state.value?.epoch === epoch && core.status.value?.phase === 'ready')
              await core.command('visualization.unsubscribe', { subscriptionId: subscription.id })
          })
          .catch(() => {})
      })
    },
    { immediate: true }
  )
  onScopeDispose(unsubscribe)
  return {
    visualizerActive,
    visualizationData: shallowReadonly(data),
    acquireVisualizationConsumer: (request: VisualizationConsumerOptions = {}) => {
      const id = newId()
      consumers.set(id, request)
      consumersRevision.value++
      return () => {
        if (consumers.delete(id)) consumersRevision.value++
      }
    }
  }
}
