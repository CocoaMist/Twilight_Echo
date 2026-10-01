import type { Ref } from 'vue'
import type { Track } from '../../types/music'

export function createAbLoopController({
  currentTrack,
  abLoopA,
  abLoopB,
  getLatestPlaybackTime,
  seekPlayback,
  getNativeLoopRange
}: {
  currentTrack: Ref<Track | null>
  abLoopA: Ref<number | null>
  abLoopB: Ref<number | null>
  getLatestPlaybackTime: () => number
  seekPlayback: (position: number) => void
  getNativeLoopRange: () => ((start: number, end: number) => Promise<boolean>) | undefined
}) {
  let abLoopNativeActive = false
  let abLoopEnforcing = false

  function clearAbLoop(): void {
    abLoopA.value = null
    abLoopB.value = null
    abLoopNativeActive = false
    // Prefer native clear; soft path is a no-op when range is null.
    void getNativeLoopRange()?.(-1, -1).catch(() => {})
  }

  /** Push current A-B range to native engine when both points are set; otherwise clear. */
  function syncNativeAbLoop(): void {
    const a = abLoopA.value
    const b = abLoopB.value
    const api = getNativeLoopRange()
    if (!api) return
    if (a == null || b == null || b <= a || isCurrentTrackLiveStream()) {
      abLoopNativeActive = false
      void api(-1, -1).catch(() => {})
      return
    }
    void api(a, b)
      .then((ok) => {
        // When native accepts, soft enforce becomes a safety net only.
        if (ok) abLoopNativeActive = true
        else abLoopNativeActive = false
      })
      .catch(() => {
        abLoopNativeActive = false
      })
  }

  function isCurrentTrackLiveStream(): boolean {
    const track = currentTrack.value
    if (!track) return false
    if (track.source === 'radio') return true
    return (
      typeof track.duration === 'number' &&
      track.duration <= 0 &&
      Boolean(track.streamUrl || /^https?:\/\//i.test(track.filePath || ''))
    )
  }

  function setAbLoopPoint(point: 'a' | 'b', time = getLatestPlaybackTime()): void {
    if (isCurrentTrackLiveStream()) return
    const position = Math.max(0, Number.isFinite(time) ? time : 0)
    if (point === 'a') {
      abLoopA.value = position
      if (abLoopB.value != null && abLoopB.value <= position) abLoopB.value = null
      syncNativeAbLoop()
      return
    }
    if (abLoopA.value == null) abLoopA.value = 0
    if (position <= (abLoopA.value ?? 0)) return
    abLoopB.value = position
    syncNativeAbLoop()
  }

  function toggleAbLoopAtCurrentTime(): void {
    if (isCurrentTrackLiveStream()) {
      clearAbLoop()
      return
    }
    if (abLoopA.value == null) {
      setAbLoopPoint('a')
      return
    }
    if (abLoopB.value == null) {
      setAbLoopPoint('b')
      return
    }
    clearAbLoop()
  }

  function enforceAbLoop(time: number): void {
    if (abLoopEnforcing) return
    if (isCurrentTrackLiveStream()) return
    // When native SetLoopRange is active, clock-thread seek owns enforcement.
    if (abLoopNativeActive) return
    const a = abLoopA.value
    const b = abLoopB.value
    if (a == null || b == null || b <= a) return
    // Soft A-B fallback when native binding is missing or rejected the range.
    if (time + 0.02 >= b) {
      abLoopEnforcing = true
      try {
        seekPlayback(a)
      } finally {
        abLoopEnforcing = false
      }
    }
  }
  return {
    clearAbLoop,
    isCurrentTrackLiveStream,
    setAbLoopPoint,
    toggleAbLoopAtCurrentTime,
    enforceAbLoop,
    getAbLoopNativeActive: () => abLoopNativeActive
  }
}
