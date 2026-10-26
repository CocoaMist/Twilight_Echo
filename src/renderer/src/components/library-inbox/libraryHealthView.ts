import { shallowRef } from 'vue'
import type {
  HealthCategory,
  HealthIssueState,
  LibraryHealthPage,
  LibraryHealthPageQuery,
  LibraryHealthRepair,
  LibraryHealthState
} from '../../../../shared/libraryHealth.ts'

export const healthLabels: Record<HealthCategory, string> = {
  track_tags: '歌曲必要标签',
  track_cover: '歌曲封面',
  track_genre: '文件流派标签',
  artist_identity: '歌手身份',
  artist_name: '歌手规范名',
  artist_image: '歌手头像',
  artist_intro: '歌手简介',
  album_identity: '专辑作品身份',
  album_intro: '专辑作品简介',
  release_identity: '具体发行与版本'
}
export const healthStateLabels: Record<HealthIssueState, string> = {
  ready: '可自动补全',
  processing: '后台处理中',
  review: '待身份复核',
  unavailable: '资料源暂无内容',
  blocked: '资料源未就绪',
  failed: '查询失败，可重试',
  manual: '需手动整理'
}
export const HEALTH_PAGE_SIZE = 20
export function createLibraryHealthView(
  api: {
    status(): Promise<LibraryHealthState>
    start(): Promise<LibraryHealthState>
    repair(request: LibraryHealthRepair): Promise<LibraryHealthState>
    page(query: LibraryHealthPageQuery, signal: AbortSignal): Promise<LibraryHealthPage>
  },
  options: { findings?: boolean; scanOnOpen?: boolean } = {}
) {
  let findings = options.findings !== false
  const state = shallowRef<{
    snapshot: LibraryHealthState | null
    page: LibraryHealthPage | null
    category: HealthCategory | ''
    filter: HealthIssueState | ''
    offset: number
    loading: boolean
    error: string
  }>({
    snapshot: null,
    page: null,
    category: '',
    filter: '',
    offset: 0,
    loading: false,
    error: ''
  })
  let disposed = false,
    busy = false,
    version = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | null = null
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  async function loadPage() {
    const report = state.value.snapshot?.report
    if (!report || disposed || !findings) return
    request?.abort()
    const controller = new AbortController()
    request = controller
    try {
      const page = await api.page(
        {
          id: report.id,
          offset: state.value.offset,
          limit: HEALTH_PAGE_SIZE,
          ...(state.value.category ? { category: state.value.category } : {}),
          ...(state.value.filter ? { state: state.value.filter } : {})
        },
        controller.signal
      )
      if (!disposed && request === controller) state.value = { ...state.value, page, error: '' }
    } catch (error) {
      if (!disposed && request === controller)
        state.value = { ...state.value, error: message(error) }
    }
  }
  async function apply(snapshot: LibraryHealthState, context = version) {
    if (disposed || context !== version) return
    const changed = snapshot.report?.id !== state.value.snapshot?.report?.id
    state.value = { ...state.value, snapshot, ...(changed ? { page: null, offset: 0 } : {}) }
    if (changed || (!state.value.page && snapshot.report)) await loadPage()
    if (disposed || context !== version) return
    clearTimeout(timer)
    if (!disposed && ['scanning', 'repairing'].includes(snapshot.phase))
      timer = setTimeout(() => {
        void poll()
      }, 1200)
  }
  async function poll() {
    if (disposed || busy) return
    const current = version
    try {
      const snapshot = await api.status()
      if (current === version) await apply(snapshot, current)
    } catch (error) {
      if (!disposed && current === version) {
        state.value = { ...state.value, error: message(error) }
        timer = setTimeout(() => {
          void poll()
        }, 2500)
      }
    }
  }
  async function action(run: () => Promise<LibraryHealthState>) {
    if (disposed || busy) return
    busy = true
    version++
    clearTimeout(timer)
    state.value = { ...state.value, loading: true, error: '' }
    try {
      await apply(await run())
    } catch (error) {
      // A command acknowledgement may be lost. Inspect, never replay a write.
      try {
        await apply(await api.status())
      } catch {
        /* keep the original action error */
      }
      if (!disposed) state.value = { ...state.value, error: message(error) }
    } finally {
      busy = false
      if (!disposed) state.value = { ...state.value, loading: false }
    }
  }
  return {
    state,
    async open() {
      const current = version
      try {
        const snapshot = await api.status()
        if (disposed || current !== version) return
        if (snapshot.phase === 'idle' && options.scanOnOpen !== false) await action(api.start)
        else await apply(snapshot, current)
      } catch (error) {
        if (!disposed) state.value = { ...state.value, error: message(error) }
      }
    },
    refresh: () => action(api.start),
    complete: () => action(() => api.repair({ refresh: true })),
    findings(open: boolean) {
      findings = open
      if (!open) {
        request?.abort()
        request = null
        return Promise.resolve()
      }
      return loadPage()
    },
    repair(category?: HealthCategory) {
      const report = state.value.snapshot?.report
      if (report)
        return action(() => api.repair({ id: report.id, ...(category ? { category } : {}) }))
      return Promise.resolve()
    },
    filter(category: HealthCategory | '', filter: HealthIssueState | '' = '') {
      state.value = { ...state.value, category, filter, offset: 0, page: null }
      return loadPage()
    },
    page(offset: number) {
      state.value = { ...state.value, offset, page: null }
      return loadPage()
    },
    dispose() {
      disposed = true
      version++
      clearTimeout(timer)
      request?.abort()
    }
  }
}
