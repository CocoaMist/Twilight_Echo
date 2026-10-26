import { computed, onScopeDispose, shallowReadonly, shallowRef, watch } from 'vue'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import type { PlaybackClockSnapshot } from '../../utils/playbackSessionClock.ts'

export interface CorePlayerClockOptions {
  now?: () => number
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
}

/** Presentation clock only. Every anchor comes from Core; no transport recovery runs here. */
export function createCorePlayerClock(
  core: CorePlayerClient,
  options: CorePlayerClockOptions = {}
) {
  const now = options.now ?? (() => performance.now())
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const currentTime = shallowRef(0)
  const snapshot = shallowRef<PlaybackClockSnapshot>({
    trackId: '', epoch: 0, position: 0, duration: 0, rate: 1, state: 'idle',
    revision: 0, sampledAt: now(), source: 'native-info', needsResync: false
  })
  let identity = '',
    epoch = 0,
    frame: number | null = null
  const connected = () =>
    core.status.value?.phase === 'ready' && core.state.value?.phase === 'ready'
  function estimate(at = now()): number {
    const sample = snapshot.value
    const elapsed =
      connected() && sample.state === 'playing'
        ? Math.min(1500, Math.max(0, at - sample.sampledAt))
        : 0
    const position = sample.position + (elapsed / 1000) * sample.rate
    return sample.duration > 0 ? Math.min(position, sample.duration) : position
  }
  function tick(): void {
    frame = null
    currentTime.value = estimate()
    if (connected() && snapshot.value?.state === 'playing') frame = requestFrame(tick)
  }
  watch(
    () => {
      const state = core.state.value,
        playback = state?.playback
      return [
        state?.epoch,
        state?.queue?.occurrenceId,
        state?.track?.id,
        playback?.position,
        playback?.duration,
        playback?.state,
        playback?.playbackRate,
        core.status.value?.phase
      ] as const
    },
    (value, previous) => {
      if (previous && value.every((entry, index) => entry === previous[index])) return
      const [coreEpoch, occurrence, trackId, position, duration, state, rate] = value
      const nextIdentity = `${coreEpoch}:${occurrence ?? trackId ?? ''}`
      if (identity !== nextIdentity) {
        identity = nextIdentity
        epoch++
      }
      snapshot.value = Object.freeze({
        trackId: trackId ?? '',
        epoch,
        position: position ?? 0,
        duration: duration ?? 0,
        rate: rate ?? 1,
        state: state === 'stopped' || !state ? 'idle' : state,
        revision: core.state.value?.sequence ?? 0,
        sampledAt: now(),
        source: 'native-info',
        needsResync: false
      })
      currentTime.value = position ?? 0
      if (frame !== null) cancelFrame(frame)
      frame = connected() && state === 'playing' ? requestFrame(tick) : null
    },
    { immediate: true }
  )
  onScopeDispose(() => {
    if (frame !== null) cancelFrame(frame)
  })
  return {
    currentTime: shallowReadonly(currentTime),
    playbackClockSnapshot: shallowReadonly(snapshot),
    estimatePlaybackClockPosition: estimate,
    duration: computed(
      () => core.state.value?.playback?.duration ?? core.state.value?.track?.duration ?? 0
    ),
    progress: computed(() =>
      snapshot.value?.duration ? (currentTime.value / snapshot.value.duration) * 100 : 0
    )
  }
}
