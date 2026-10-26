import type { CoreSnapshot } from '../../shared/coreProtocol.ts'
import type { CoreQueuePage } from '../../shared/coreViews.ts'
import type {
  CorePlayerPresentation,
  CoreSystemLyrics,
  CoreSystemPlaybackAction
} from '../../shared/coreSystemPlayer.ts'
import { EMPTY_MINI_PLAYER_STATE, type MiniPlayerStateSnapshot } from '../../shared/miniPlayer.ts'
import type { PlayerShortcutAction } from '../../shared/playerShortcuts.ts'
import type {
  DesktopLyricsSession,
  DesktopLyricsClockSnapshot,
  DesktopLyricsTransportState
} from '../../shared/desktopLyrics.ts'
import type { DynamicIslandLyricsPayload } from '../../shared/dynamicIsland.ts'
import { createLyricContentCache } from '../../shared/lyrics/lyricContentCache.ts'
import { projectDesktopLyricsLines } from '../../shared/lyrics/desktopLyricsProjection.ts'

export interface CoreSystemPlayerTransport {
  command(action: CoreSystemPlaybackAction): Promise<unknown>
  presentation(signal: AbortSignal): Promise<CorePlayerPresentation>
  lyrics(signal: AbortSignal): Promise<CoreSystemLyrics>
  queuePage(input: {
    id: string
    revision: number
    offset: number
    limit: number
  }): Promise<CoreQueuePage>
  now(): number
  failed(error: unknown): void
}
export interface CoreSystemPlayerOutput {
  state(state: MiniPlayerStateSnapshot): void
  lyrics(session: DesktopLyricsSession, island: DynamicIslandLyricsPayload): void
  clock(clock: DesktopLyricsClockSnapshot): void
}

/** Read-only system projection. Only Core decides playback and favorite mutations. */
export class CoreSystemPlayerBridge {
  private snapshot: CoreSnapshot | null = null
  private presentation: CorePlayerPresentation | null = null
  private presentationKey = ''
  private lyricsKey = ''
  private presentationRequest: AbortController | null = null
  private lyricsRequest: AbortController | null = null
  private generation = 0
  private activation = 0
  private clockSequence = 0
  private readonly parse = createLyricContentCache()
  private readonly transport: CoreSystemPlayerTransport
  private readonly output: CoreSystemPlayerOutput

