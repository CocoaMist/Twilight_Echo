interface RendererPauseFadeOptions {
  getVolume: () => number
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export function createRendererPauseFadeController(options: RendererPauseFadeOptions) {
  const now = options.now ?? (() => performance.now())
  const schedule = options.setInterval ?? setInterval
  const cancelInterval = options.clearInterval ?? clearInterval
  let timer: ReturnType<typeof setInterval> | null = null
  let audio: HTMLAudioElement | null = null
  let gain = 1

  function syncVolume(): void {
    if (audio) audio.volume = options.getVolume() * gain
  }

  function cancel(): void {
    if (timer !== null) cancelInterval(timer)
    timer = null
    gain = 1
    syncVolume()
    audio = null
  }

  function begin(target: HTMLAudioElement): void {
    cancel()
    audio = target
    if (target.paused || options.getVolume() === 0) {
      target.pause()
      cancel()
      return
    }
    const source = target.src
    const startedAt = now()
    timer = schedule(() => {
      // A late callback must never pause a replacement track.
      if (target.src !== source || target.paused || target.ended) {
        cancel()
        return
      }
      gain = Math.max(0, 1 - (now() - startedAt) / 200)
      syncVolume()
      if (gain === 0) {
        target.pause()
        cancel()
      }
    }, 16)
  }

  return { begin, cancel, syncVolume, isActive: () => timer !== null }
}
