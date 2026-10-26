import { computed, shallowReadonly, shallowRef, watch, type ShallowRef } from 'vue'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreStatisticsOverview, CoreStatisticsPage, CoreStatisticsQuery, CoreStatisticsTrackView } from '../../../shared/coreStatistics.ts'
import type { ListeningStatsClearRange } from '../../../shared/listeningStatsHistory.ts'

/** Bounded ranking windows are views; totals, artists and clearing use the full Core repository. */
export function createCoreListeningStats(options: {
  state: Readonly<ShallowRef<CoreSnapshot | null>>
  overview(signal: AbortSignal): Promise<CoreStatisticsOverview>
  page(query: CoreStatisticsQuery, signal: AbortSignal): Promise<CoreStatisticsPage>
  clear(range: ListeningStatsClearRange, revision: number): Promise<unknown>
}) {
  const overview = shallowRef<CoreStatisticsOverview | null>(null)
  const windows = shallowRef<Record<'recent' | 'plays' | 'seconds', CoreStatisticsTrackView[]>>({ recent: [], plays: [], seconds: [] })
  const error = shallowRef('')
  let active: AbortController | null = null
  let work: Promise<void> | null = null
  let disposed = false
  const key = () => {
    const state = options.state.value
    return state?.phase === 'ready' && state.statisticsRevision !== null
      ? `${state.epoch}:${state.statisticsRevision}` : ''
  }
  function refresh(): Promise<void> {
    active?.abort()
    const expected = key()
    if (!expected || disposed) {
      overview.value = null
      windows.value = { recent: [], plays: [], seconds: [] }
      return Promise.resolve()
    }
    const request = active = new AbortController()
    const task = (async () => {
      try {
        const summary = await options.overview(request.signal)
        const sorts = ['recent', 'plays', 'seconds'] as const
        const pages = await Promise.all(sorts.map((sort) => options.page({ sort, limit: 200, revision: summary.revision }, request.signal)))
        if (request.signal.aborted || key() !== expected || disposed) return
        overview.value = freeze(summary)
        windows.value = freeze({ recent: pages[0].items, plays: pages[1].items, seconds: pages[2].items })
        error.value = ''
      } catch (failure) {
        if (!request.signal.aborted && key() === expected && !disposed) {
          error.value = failure instanceof Error ? failure.message : String(failure)
          throw failure
        }
      }
    })().finally(() => { if (work === task) work = null })
    work = task
    return task
  }
  const stop = watch(key, () => { void refresh().catch(() => {}) }, { immediate: true, flush: 'sync' })
  return {
    overview: shallowReadonly(overview), windows: shallowReadonly(windows), error: shallowReadonly(error),
    ready: computed(() => overview.value !== null && !error.value),
    async ensure() {
      await (work ?? (overview.value ? Promise.resolve() : refresh()))
      if (error.value) throw new Error(error.value)
    },
    refresh,
    async clear(range: ListeningStatsClearRange, revision?: number): Promise<boolean> {
      if (!overview.value) throw new Error('聆听统计尚未就绪')
      await options.clear(range, revision ?? overview.value.revision)
      await refresh()
      return !overview.value?.persistence.dirty
    },
    dispose() { disposed = true; active?.abort(); stop() }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