  constructor(transport: CoreSystemPlayerTransport, output: CoreSystemPlayerOutput) {
    this.transport = transport
    this.output = output
  }
  private currentKey(): string {
    const snapshot = this.snapshot
    return snapshot
      ? JSON.stringify([
          snapshot.epoch,
          snapshot.track?.id ?? '',
          snapshot.queue?.occurrenceId ?? ''
        ])
      : ''
  }
  private sessionId(): string {
    return `core-lyrics:${this.generation}:${this.activation}`
  }
  private state(): MiniPlayerStateSnapshot {
    const snapshot = this.snapshot
    const track = snapshot?.track
    const playback = snapshot?.playback
    return {
      ...EMPTY_MINI_PLAYER_STATE,
      capturedAtMs: this.transport.now(),
      track: track
        ? {
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: track.album,
            albumArtist: track.albumArtist ?? '',
            trackNumber: track.trackNumber ?? 0,
            cover: this.presentation?.cover ?? null,
            coverSource: this.presentation?.coverSource ?? null,
            format: track.format ?? null,
            sampleRate: track.sampleRate ?? null,
            bitDepth: track.bitDepth ?? null
          }
        : null,
      isPlaying: playback?.state === 'playing',
      isLoading: snapshot?.loading ?? false,
      currentTime: playback?.position ?? 0,
      duration: playback?.duration ?? track?.duration ?? 0,
      playbackRate: playback?.playbackRate ?? 1,
      volume: snapshot?.mute?.userVolume ?? playback?.volume ?? 0.7,
      playMode: playback?.playMode ?? 'sequential',
      favoriteAvailable: this.presentation?.favorite.available ?? false,
      favoriteLiked: this.presentation?.favorite.liked ?? false,
      favoriteLoading: this.presentation?.favorite.loading ?? false,
      queueIndex: snapshot?.queue?.index ?? -1,
      queueLength: snapshot?.queue?.total ?? 0
    }
  }
  private publishClock(): void {
    const snapshot = this.snapshot
    const playback = snapshot?.playback
    let state: DesktopLyricsTransportState = 'paused'
    if (!snapshot?.track) state = 'idle'
    else if (playback?.state === 'playing') state = 'playing'
    this.output.clock({
      schemaVersion: 1,
      sessionId: this.sessionId(),
      sequence: ++this.clockSequence,
      epoch: this.generation,
      positionMs: Math.max(0, Math.round((playback?.position ?? 0) * 1000)),
      durationMs: Math.max(0, Math.round((playback?.duration ?? 0) * 1000)),
      rate: playback?.playbackRate ?? 1,
      state
    })
  }
  private emptyLyrics(): void {
    const track = this.snapshot?.track
    this.output.lyrics(
      {
        schemaVersion: 1,
        sessionId: this.sessionId(),
        contentRevision: this.snapshot?.lyricsContentRevision ?? 0,
        track: track ? { id: track.id, title: track.title, artist: track.artist } : null,
        status: track ? 'loading' : 'idle',
        lyricOffsetMs: 0,
        lines: []
      },
      { trackId: track?.id ?? null, lines: [] }
    )
  }
  update(snapshot: CoreSnapshot, resync = false): void {
    if (
      !resync &&
      this.snapshot?.epoch === snapshot.epoch &&
      this.snapshot.sequence >= snapshot.sequence
    )
      return
    if (snapshot.phase !== 'ready') {
      this.invalidate()
      return
    }
    const previous = this.currentKey()
    if (this.snapshot?.epoch !== snapshot.epoch) this.generation++
    this.snapshot = snapshot
    const current = this.currentKey()
    if (current !== previous) {
      this.activation++
      this.presentation = null
      this.emptyLyrics()
    }
    this.output.state(this.state())
    this.publishClock()
    if (!snapshot.track) {
      this.presentationRequest?.abort()
      this.lyricsRequest?.abort()
      this.presentationKey = this.lyricsKey = ''
      return
    }
    const presentationKey = `${current}:${snapshot.presentationRevision}`
    if (presentationKey !== this.presentationKey) {
      this.presentationKey = presentationKey
      this.presentationRequest?.abort()
      const request = (this.presentationRequest = new AbortController())
      void this.transport
        .presentation(request.signal)
        .then((value) => {
          if (request.signal.aborted || current !== this.currentKey()) return
          if (
            value.current?.trackId !== snapshot.track?.id ||
            (value.current?.occurrenceId ?? null) !== (snapshot.queue?.occurrenceId ?? null)
          )
            return
          this.presentation = value
          this.output.state(this.state())
        })
        .catch((error) => {
          if (!request.signal.aborted) this.transport.failed(error)
        })
    }
    const lyricsKey = `${current}:${snapshot.lyricsRevision}:${snapshot.lyricsContentRevision}`
    if (lyricsKey !== this.lyricsKey) {
      this.lyricsKey = lyricsKey
      this.lyricsRequest?.abort()
      const request = (this.lyricsRequest = new AbortController())
      void this.transport
        .lyrics(request.signal)
        .then(({ state, content }) => {
          if (request.signal.aborted || current !== this.currentKey()) return
          if (
            content.current?.trackId !== snapshot.track?.id ||
            (content.current?.occurrenceId ?? null) !== (snapshot.queue?.occurrenceId ?? null)
          )
            return
          const effective = content.effective
          const override = content.override
          const lines = this.parse(
            effective?.original,
            effective?.translation,
            effective?.romanization,
            {
              replaceTtmlTranslation:
                override?.translationSelection === 'manual' ||
                (override?.translationSelection == null && override?.source === 'manual'),
              replaceTtmlRomanization:
                override?.romanizationSelection === 'manual' ||
                (override?.romanizationSelection == null && override?.source === 'manual')
            }
          )
          const desktop = projectDesktopLyricsLines(lines)
          this.output.lyrics(
            {
              schemaVersion: 1,
              sessionId: this.sessionId(),
              contentRevision: content.contentRevision,
              track: snapshot.track
                ? {
                    id: snapshot.track.id,
                    title: snapshot.track.title,
                    artist: snapshot.track.artist
                  }
                : null,
              status:
                state.loadState.status === 'failed'
                  ? 'error'
                  : state.loadState.status === 'loading'
                    ? 'loading'
                    : desktop.length
                      ? 'ready'
                      : 'empty',
              lyricOffsetMs: Math.round(content.offsetSeconds * 1000),
              lines: desktop
            },
            {
              trackId: snapshot.track?.id ?? null,
              lines: lines
                .map((line) => ({
                  time: line.time,
                  original: line.text.trim(),
                  translation: line.translation?.trim() ?? null,
                  romanization: line.romanization?.trim() ?? null
                }))
                .filter((line) => line.original.length > 0)
            }
          )
        })
        .catch((error) => {
          if (!request.signal.aborted) this.transport.failed(error)
        })
    }
  }
  invalidate(): void {
    this.presentationRequest?.abort()
    this.lyricsRequest?.abort()
    this.snapshot = null
    this.presentation = null
    this.presentationKey = this.lyricsKey = ''
    this.generation++
    this.output.state(this.state())
    this.emptyLyrics()
    this.publishClock()
  }
  async command(action: CoreSystemPlaybackAction): Promise<void> {
    if (!this.snapshot) throw new Error('Music Core is not ready')
    await this.transport.command(action)
  }
  dispatch(action: CoreSystemPlaybackAction): void {
    void this.command(action).catch((error) => this.transport.failed(error))
  }
  shortcut(action: PlayerShortcutAction): void {
    if (typeof action === 'object') {
      if (action.action === 'seek') this.dispatch({ type: 'seek', value: action.positionSeconds })
      else if (action.action === 'setVolume')
        this.dispatch({ type: 'set-volume', value: action.volume })
      else void this.jump(action.index).catch((error) => this.transport.failed(error))
      return
    }
    if (action === 'volumeUp' || action === 'volumeDown')
      this.dispatch({ type: 'volume-step', direction: action })
    else if (action === 'playPause') this.dispatch({ type: 'toggle-play' })
    else if (action === 'next' || action === 'previous' || action === 'play' || action === 'pause')
      this.dispatch({ type: action })
  }
  private async jump(index: number): Promise<void> {
    const snapshot = this.snapshot
    if (!snapshot?.queue) throw new Error('Music Core has no active queue')
    const queue = snapshot.queue
    const page = await this.transport.queuePage({
      id: queue.id,
      revision: queue.revision,
      offset: index,
      limit: 1
    })
    if (snapshot.epoch !== this.snapshot?.epoch) throw new Error('Music Core session changed')
    const item = page.items[0]
    if (!item) throw new Error('Queue item is unavailable')
    await this.command({
      type: 'queue-jump',
      id: queue.id,
      revision: queue.revision,
      index,
      occurrenceId: item.queueEntryId
    })
  }
  resync(): void {
    this.presentationKey = this.lyricsKey = ''
    const snapshot = this.snapshot
    if (!snapshot) return
    this.update(snapshot, true)
  }
}

let installed: CoreSystemPlayerBridge | null = null
export function getCoreSystemPlayer(): CoreSystemPlayerBridge | null {
  return installed
}
export function installCoreSystemPlayerBridge(
  transport: CoreSystemPlayerTransport,
  output: CoreSystemPlayerOutput
): CoreSystemPlayerBridge {
  installed = new CoreSystemPlayerBridge(transport, output)
  return installed
}
