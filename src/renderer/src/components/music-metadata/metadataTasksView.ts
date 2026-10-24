import { shallowRef } from 'vue'
import type {
  MetadataTasksQuery,
  MetadataTasksPage,
  MetadataTaskDemandsQuery,
  MetadataTaskDemandsPage,
  MetadataTaskFilter
} from '../../../../shared/entityMetadataTasks.ts'

export const METADATA_TASK_PAGE_SIZE = 10
export const METADATA_DEMAND_PAGE_SIZE = 6
interface State {
  page: MetadataTasksPage | null
  counts: MetadataTasksPage['counts'] | null
  demands: MetadataTaskDemandsPage | null
  selectedId: string | null
  filter: MetadataTaskFilter
  batchId: string | null
  loading: boolean
  demandsLoading: boolean
  cancelling: boolean
  error: string
  actionError: string
}
export function createMetadataTasksView(api: {
  tasks(query: MetadataTasksQuery, signal: AbortSignal): Promise<MetadataTasksPage>
  demands(query: MetadataTaskDemandsQuery, signal: AbortSignal): Promise<MetadataTaskDemandsPage>
  cancel(jobId: string, batchId: string, generation: number): Promise<unknown>
}) {
  const state = shallowRef<State>({
    page: null,
    counts: null,
    demands: null,
    selectedId: null,
    filter: 'all',
    batchId: null,
    loading: false,
    demandsLoading: false,
    cancelling: false,
    error: '',
    actionError: ''
  })
  let disposed = false,
    context = 0
  let listRequest: AbortController | null = null,
    demandsRequest: AbortController | null = null
  async function load(offset = state.value.page?.offset ?? 0): Promise<void> {
    if (disposed) return
    listRequest?.abort()
    const current = new AbortController()
    listRequest = current
    state.value = { ...state.value, loading: true, error: '' }
    try {
      const page = await api.tasks(
        {
          filter: state.value.filter,
          offset,
          limit: METADATA_TASK_PAGE_SIZE,
          ...(state.value.batchId ? { batchId: state.value.batchId } : {})
        },
        current.signal
      )
      if (disposed || listRequest !== current) return
      if (offset > 0 && offset >= page.total) return load(0)
      state.value = { ...state.value, page, counts: page.counts, loading: false }
      if (state.value.selectedId && !page.items.some((item) => item.id === state.value.selectedId))
        select(null)
    } catch (error) {
      if (!disposed && listRequest === current)
        state.value = {
          ...state.value,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
    }
  }
  async function loadDemands(offset = state.value.demands?.offset ?? 0): Promise<void> {
    const jobId = state.value.selectedId
    if (disposed || !jobId) return
    demandsRequest?.abort()
    const current = new AbortController()
    demandsRequest = current
    state.value = { ...state.value, demandsLoading: true }
    try {
      const demands = await api.demands(
        { jobId, offset, limit: METADATA_DEMAND_PAGE_SIZE },
        current.signal
      )
      if (disposed || demandsRequest !== current) return
      if (offset > 0 && offset >= demands.total) return loadDemands(0)
      state.value = { ...state.value, demands, demandsLoading: false }
    } catch (error) {
      if (!disposed && demandsRequest === current)
        state.value = {
          ...state.value,
          demands: null,
          demandsLoading: false,
          actionError: error instanceof Error ? error.message : String(error)
        }
    }
  }
  function select(jobId: string | null) {
    if (disposed || (jobId && !state.value.page?.items.some((item) => item.id === jobId))) return
    demandsRequest?.abort()
    demandsRequest = null
    state.value = {
      ...state.value,
      selectedId: jobId,
      demands: null,
      demandsLoading: false,
      actionError: ''
    }
    if (jobId) void loadDemands(0)
  }
  return {
    state,
    select,
    async refresh() {
      await Promise.all([load(), loadDemands()])
    },
    page(offset: number) {
      select(null)
      return load(offset)
    },
    demandsPage: loadDemands,
    filter(filter: MetadataTaskFilter, batchId = state.value.batchId) {
      select(null)
      state.value = { ...state.value, filter, batchId, page: null }
      return load(0)
    },
    reset() {
      context++
      listRequest?.abort()
      listRequest = null
      demandsRequest?.abort()
      demandsRequest = null
      state.value = {
        ...state.value,
        page: null,
        counts: null,
        selectedId: null,
        batchId: null,
        demands: null,
        loading: false,
        demandsLoading: false,
        cancelling: false,
        error: '',
        actionError: ''
      }
    },
    async cancel(batchId: string) {
      const { selectedId, demands, cancelling, loading, demandsLoading } = state.value
      const job = state.value.page?.items.find((item) => item.id === selectedId)
      if (
        disposed ||
        !selectedId ||
        cancelling ||
        loading ||
        demandsLoading ||
        !job ||
        state.value.error ||
        !demands?.items.some((item) => item.batchId === batchId && item.canCancel)
      )
        return
      const originalContext = context
      state.value = { ...state.value, cancelling: true, actionError: '' }
      let error = ''
      try {
        await api.cancel(selectedId, batchId, job.generation)
      } catch {
        error = '取消结果尚未确认，请核对重新读取的当前需求。'
      }
      if (disposed || context !== originalContext) return
      // Never replay an uncertain write. Read the persisted state instead.
      await Promise.all([load(), loadDemands()])
      if (!disposed && context === originalContext)
        state.value = {
          ...state.value,
          cancelling: false,
          actionError: error || state.value.actionError
        }
    },
    dispose() {
      disposed = true
      context++
      listRequest?.abort()
      demandsRequest?.abort()
      listRequest = null
      demandsRequest = null
    }
  }
}

export const metadataTaskStateLabel = {
  queued: '排队中',
  running: '进行中',
  retry_wait: '等待重试',
  needs_review: '待复核',
  blocked: '受阻',
  failed: '失败',
  completed: '已完成',
  cancelled: '已取消'
} as const
export const metadataTaskTypeLabel = {
  identify: '身份识别',
  resolve: '身份核对',
  enrich: '资料补全',
  legacy: '历史资料查询'
} as const
const reasons: Record<string, string> = {
  metadata_disabled: '音乐资料服务已关闭',
  automatic_enrichment_disabled: '自动补资料已关闭',
  automatic_identification_disabled: '自动身份识别已关闭',
  provider_not_available: '资料源当前不可用',
  provider_configuration_changed: '资料源账号或配置已变化',
  public_service_not_approved: '尚未批准使用公共元数据服务',
  missing_application_contact: '公共服务缺少应用联系信息',
  platform_metadata_cache_not_approved: '尚未取得平台资料缓存许可',
  platform_metadata_permission_expired: '平台资料使用许可已到期',
  metadata_capability_not_supported: '资料源不支持此类资料',
  metadata_connection_or_response_error: '连接中断或资料响应无效',
  metadata_response_invalid: '资料响应无效',
  input_changed: '识别依据已变化，需要重新查询',
  matcher_version_changed: '识别规则已更新，需要重新查询'
}
export const metadataTaskReasonLabel = (reason: string) => reasons[reason] ?? reason
