import type { Cell } from '../playlists/ports.ts'
import type { VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import {
  clampLyricOffset,
  cloneLyricsManagementDocument,
  effectiveLyricOffsetSeconds,
  type LyricTrackOverride,
  type LyricSourcePreference,
  type LyricsManagementDocument
} from '../../shared/lyricsManagement.ts'
import { isPersistentDataRevisionConflict } from '../../shared/versionedPersistence.ts'

export interface LyricsManagementOptions {
  document: Cell<LyricsManagementDocument>
  repository: {
    load(): Promise<VersionedDataEnvelope<LyricsManagementDocument> | null>
    save(
      document: LyricsManagementDocument,
      revision: number
    ): Promise<VersionedDataEnvelope<LyricsManagementDocument>>
  }
  now(): number
  changed(): void
  timers: {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(handle: unknown): void
  }
}
export function createLyricsManagement(runtime: LyricsManagementOptions) {
  const { document } = runtime
  let revision = 0
  let loading: Promise<void> | null = null
  function entryFor(trackId: string): LyricTrackOverride | undefined {
    return document.value.tracks[trackId]
  }

  async function ensureLoaded(): Promise<void> {
    if (loading) return loading
    loading = (async () => {
      let timer: unknown
      const result = await Promise.race([
        runtime.repository.load(),
        new Promise<null>((resolve) => {
          timer = runtime.timers.setTimeout(() => resolve(null), 3_000)
        })
      ]).finally(() => runtime.timers.clearTimeout(timer))
      if (result) {
        document.value = cloneLyricsManagementDocument(result.data)
        revision = result.revision
      }
    })().finally(() => {
      loading = null
    })
    return loading
  }

  async function persist(next: LyricsManagementDocument): Promise<void> {
    try {
      const saved = await runtime.repository.save(next, revision)
      document.value = cloneLyricsManagementDocument(saved.data)
      revision = saved.revision
      runtime.changed()
    } catch (error) {
      if (!isPersistentDataRevisionConflict(error)) throw error
      const current = error.current
      if (!current) throw error
      // Do not replay a whole stale document: another renderer could have edited
      // a different track after we read. Keep the authority and let the caller
      // retry its focused update against the fresh revision.
      document.value = cloneLyricsManagementDocument(current.data as LyricsManagementDocument)
      revision = current.revision
      runtime.changed()
      throw error
    }
  }

  function nextDocument(): LyricsManagementDocument {
    return cloneLyricsManagementDocument(document.value)
  }

  function defaultOverride(): LyricTrackOverride {
    return {
      offsetMs: 0,
      source: 'auto',
      originalSelection: 'automatic',
      translationSelection: 'automatic',
      romanizationSelection: 'automatic',
      original: null,
      translation: null,
      romanization: null,
      updatedAt: new Date(runtime.now()).toISOString()
    }
  }

  async function updateGlobalOffset(offsetMs: number): Promise<void> {
    await ensureLoaded()
    const next = nextDocument()
    next.globalOffsetMs = clampLyricOffset(offsetMs)
    await persist(next)
  }

  async function updateVisibility(
    patch: Partial<
      Pick<LyricsManagementDocument, 'showOriginal' | 'showTranslation' | 'showRomanization'>
    >
  ): Promise<void> {
    await ensureLoaded()
    const next = nextDocument()
    if (typeof patch.showOriginal === 'boolean') next.showOriginal = patch.showOriginal
    if (typeof patch.showTranslation === 'boolean') next.showTranslation = patch.showTranslation
    if (typeof patch.showRomanization === 'boolean') next.showRomanization = patch.showRomanization
    await persist(next)
  }

  async function updateTrack(
    trackId: string,
    patch: Partial<
      Pick<
        LyricTrackOverride,
        | 'offsetMs'
        | 'source'
        | 'originalSelection'
        | 'translationSelection'
        | 'romanizationSelection'
        | 'original'
        | 'translation'
        | 'romanization'
      >
    >
  ): Promise<void> {
    if (!trackId) return
    await ensureLoaded()
    const next = nextDocument()
    const previous = next.tracks[trackId] ?? defaultOverride()
    const override: LyricTrackOverride = {
      ...previous,
      ...patch,
      offsetMs: clampLyricOffset(patch.offsetMs ?? previous.offsetMs),
      updatedAt: new Date(runtime.now()).toISOString()
    }
    next.tracks[trackId] = override
    await persist(next)
  }

  async function selectSource(trackId: string, source: LyricSourcePreference): Promise<void> {
    await updateTrack(trackId, { source })
  }

  return {
    document,
    getRevision: () => revision,
    ensureLoaded,
    entryFor,
    effectiveOffsetSeconds: (trackId: string) =>
      effectiveLyricOffsetSeconds(document.value.globalOffsetMs, entryFor(trackId)?.offsetMs ?? 0),
    updateGlobalOffset,
    updateVisibility,
    updateTrack,
    selectSource
  }
}
