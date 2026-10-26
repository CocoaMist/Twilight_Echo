import { computed, shallowRef } from 'vue'
import type {
  AlbumBrowsePage,
  AlbumBrowseQuery,
  AlbumBrowseScope,
  AlbumSourcesPage,
  AlbumSourcesQuery
} from '../../../../shared/musicAlbumBrowse.ts'
import type { GenreBrowseToken } from '../../../../shared/musicGenreBrowse.ts'
import type { UnifiedPlaybackResult } from '../../../../shared/musicUnifiedPlayback.ts'

export const ALBUM_RELEASE_PAGE_SIZE = 6
export const ALBUM_SOURCE_PAGE_SIZE = 20
export type AlbumSourceOrder = 'default' | 'local-first' | 'streaming-first'
export function albumProviderOrder(
  order: AlbumSourceOrder,
  providers: string[]
): string[] | undefined {
  if (order === 'default') return undefined
  if (order === 'local-first') return ['local']
  return [...new Set(providers)].filter((provider) => provider !== 'local').sort()
}
export const albumProviderLabel = (provider: string) => (provider === 'local' ? '本地' : provider)
export const albumAvailabilityLabel = (value: string) =>
  ({ indexed: '已索引，播放时检查', unknown: '待检查', missing: '来源缺失' })[value] ?? value

