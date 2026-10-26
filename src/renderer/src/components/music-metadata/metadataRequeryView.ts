import { shallowRef } from 'vue'
import {
  METADATA_REQUERY_STATES,
  type MetadataTaskItem,
  type MetadataTaskSource,
  type MetadataTaskSourcesPage,
  type MetadataTaskSourcesQuery,
  type MetadataTaskRequery,
  type MetadataTaskRequeryItem
} from '../../../../shared/entityMetadataTasks.ts'

export const METADATA_REQUERY_SOURCE_PAGE_SIZE = 6
export const canRequeryMetadataTask = (task: MetadataTaskItem) =>
  task.type === 'enrich' && METADATA_REQUERY_STATES.some((state) => state === task.state)
interface State {
  sources: Record<string, MetadataTaskSourcesPage>
  selected: Record<string, MetadataTaskSource>
  loading: Record<string, boolean>
  errors: Record<string, string>
  submitting: boolean
  message: string
}
export function createMetadataRequeryView(api: {
  sources(query: MetadataTaskSourcesQuery, signal: AbortSignal): Promise<MetadataTaskSourcesPage>
  requery(request: MetadataTaskRequery): Promise<unknown>
  status(batchId: string): Promise<{ total: number }>
  demandId(): string
  changed(): void
}) {
  const initial = (): State => ({
    sources: {},
    selected: {},
    loading: {},
    errors: {},
    submitting: false,
    message: ''
  })
  const state = shallowRef<State>(initial())
  let tasks: MetadataTaskItem[] = [],
    batchId: string | undefined,
    identity = '',
    generation = 0,
    disposed = false
  const requests = new Map<string, AbortController>()
  const clear = () => {
    generation++
    for (const request of requests.values()) request.abort()
    requests.clear()
    state.value = initial()
  }
  return {
    state,
    context(next: MetadataTaskItem[], batch: string | null, scope: string) {
      const key = JSON.stringify([scope, batch, next.map((t) => [t.id, t.generation, t.state])])
      if (disposed || key === identity) return
      clear()
      tasks = next
      batchId = batch ?? undefined
      identity = key
    },
    async sources(jobId: string, offset = 0): Promise<void> {
      const task = tasks.find((t) => t.id === jobId)
      if (disposed || state.value.submitting || !task || !canRequeryMetadataTask(task)) return
      requests.get(jobId)?.abort()
      const request = new AbortController(),
        context = generation
      requests.set(jobId, request)
      state.value = {
        ...state.value,
        loading: { ...state.value.loading, [jobId]: true },
        errors: { ...state.value.errors, [jobId]: '' }
      }
      try {
        const page = await api.sources(
          { jobId, offset, limit: METADATA_REQUERY_SOURCE_PAGE_SIZE },
          request.signal
        )
        if (disposed || context !== generation || requests.get(jobId) !== request) return
        if (page.generation !== task.generation)
          throw new Error('任务已变化，请重新读取任务后再选择。')
        state.value = { ...state.value, sources: { ...state.value.sources, [jobId]: page } }
      } catch (error) {
        if (!disposed && context === generation && requests.get(jobId) === request)
          state.value = {
            ...state.value,
            errors: {
              ...state.value.errors,
              [jobId]: error instanceof Error ? error.message : String(error)
            }
          }
      } finally {
        if (!disposed && context === generation && requests.get(jobId) === request) {
          requests.delete(jobId)
          state.value = { ...state.value, loading: { ...state.value.loading, [jobId]: false } }
        }
      }
    },
    select(jobId: string, entityId: string) {
      if (
        disposed ||
        state.value.submitting ||
        state.value.loading[jobId] ||
        state.value.errors[jobId]
      )
        return
      const source = state.value.sources[jobId]?.items.find((item) => item.entity.id === entityId)
      if (!source) return
      const selected = { ...state.value.selected }
      if (selected[jobId]?.entity.id === entityId) delete selected[jobId]
      else selected[jobId] = source
      state.value = { ...state.value, selected }
    },
    async submit() {
      if (disposed || state.value.submitting || Object.values(state.value.loading).some(Boolean))
        return
      const items: MetadataTaskRequeryItem[] = []
      if (
        Object.keys(state.value.selected).some(
          (id) =>
            !tasks.some((task) => task.id === id && canRequeryMetadataTask(task)) ||
            state.value.errors[id] ||
            state.value.loading[id]
        )
      ) {
        state.value = { ...state.value, message: '所选条目存在读取错误，请重新读取来源后再提交。' }
        return
      }
      for (const task of tasks) {
        const source = state.value.selected[task.id]
        if (!source || !canRequeryMetadataTask(task) || state.value.errors[task.id]) continue
        items.push({
          jobId: task.id,
          generation: task.generation,
          entityId: source.entity.id,
          inputVersion: source.inputVersion,
          linkRevision: source.linkRevision
        })
      }
      if (!items.length || items.length > 10) return
      const demandId = api.demandId(),
        context = generation
      state.value = { ...state.value, submitting: true, message: '' }
      let message = ''
      try {
        await api.requery({ items, demandId, ...(batchId ? { batchId } : {}) })
        message = `已建立 ${items.length} 项重新查询需求。`
      } catch (error) {
        try {
          const page = await api.status(demandId)
          message =
            page.total === items.length
              ? `已核对：${items.length} 项新需求已保存。`
              : `重新查询结果未确认，请重新读取任务后核对。${error instanceof Error ? error.message : String(error)}`
        } catch {
          message = `重新查询结果未确认，请稍后核对需求批次 ${demandId}。`
        }
      }
      if (disposed || context !== generation) return
      state.value = { ...state.value, selected: {}, submitting: false, message }
      api.changed()
    },
    dispose() {
      disposed = true
      clear()
    }
  }
}
