import { createLyricsLoader, type LyricsLoaderOptions, type LyricsLoadState } from './loader.ts'
import { createLyricsManagement, type LyricsManagementOptions } from './management.ts'
import {
  DEFAULT_LYRICS_MANAGEMENT,
  cloneLyricsManagementDocument,
  projectManagedLyrics,
  type OnlineLyricsSearchResult
} from '../../shared/lyricsManagement.ts'
import type {
  CoreLyricsContent,
  CoreLyricsCurrent,
  CoreLyricsMutation,
  CoreLyricsState
} from '../../shared/coreLyrics.ts'
import type { TrackData } from '../../shared/track.ts'
import { isPersistentDataRevisionConflict } from '../../shared/versionedPersistence.ts'
import { projectCoreError } from '../projections.ts'

export interface CoreLyricsOptions extends Omit<LyricsManagementOptions, 'document'> {
  sources: Pick<
    LyricsLoaderOptions,
    | 'loadLocalLyrics'
    | 'resolveProviderLyrics'
    | 'loadAmlTtml'
    | 'loadOnlineLyrics'
    | 'getAppSettings'
  >
  search(track: TrackData, signal?: AbortSignal): Promise<OnlineLyricsSearchResult>
  importDraft(signal?: AbortSignal): Promise<string | null>
  exportDraft(contents: string, signal?: AbortSignal): Promise<string | null>
  failed(error: unknown): void
}

