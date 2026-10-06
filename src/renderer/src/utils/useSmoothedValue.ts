import { onScopeDispose, ref, watch, type Ref } from 'vue'

export interface SmoothedValueOptions {
  /**
   * Time constant in ms: how long the smoothed value takes to close ~63% of the
   * gap to the target. Smaller tracks tighter, larger drifts softer.
   */
  tau?: number
  /**
   * Jumps larger than this snap instantly instead of gliding (seeks, track
   * switches). In the same unit as the value.
   */
  snapThreshold?: number
  /** Stop the rAF loop once within this distance of the target. */
  epsilon?: number
}

/**
 * osu!lazer-style per-frame interpolation (Interpolation.ValueAt): the returned
 * ref exponentially chases `target`, turning stepped updates (playback ticks,
 * spectrum frames) into continuous motion. The rAF loop only runs while the
 * value is still converging, so idle cost is zero.
 */
export function useSmoothedValue(
  target: Ref<number>,
  options: SmoothedValueOptions = {}
): Ref<number> {
  const { tau = 120, snapThreshold = Infinity, epsilon = 0.0005 } = options
  const smoothed = ref(target.value)
  let raf = 0
  let lastTime = 0

  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function stop(): void {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  function step(now: number): void {
    raf = 0
    const dt = Math.max(0, now - lastTime)
    lastTime = now
    const gap = target.value - smoothed.value
    if (Math.abs(gap) <= epsilon) {
      smoothed.value = target.value
      return
    }
    smoothed.value += gap * (1 - Math.exp(-dt / tau))
    raf = requestAnimationFrame(step)
  }

  function kick(): void {
    if (raf) return
    lastTime = performance.now()
    raf = requestAnimationFrame(step)
  }

  watch(target, (value) => {
    if (reducedMotion || Math.abs(value - smoothed.value) >= snapThreshold) {
      stop()
      smoothed.value = value
      return
    }
    kick()
  })

  onScopeDispose(stop)

  return smoothed
}
