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
  let activeEpoch: string | undefined
  const hasConsumers = computed(() => {
    void consumersRevision.value
    return consumers.size > 0
  })
  const requestedVisualizerBarCount = computed(() => {
    void consumersRevision.value
    return Math.max(0, ...Array.from(consumers.values(), (value) => value.visualizerBarCount ?? 0))
  })
  const needsRawSpectrum = computed(() => {
    void consumersRevision.value
    return Array.from(consumers.values()).some((value) => (value.visualizerBarCount ?? 0) <= 0)
  })
  const options = computed(() => {
    void consumersRevision.value
    const barCount = requestedVisualizerBarCount.value
    return {
      ...visualizationOptions,
      spectrumPoints: Math.max(
        visualizationOptions.spectrumPoints,
        ...Array.from(consumers.values(), (value) => value.spectrumPoints ?? 0)
      ),
      visualizerBarCount: needsRawSpectrum.value ? 0 : barCount,
      spectrogramFrames: Math.max(
        0,
        ...Array.from(consumers.values(), (value) => value.spectrogramFrames ?? 0)
      ),
      oscilloscopePoints: Math.max(
        0,
        ...Array.from(consumers.values(), (value) => value.oscilloscopePoints ?? 0)
      ),
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
    const incoming = event.data ?? createInactiveVisualizationData()
    const barCount = requestedVisualizerBarCount.value
    if (barCount > 0 && !incoming.visualizerBars?.length && incoming.spectrum.length > 0) {
      const rate = incoming.sampleRate > 0 ? incoming.sampleRate : 44100
      const maxFreq = Math.max(20, Math.min(20000, rate / 2))
      const binWidth = rate / Math.max(2, incoming.spectrum.length * 2)
      const maxBin = Math.max(0, incoming.spectrum.length - 1)
      const ratio = maxFreq / 20
      const steps = Math.max(1, barCount - 1)
      const bars = Array.from({ length: barCount }, (_, i) => {
        const freq = 20 * Math.pow(ratio, i / steps)
        const dec = freq / binWidth
        const low = Math.min(Math.floor(dec), maxBin)
        const high = Math.min(low + 1, maxBin)
        const val =
          (incoming.spectrum[low] || 0) +
          ((incoming.spectrum[high] || 0) - (incoming.spectrum[low] || 0)) * (dec - low)
        return Math.max(0, Math.min(1, Number.isFinite(val) ? val : 0))
      })
      data.value = { ...incoming, visualizerBars: bars }
    } else {
      data.value = incoming
    }
    if (event.error) failed(new Error(event.error))
  })
  watch(
    () =>
      [
        core.state.value?.epoch,
        core.status.value?.phase,
        visible.value,
        hasConsumers.value,
        options.value.spectrumPoints,
        options.value.waveformPoints,
        options.value.visualizerBarCount,
        options.value.spectrogramFrames,
        options.value.oscilloscopePoints
      ] as const,
    ([epoch, phase, isVisible, hasActiveConsumers], _previous, cleanup) => {
      if (!epoch || phase !== 'ready' || !isVisible || !hasActiveConsumers) {
        activeEpoch = undefined
        data.value = createInactiveVisualizationData()
        return
      }
      if (epoch !== activeEpoch) {
        activeEpoch = epoch
        data.value = createInactiveVisualizationData()
      }
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