/** Source resolution and committed edits survive every renderer connection. */
export class CoreLyricsService {
  private readonly document = { value: cloneLyricsManagementDocument(DEFAULT_LYRICS_MANAGEMENT) }
  private readonly currentTrack: { value: TrackData | null } = { value: null }
  private readonly management: ReturnType<typeof createLyricsManagement>
  private readonly loader: ReturnType<typeof createLyricsLoader>
  private loadState: LyricsLoadState = { trackId: '', status: 'idle' }
  private contentRevision = 0
  private error: string | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private active = false
  private stopped = false
  private readonly options: CoreLyricsOptions
  constructor(options: CoreLyricsOptions) {
    this.options = options
    this.management = createLyricsManagement({ ...options, document: this.document })
    const readLoadState = () => this.loadState
    const publishLoadState = (state: LyricsLoadState) => {
      this.loadState = state
      this.changed()
    }
    this.loader = createLyricsLoader({
      ...options.sources,
      currentTrack: this.currentTrack,
      lyricsLoadState: {
        get value() {
          return readLoadState()
        },
        set value(state) {
          publishLoadState(state)
        }
      },
      getLyricsManagement: () => this.management,
      patchTrackInQueues: () => this.changed(),
      timers: options.timers
    })
  }
  private changed(): void {
    this.contentRevision++
    this.options.changed()
  }
  async initialize(): Promise<void> {
    try {
      await this.management.ensureLoaded()
    } catch (error) {
      this.error = projectCoreError(error)
      this.options.failed(error)
    }
  }
  activate(): void {
    this.active = true
    this.load()
  }
  getRevision(): number {
    return this.management.getRevision()
  }
  getContentRevision(): number {
    return this.contentRevision
  }
  private selection(): CoreLyricsCurrent | null {
    const track = this.currentTrack.value
    return track ? { trackId: track.id, occurrenceId: track.queueEntryId ?? null } : null
  }
  private fenceCurrent(expected: CoreLyricsCurrent): TrackData {
    const current = this.selection()
    if (
      !current ||
      current.trackId !== expected.trackId ||
      current.occurrenceId !== expected.occurrenceId
    )
      throw stale('Playback selection changed')
    return this.currentTrack.value!
  }
  state(): CoreLyricsState {
    const { globalOffsetMs, showOriginal, showTranslation, showRomanization } = this.document.value
    return {
      revision: this.getRevision(),
      contentRevision: this.contentRevision,
      preferences: { globalOffsetMs, showOriginal, showTranslation, showRomanization },
      current: this.selection(),
      loadState: { ...this.loadState },
      error: this.error
    }
  }
  entry(trackId: string): { revision: number; override: CoreLyricsContent['override'] } {
    return {
      revision: this.getRevision(),
      override: structuredClone(this.management.entryFor(trackId) ?? null)
    }
  }
  content(): CoreLyricsContent {
    const track = this.currentTrack.value
    const automatic = track
      ? {
          original: track.lyrics,
          translation: track.translatedLyrics ?? null,
          romanization: track.romanizedLyrics ?? null,
          originalSource: track.lyricsSource ?? null,
          translationSource: track.translatedLyricsSource ?? null,
          romanizationSource: track.romanizedLyricsSource ?? null
        }
      : null
    const override = track ? this.management.entryFor(track.id) : undefined
    return {
      revision: this.getRevision(),
      contentRevision: this.contentRevision,
      current: this.selection(),
      automatic,
      effective: automatic ? projectManagedLyrics(automatic, override) : null,
      override: override ? { ...override } : null,
      offsetSeconds: track ? this.management.effectiveOffsetSeconds(track.id) : 0
    }
  }
  observe(track: TrackData | null): void {
    if (this.stopped) return
    const previous = this.currentTrack.value
    if (previous?.id === track?.id) {
      if (track && previous && track.queueEntryId !== previous.queueEntryId) {
        this.currentTrack.value = { ...previous, queueEntryId: track.queueEntryId }
        this.changed()
      }
      return
    }
    this.currentTrack.value = track ? { ...track } : null
    this.loader.onTrackChanged(track?.id ?? '', previous?.id ?? '')
    if (this.active) this.load()
    this.changed()
  }
  private load(): void {
    if (!this.currentTrack.value || this.stopped) return
    void this.loader.ensureCurrentTrackLyricsLoaded().catch((error) => {
      this.error = projectCoreError(error)
      this.options.failed(error)
      this.changed()
    })
  }
  edit(command: CoreLyricsMutation, signal?: AbortSignal): Promise<CoreLyricsState> {
    if (this.stopped) return Promise.reject(new Error('Lyrics are shutting down'))
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted()
        if (command.revision !== this.getRevision()) throw stale('Lyrics changed; read fresh state')
        const edit = command.edit
        try {
          switch (edit.kind) {
            case 'globalOffset':
              await this.management.updateGlobalOffset(edit.offsetMs)
              break
            case 'visibility':
              await this.management.updateVisibility(edit.patch)
              break
            case 'track':
              await this.management.updateTrack(edit.trackId, edit.patch)
              break
          }
        } catch (error) {
          if (isPersistentDataRevisionConflict(error))
            throw stale('Lyrics changed; read fresh state')
          throw error
        }
        this.error = null
        this.changed()
        if (edit.kind === 'track' && edit.trackId === this.currentTrack.value?.id && this.active)
          this.load()
        return this.state()
      })
    this.tail = work
    return work
  }
  async reload(current: CoreLyricsCurrent): Promise<void> {
    this.fenceCurrent(current)
    await this.loader.ensureCurrentTrackLyricsLoaded(this.currentTrack.value, true, true)
  }
  search(current: CoreLyricsCurrent, signal?: AbortSignal): Promise<OnlineLyricsSearchResult> {
    return this.options.search(this.fenceCurrent(current), signal)
  }
  importDraft(signal?: AbortSignal): Promise<string | null> {
    return this.options.importDraft(signal)
  }
  exportDraft(contents: string, signal?: AbortSignal): Promise<string | null> {
    return this.options.exportDraft(contents, signal)
  }
  async flush(): Promise<void> {
    // Every edit already awaits its disk ACK; a rejected command has no queued draft to flush.
    await this.tail.catch(() => undefined)
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.loader.shutdown()
    await this.flush()
  }
}
function stale(message: string): Error {
  return Object.assign(new Error(message), { code: 'STALE_REVISION' })
}
