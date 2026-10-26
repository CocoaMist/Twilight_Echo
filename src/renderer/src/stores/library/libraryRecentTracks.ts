import { computed, shallowRef, toRaw, watch } from 'vue'
import { createRecordingIdentityRules } from '../../../../shared/recordingIdentity.ts'
import type { Track } from '../../types/music.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
import {
  readLibraryRecentHistory,
  type LibraryRecentHistoryOptions
} from './libraryRecentHistory.ts'

type RecentSnapshot = {
  generation: number
  revision: number
  preferenceRevision: number
}
export interface LibraryRecentTracksState {
  mode: 'json' | 'sqlite' | null
  loading: boolean
  error: string
  tracks: Track[]
  revision: number | null
}

/** Online home intentionally plays a six-item mixed shelf. Resolve up to
 * thirty history identities in SQL, not through a full local Track[] index. */
export function createLibraryRecentTracks(
  options: LibraryRecentHistoryOptions & {
    getStorageMode(): Promise<'json' | 'sqlite'>
    getTracks(): Track[]
    getHistory(): readonly UnifiedRecentStat[]
  }
) {
  const state = shallowRef<LibraryRecentTracksState>({
    mode: null,
    loading: false,
    error: '',
    tracks: [],
    revision: null
  })
  const history = computed(() => options.getHistory().slice(0, 30))
  const tracks = computed(() => state.value.tracks)
  const snapshots = new WeakMap<Track[], RecentSnapshot>()
  let generation = 0,
    minimumRevision = 0,
    disposed = false,
    started = false,
    active = false,
    pending = false,
    confirming = false
  type Confirmation = {
    snapshot: RecentSnapshot
    resolve(value: boolean): void
    reject(error: unknown): void
  }
  let confirmation: Confirmation | null = null
  let activeConfirmation: Confirmation | null = null
  const changed = () => new Error('最近播放或曲库已更新，请刷新后重新播放')
  function live() {
    if (disposed) throw new DOMException('Recent shelf closed', 'AbortError')
  }
  function current(snapshot: RecentSnapshot) {
    return (
      !disposed &&
      snapshot.generation === generation &&
      snapshot.revision >= minimumRevision &&
      snapshot.preferenceRevision === options.getPreferences().revision
    )
  }
  function pump() {
    if (disposed || active || !pending) return
    pending = false
    active = true
    const request = generation
    void (async () => {
      try {
        const mode = state.value.mode ?? (await options.getStorageMode())
        live()
        if (mode !== 'sqlite') throw new Error('最近播放需要 Core SQLite 曲库')
        state.value = { ...state.value, mode }
        // An empty ID read carries only the version; getMetadata would also
        // transfer the complete exclusions/configuration for every history tick.
        const revision = (await options.api.getTracksByIds([])).revision
        live()
        if (revision < minimumRevision) throw changed()
        const input = history.value
        const result = await readLibraryRecentHistory(input, revision, options, live)
        if ((await options.api.getTracksByIds([])).revision !== revision) throw changed()
        live()
        const snapshot = {
          generation: request,
          revision,
          preferenceRevision: result.preferenceRevision
        }
        if (request !== generation) return
        if (!current(snapshot)) throw changed()
        const bySource = new Map(
          result.preferences.versions.flatMap((version) =>
            version.sources.map((key) => [key, version] as const)
          )
        )
        const rules = createRecordingIdentityRules((key) => bySource.get(key))
        const seen = new Set<string>(),
          rows: Track[] = []
        for (const stat of input) {
          const track = result.resolved.get(stat.id)
          if (!track) continue
          const key = rules.getRecordingTrackKey(track)
          if (seen.has(key)) continue
          seen.add(key)
          rows.push(track)
          if (rows.length === 6) break
        }
        snapshots.set(rows, snapshot)
        state.value = { mode, loading: false, error: '', tracks: rows, revision }
      } catch (error) {
        if (!disposed && request === generation)
          state.value = {
            ...state.value,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }
      } finally {
        active = false
        pump()
      }
    })()
  }
  function refresh() {
    if (disposed) return
    generation++
    pending = true
    state.value = { ...state.value, loading: true, error: '' }
    pump()
  }
  function pumpConfirmation() {
    if (disposed || confirming || !confirmation) return
    const request = confirmation
    confirmation = null
    confirming = true
    activeConfirmation = request
    void (async () => {
      try {
        if (!current(request.snapshot)) throw changed()
        const metadata = await options.api.getTracksByIds([])
        if (disposed) return request.resolve(false)
        if (!current(request.snapshot) || metadata.revision !== request.snapshot.revision)
          throw changed()
        request.resolve(true)
      } catch (error) {
        if (disposed) request.resolve(false)
        else request.reject(error)
      } finally {
        activeConfirmation = null
        confirming = false
        pumpConfirmation()
      }
    })()
  }
  const stops = [
    watch([history, () => options.getPreferences().revision], () => {
      if (started && state.value.mode !== 'json') refresh()
    })
  ]
  return {
    state,
    tracks,
    refresh,
    start() {
      if (started || disposed) return
      started = true
      refresh()
    },
    invalidate(revision?: number) {
      if (revision !== undefined) {
        if (revision <= Math.max(minimumRevision, state.value.revision ?? 0)) return
        minimumRevision = revision
      }
      refresh()
    },
    capture(rows: Track[]) {
      return snapshots.get(toRaw(rows)) ?? null
    },
    confirm(snapshot: RecentSnapshot): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      return new Promise((resolve, reject) => {
        confirmation?.resolve(false)
        confirmation = { snapshot, resolve, reject }
        pumpConfirmation()
      })
    },
    dispose() {
      disposed = true
      generation++
      pending = false
      activeConfirmation?.resolve(false)
      confirmation?.resolve(false)
      confirmation = null
      stops.forEach((stop) => stop())
    },
    get requests() {
      return {
        active: Number(active),
        pending: Number(pending),
        confirming: Number(confirming),
        pendingConfirmation: Number(!!confirmation)
      }
    }
  }
}
