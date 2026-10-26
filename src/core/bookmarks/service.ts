import {
  createPlaybackBookmarks,
  type PlaybackBookmarksOptions,
  type BookmarkTrack
} from './controller.ts'
import {
  DEFAULT_PLAYBACK_BOOKMARKS,
  clonePlaybackBookmarksDocument,
  type PlaybackBookmark
} from '../../shared/playbackBookmarks.ts'
import type { TrackData } from '../../shared/track.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type {
  CoreBookmark,
  CoreBookmarkCurrent,
  CoreBookmarkMutation,
  CoreBookmarksState,
  CoreBookmarksQuery,
  CoreBookmarksPage
} from '../../shared/coreBookmarks.ts'
import { isPersistentDataRevisionConflict } from '../../shared/versionedPersistence.ts'
import { projectCoreError } from '../projections.ts'

type Observation = Pick<PlaybackInfo, 'state' | 'position' | 'naturalBoundaries'>
type Sample = { track: BookmarkTrack; info: Observation }
export interface CoreBookmarksOptions extends Omit<PlaybackBookmarksOptions, 'document'> {
  failed(error: unknown): void
}

/** One bookmark writer and one native-observation stream, independent of UI lifetimes. */
export class CoreBookmarksService {
  private readonly options: CoreBookmarksOptions
  private readonly controller: ReturnType<typeof createPlaybackBookmarks>
  private readonly document = { value: clonePlaybackBookmarksDocument(DEFAULT_PLAYBACK_BOOKMARKS) }
  private tail: Promise<unknown> = Promise.resolve()
  private previous: Sample | null = null
  private offer: PlaybackBookmark | null = null
  private error: string | null = null
  private lastResume = ''
  private stopped = false
  constructor(options: CoreBookmarksOptions) {
    this.options = options
    this.controller = createPlaybackBookmarks({ ...options, document: this.document })
  }
  async initialize(): Promise<void> {
    try {
      await this.controller.ensureLoaded()
    } catch (error) {
      this.error = projectCoreError(error)
      this.options.failed(error)
      this.options.changed()
    }
  }
  getRevision(): number {
    return this.controller.getRevision()
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Bookmarks are shutting down'))
    const work = this.tail.catch(() => undefined).then(action)
    this.tail = work
    return work
  }
  private fence(revision: number): void {
    if (revision !== this.controller.getRevision())
      throw stale('Bookmarks changed; read a fresh page')
  }
  private current(expected?: CoreBookmarkCurrent): BookmarkTrack | null {
    const track = this.previous?.track ?? null
    if (
      expected &&
      (!track ||
        track.id !== expected.trackId ||
        (track.queueEntryId ?? null) !== expected.occurrenceId)
    )
      throw stale('Playback selection changed')
    return track
  }
  state(): CoreBookmarksState {
    const track = this.current()
    return {
      revision: this.controller.getRevision(),
      longTrackResumeSeconds: this.document.value.longTrackResumeSeconds,
      current: track ? { trackId: track.id, occurrenceId: track.queueEntryId ?? null } : null,
      resumeOffer: this.offer ? project(this.offer) : null,
      error: this.error
    }
  }
  page(query: CoreBookmarksQuery): CoreBookmarksPage {
    this.fence(query.revision)
    const entries =
      query.scope === 'current'
        ? this.controller.bookmarksFor(this.current())
        : this.document.value.bookmarks
    const offset = query.offset ?? 0,
      limit = query.limit ?? 200
    return {
      revision: query.revision,
      offset,
      total: entries.length,
      items: entries.slice(offset, offset + limit).map(project)
    }
  }
  edit(command: CoreBookmarkMutation, signal?: AbortSignal): Promise<CoreBookmarksState> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(command.revision)
      const edit = command.edit,
        c = this.controller
      try {
        switch (edit.kind) {
          case 'addCurrent': {
            const track = this.current(edit.current)!
            await c.addBookmark(track, this.previous!.info.position, {
              label: edit.label,
              kind: 'manual'
            })
            break
          }
          case 'remove':
            await c.removeBookmark(edit.id)
            if (this.offer?.id === edit.id) this.offer = null
            break
          case 'rename':
            await c.renameBookmark(edit.id, edit.label)
            if (this.offer?.id === edit.id)
              this.offer = this.document.value.bookmarks.find((b) => b.id === edit.id) ?? null
            break
          case 'threshold':
            await c.setLongTrackResumeSeconds(edit.seconds)
            if (!c.shouldOfferLongTrackResume(this.current())) this.offer = null
            break
          case 'dismissOffer':
            this.current(edit.current)
            this.offer = null
            break
        }
      } catch (error) {
        if (isPersistentDataRevisionConflict(error)) {
          this.options.changed()
          throw stale('Bookmarks changed; read a fresh page')
        }
        throw error
      }
      this.error = null
      this.options.changed()
      return this.state()
    })
  }
  position(id: string, revision: number, current: CoreBookmarkCurrent): number {
    this.fence(revision)
    const track = this.current(current)!
    const entry = this.controller.bookmarksFor(track).find((b) => b.id === id)
    if (!entry) throw new Error('Bookmark does not belong to the current track')
    this.offer = null
    this.options.changed()
    return entry.positionSeconds
  }
  observe(track: TrackData | null, info: Observation): void {
    if (this.stopped) return
    const previous = this.previous
    const changed =
      !previous ||
      !track ||
      previous.track.id !== track.id ||
      previous.track.queueEntryId !== track.queueEntryId
    const naturalEnd =
      previous &&
      info.naturalBoundaries != null &&
      previous.info.naturalBoundaries != null &&
      info.naturalBoundaries.trackSerial > previous.info.naturalBoundaries.trackSerial
    if (
      previous &&
      !naturalEnd &&
      (changed || (previous.info.state === 'playing' && info.state !== 'playing'))
    ) {
      const position = changed || info.state === 'stopped' ? previous.info.position : info.position
      this.recordResume(previous.track, position)
    }
    this.previous = track
      ? {
          track: {
            id: track.id,
            filePath: track.filePath,
            source: track.source,
            subTrack: track.subTrack,
            cueRange: track.cueRange ? { ...track.cueRange } : undefined,
            queueEntryId: track.queueEntryId,
            duration: track.duration,
            title: track.title,
            artist: track.artist
          },
          info: {
            state: info.state,
            position: info.position,
            naturalBoundaries: info.naturalBoundaries ? { ...info.naturalBoundaries } : undefined
          }
        }
      : null
    if (changed) {
      this.offer =
        track && info.position <= 5 && this.controller.shouldOfferLongTrackResume(track)
          ? this.controller.resumeBookmarkFor(track)
          : null
      if (this.offer && this.offer.positionSeconds < 15) this.offer = null
      this.options.changed()
    }
  }
  private recordResume(track: BookmarkTrack, position: number): void {
    if (
      !this.controller.shouldOfferLongTrackResume(track) ||
      !Number.isFinite(position) ||
      position < 15 ||
      position > track.duration - 10
    )
      return
    const key = `${this.controller.trackKeyFor(track)}\0${Math.round(position * 1000)}`
    if (key === this.lastResume) return
    this.lastResume = key
    const work = this.enqueue(async () => {
      await this.controller.addBookmark(track, position, { kind: 'resume' })
      this.error = null
      this.options.changed()
    })
    void work.catch((error) => {
      this.error = projectCoreError(error)
      this.options.failed(error)
      this.options.changed()
    })
  }
  async flush(): Promise<void> {
    await this.tail
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return
    if (this.previous) this.recordResume(this.previous.track, this.previous.info.position)
    this.stopped = true
    await this.flush()
  }
}
function project(bookmark: PlaybackBookmark): CoreBookmark {
  return {
    id: bookmark.id,
    trackId: bookmark.trackId,
    title: bookmark.title,
    artist: bookmark.artist,
    positionSeconds: bookmark.positionSeconds,
    label: bookmark.label,
    createdAt: bookmark.createdAt,
    updatedAt: bookmark.updatedAt,
    kind: bookmark.kind
  }
}
function stale(message: string): Error {
  return Object.assign(new Error(message), { code: 'STALE_REVISION' })
}
