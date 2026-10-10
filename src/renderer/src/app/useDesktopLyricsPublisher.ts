import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  DESKTOP_LYRICS_CLOCK_INTERVAL_MS,
  type DesktopLyricsClockSnapshot,
  type DesktopLyricsSession,
  type DesktopLyricsTransportState
} from '../../../shared/desktopLyrics.ts'
import { projectManagedLyrics } from '../../../shared/lyricsManagement.ts'
import { useLyricsManagement } from '../stores/lyricsManagement.ts'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore.ts'
import { createLyricContentCache } from '../utils/lyricContentCache.ts'
import type { LyricLine } from '../utils/lyricTypes.ts'
import { projectDesktopLyricsLines } from '../utils/desktopLyricsProjection.ts'

function transportState(state: string): DesktopLyricsTransportState {
  if (state === 'playing') return 'playing'
  if (state === 'loading' || state === 'stalled') return 'loading'
  if (state === 'idle') return 'idle'
  return 'paused'
}

export function useDesktopLyricsPublisher(): void {
  const api = window.api?.desktopLyrics
  if (!api?.publishSession || !api.publishClock) return

  const player = usePlayerStore()
  const management = useLyricsManagement()
  const settingsStore = useSettingsStore()
  let activation = 0
  let contentRevision = 0
  let sequence = 0
  let activeTrackId = ''
  let sessionId = 'desktop-lyrics:idle:0'
  let lastClockAt = 0
  let lastEpoch = -1
  let lastState = ''
  let clockTimer: ReturnType<typeof setTimeout> | null = null
  const publishingEnabled = ref(settingsStore.settings.value.desktopLyrics.enabled)
  const disposers: Array<() => void> = []

  function ensureSessionId(trackId: string): void {
    if (trackId === activeTrackId) return
    activeTrackId = trackId
    activation += 1
    sequence = 0
    lastEpoch = -1
    sessionId = `desktop-lyrics:${activation}:${trackId || 'idle'}`.slice(0, 160)
  }

  const buildCachedLyricLines = createLyricContentCache()
  let parsedLines: LyricLine[] | null = null
  let projectedLines: DesktopLyricsSession['lines'] = []
  type SessionContent = Pick<DesktopLyricsSession, 'track' | 'status' | 'lyricOffsetMs' | 'lines'>
  const sessionContent = computed<SessionContent>((previous) => {
    const track = player.currentTrack.value
    if (!track) {
      if (previous?.track === null) return previous
      return {
        track: null,
        status: 'idle',
        lyricOffsetMs: 0,
        lines: []
      }
    }
    const override = management.entryFor(track.id)
    const managed = projectManagedLyrics(
      {
        original: track.lyrics,
        translation: track.translatedLyrics,
        romanization: track.romanizedLyrics,
        originalSource: track.lyricsSource,
        translationSource: track.translatedLyricsSource,
        romanizationSource: track.romanizedLyricsSource
      },
      override
    )
    const nextParsed = buildCachedLyricLines(
      managed.original,
      managed.translation,
      managed.romanization,
      {
        replaceTtmlTranslation:
          override?.translationSelection === 'manual' ||
          (override?.translationSelection == null && override?.source === 'manual'),
        replaceTtmlRomanization:
          override?.romanizationSelection === 'manual' ||
          (override?.romanizationSelection == null && override?.source === 'manual')
      }
    )
    if (nextParsed !== parsedLines) {
      parsedLines = nextParsed
      projectedLines = projectDesktopLyricsLines(nextParsed)
    }
    const lines = projectedLines
    const loadState = player.lyricsLoadState.value
    const status =
      loadState.trackId === track.id && loadState.status === 'loading'
        ? 'loading'
        : loadState.trackId === track.id && loadState.status === 'failed'
          ? 'error'
          : lines.length > 0
            ? 'ready'
            : 'empty'
    const lyricOffsetMs = Math.round(management.effectiveOffsetSeconds(track.id) * 1000)
    if (
      previous?.track?.id === track.id &&
      previous.track.title === (track.title || '') &&
      previous.track.artist === (track.artist || '') &&
      previous.status === status &&
      previous.lyricOffsetMs === lyricOffsetMs &&
      previous.lines === lines
    )
      return previous
    return {
      track: { id: track.id, title: track.title || '', artist: track.artist || '' },
      status,
      lyricOffsetMs,
      lines
    }
  })

  function publishSession(force = false): void {
    if (!publishingEnabled.value && !force) return
    const content = sessionContent.value
    ensureSessionId(content.track?.id ?? '')
    api.publishSession({
      schemaVersion: 1,
      sessionId,
      contentRevision: ++contentRevision,
      ...content
    })
  }

  function publishClock(force = false): void {
    if (!publishingEnabled.value && !force) return
    const snapshot = player.playbackClockSnapshot.value
    ensureSessionId(player.currentTrack.value?.id ?? '')
    const now = performance.now()
    const immediate =
      force || snapshot.epoch !== lastEpoch || snapshot.state !== lastState || lastClockAt === 0
    const remaining = DESKTOP_LYRICS_CLOCK_INTERVAL_MS - (now - lastClockAt)
    if (!immediate && remaining > 0) {
      if (clockTimer == null) {
        clockTimer = setTimeout(() => {
          clockTimer = null
          publishClock(true)
        }, remaining)
      }
      return
    }
    if (clockTimer != null) {
      clearTimeout(clockTimer)
      clockTimer = null
    }
    lastClockAt = now
    lastEpoch = snapshot.epoch
    lastState = snapshot.state
    const clock: DesktopLyricsClockSnapshot = {
      schemaVersion: 1,
      sessionId,
      sequence: ++sequence,
      epoch: snapshot.epoch,
      positionMs: Math.max(0, Math.round(snapshot.position * 1000)),
      durationMs: Math.max(0, Math.round(snapshot.duration * 1000)),
      rate: Math.min(2, Math.max(0.5, snapshot.rate || 1)),
      state: transportState(snapshot.state)
    }
    api.publishClock(clock)
  }

  watch(
    () => (publishingEnabled.value ? sessionContent.value : null),
    () => publishSession(),
    { immediate: true }
  )
  watch(player.playbackClockSnapshot, () => publishClock(), { immediate: true })
  watch(
    () => settingsStore.settings.value.desktopLyrics.enabled,
    (enabled) => {
      publishingEnabled.value = enabled
      if (!enabled) {
        if (clockTimer != null) clearTimeout(clockTimer)
        clockTimer = null
        return
      }
      publishClock(true)
    }
  )
  disposers.push(
    api.onEnabledChanged((enabled) => {
      const alreadyEnabled = publishingEnabled.value
      publishingEnabled.value = enabled
      if (!enabled) {
        if (clockTimer != null) clearTimeout(clockTimer)
        clockTimer = null
        return
      }
      if (alreadyEnabled) publishSession(true)
      publishClock(true)
    }),
    api.onResyncRequested(() => {
      publishSession(true)
      publishClock(true)
    })
  )

  onBeforeUnmount(() => {
    if (clockTimer != null) clearTimeout(clockTimer)
    for (const dispose of disposers) dispose()
  })
}