interface State {
  page: AlbumBrowsePage | null
  sources: AlbumSourcesPage | null
  selectedReleaseId: string | null
  loading: boolean
  loadingSources: boolean
  blocked: boolean
  error: string
  sourceError: string
  playingId: string | null
  playError: string
  playNotice: string
  playResult: UnifiedPlaybackResult | null
}
const empty = (): State => ({
  page: null,
  sources: null,
  selectedReleaseId: null,
  loading: false,
  loadingSources: false,
  blocked: false,
  error: '',
  sourceError: '',
  playingId: null,
  playError: '',
  playNotice: '',
  playResult: null
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const stale = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'STALE_REVISION'
const sameToken = (a: GenreBrowseToken, b: GenreBrowseToken) =>
  Object.keys(a).every(
    (key) => a[key as keyof GenreBrowseToken] === b[key as keyof GenreBrowseToken]
  )

/** Frozen, paged reads. A stale page cannot supply a playback source. */
export function createAlbumVersionsView(api: {
  browse(query: AlbumBrowseQuery, signal: AbortSignal): Promise<AlbumBrowsePage>
  sources(query: AlbumSourcesQuery, signal: AbortSignal): Promise<AlbumSourcesPage>
  play(sourceId: string, revision: number, signal: AbortSignal): Promise<unknown>
  playUnified(
    sourceId: string,
    revision: number,
    scope: AlbumBrowseScope,
    signal: AbortSignal,
    providerOrder?: string[]
  ): Promise<UnifiedPlaybackResult>
}) {
  const state = shallowRef<State>(empty())
  const busy = computed(() => state.value.loading || state.value.loadingSources)
  const ready = computed(() => !busy.value && !state.value.blocked && !!state.value.page)
  let entityId: string | null = null,
    scope = '',
    disposed = false,
    generation = 0
  let pageRequest: AbortController | null = null,
    sourceRequest: AbortController | null = null,
    playRequest: AbortController | null = null,
    expiryTimer: ReturnType<typeof setTimeout> | null = null
  function clearExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
  }
  function abortReads() {
    pageRequest?.abort()
    sourceRequest?.abort()
    pageRequest = null
    sourceRequest = null
  }
  function cancelPlayback() {
    playRequest?.abort()
    playRequest = null
    state.value = { ...state.value, playingId: null }
  }
  function invalidate() {
    if (disposed || (!state.value.page && !busy.value)) return
    generation++
    clearExpiry()
    abortReads()
    cancelPlayback()
    state.value = {
      ...state.value,
      page: null,
      sources: null,
      loading: false,
      loadingSources: false,
      blocked: true,
      error: '音乐库或身份资料已更新，请重新读取；已保留所选发行。',
      sourceError: '',
      playResult: null,
      playError: '',
      playNotice: ''
    }
  }
  function acceptToken(token: GenreBrowseToken) {
    if (token.expiresAt !== null && Date.now() >= token.expiresAt) {
      invalidate()
      return false
    }
    clearExpiry()
    if (token.expiresAt !== null)
      expiryTimer = setTimeout(invalidate, Math.max(1, token.expiresAt - Date.now()))
    return true
  }
  async function loadSources(releaseId: string, offset = 0) {
    const page = state.value.page
    if (!entityId || !page || state.value.blocked || disposed) return
    cancelPlayback()
    sourceRequest?.abort()
    const request = new AbortController(),
      currentGeneration = generation
    sourceRequest = request
    state.value = {
      ...state.value,
      selectedReleaseId: releaseId,
      sources: null,
      loadingSources: true,
      sourceError: '',
      playResult: null,
      playError: '',
      playNotice: ''
    }
    try {
      const sources = await api.sources(
        { entityId, releaseId, offset, limit: ALBUM_SOURCE_PAGE_SIZE, token: page.token },
        request.signal
      )
      if (disposed || request !== sourceRequest || currentGeneration !== generation) return
      if (!sameToken(page.token, sources.token) || !acceptToken(sources.token)) {
        invalidate()
        return
      }
      state.value = { ...state.value, sources, loadingSources: false }
    } catch (error) {
      if (!disposed && request === sourceRequest && currentGeneration === generation) {
        if (stale(error)) invalidate()
        else state.value = { ...state.value, loadingSources: false, sourceError: message(error) }
      }
    }
  }
  async function load(offset = 0, fresh = false) {
    if (!entityId || disposed || (state.value.blocked && !fresh)) return
    if (fresh) clearExpiry()
    abortReads()
    cancelPlayback()
    const request = new AbortController(),
      currentGeneration = ++generation,
      token = fresh ? undefined : state.value.page?.token
    pageRequest = request
    state.value = {
      ...state.value,
      page: null,
      sources: null,
      loading: true,
      loadingSources: false,
      blocked: false,
      error: '',
      sourceError: '',
      playResult: null,
      playError: '',
      playNotice: ''
    }
    try {
      const page = await api.browse(
        { entityId, offset, limit: ALBUM_RELEASE_PAGE_SIZE, token },
        request.signal
      )
      if (disposed || request !== pageRequest || currentGeneration !== generation) return
      if ((token && !sameToken(token, page.token)) || !acceptToken(page.token)) {
        invalidate()
        return
      }
      state.value = { ...state.value, page, loading: false }
      const selected = state.value.selectedReleaseId ?? page.currentRelease?.id ?? null
      if (selected) await loadSources(selected)
    } catch (error) {
      if (!disposed && request === pageRequest && currentGeneration === generation) {
        if (stale(error)) invalidate()
        else state.value = { ...state.value, loading: false, error: message(error) }
      }
    }
  }
  async function play(sourceId: string, unified = false, providerOrder?: string[]) {
    const page = state.value.sources
    if (
      !ready.value ||
      !page ||
      state.value.playingId ||
      !page.items.some((source) => source.sourceId === sourceId)
    )
      return
    if (!acceptToken(page.token)) return
    const request = new AbortController(),
      currentGeneration = generation
    playRequest = request
    state.value = {
      ...state.value,
      playingId: sourceId,
      playError: '',
      playResult: null,
      playNotice: ''
    }
    try {
      const result = unified
        ? await api.playUnified(
            sourceId,
            page.token.catalogRevision,
            {
              entityId: entityId!,
              releaseId: state.value.selectedReleaseId!,
              token: page.token
            },
            request.signal,
            providerOrder
          )
        : await api.play(sourceId, page.token.catalogRevision, request.signal)
      if (!disposed && playRequest === request && currentGeneration === generation)
        state.value = {
          ...state.value,
          playingId: null,
          playResult: unified ? (result as UnifiedPlaybackResult) : null,
          playNotice: unified ? '' : '已按所选音源开始播放。'
        }
    } catch (error) {
      if (!disposed && playRequest === request && currentGeneration === generation) {
        if (stale(error)) invalidate()
        else state.value = { ...state.value, playingId: null, playError: message(error) }
      }
    } finally {
      if (playRequest === request) playRequest = null
    }
  }
  return {
    state,
    busy,
    ready,
    async setContext(id: string | null, nextScope: string) {
      if (disposed || (entityId === id && scope === nextScope)) return
      generation++
      abortReads()
      clearExpiry()
      cancelPlayback()
      entityId = id
      scope = nextScope
      state.value = empty()
      if (id) await load(0, true)
    },
    refresh: () => load(0, true),
    page: (offset: number) => load(Math.max(0, offset)),
    select: (releaseId: string) => {
      if (ready.value && state.value.page?.items.some((release) => release.id === releaseId)) {
        cancelPlayback()
        return loadSources(releaseId)
      }
      return Promise.resolve()
    },
    sourcePage: (offset: number) =>
      state.value.selectedReleaseId
        ? loadSources(state.value.selectedReleaseId, Math.max(0, offset))
        : Promise.resolve(),
    play,
    cancelPlayback,
    invalidate,
    dispose() {
      disposed = true
      generation++
      clearExpiry()
      abortReads()
      cancelPlayback()
    }
  }
}
