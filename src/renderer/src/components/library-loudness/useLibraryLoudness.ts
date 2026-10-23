import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type { LibrarySelectionRequest } from '../../../../shared/librarySelection.ts'
import type {
  CoreLoudnessPage,
  CoreLoudnessResult,
  CoreLoudnessState
} from '../../../../shared/coreAnalysis.ts'
import type { useCoreConnection } from '../../stores/coreConnection.ts'

export function useLibraryLoudness(
  selection: Ref<LibrarySelectionRequest>,
  mode: Ref<'track' | 'album'>,
  core: Pick<ReturnType<typeof useCoreConnection>, 'state' | 'subscribe' | 'command' | 'query' | 'attach'>
) {
  const plan = shallowRef<CoreLoudnessState | null>(null)
  const page = shallowRef<CoreLoudnessPage | null>(null)
  const results = shallowRef(new Map<number, CoreLoudnessResult>())
  const error = ref('')
  const busy = ref(false)
  const loading = ref(false)
  const running = computed(() => ['running', 'cancelling'].includes(plan.value?.status.state ?? ''))
  const retryGroups = computed(
    () =>
      !running.value &&
      !!plan.value &&
      (plan.value.status.failed > 0 || plan.value.status.state === 'cancelled')
  )
  let pageRequest = 0
  let resultController: AbortController | undefined
  const resultRequests = new Map<number, Promise<void>>()
  let disposed = false
  const adoptedRunningPlan = ref(false)
  const unsubscribe = core.subscribe((message) => {
    if (message.kind !== 'state') return
    const current = message.snapshot.libraryLoudness
    if (current?.id !== plan.value?.id) return
    plan.value = current
    void refreshPage(page.value?.offset ?? 0)
  })

  async function prepare(): Promise<void> {
    if (!core.state.value) await core.attach()
    const current = await core.query('library.loudness.state', {})
    if (current && ['running', 'cancelling'].includes(current.status.state)) {
      adoptedRunningPlan.value = true
      plan.value = current
      await refreshPage()
      return
    }
    const value = (await core.command('library.loudness.prepare', {
      selection: selection.value,
      mode: mode.value
    })) as CoreLoudnessState
    if (!disposed) {
      plan.value = value
      results.value = new Map()
      await refreshPage()
    }
  }

  async function refreshPage(offset = 0): Promise<void> {
    const current = plan.value
    if (!current || disposed) return
    const request = ++pageRequest
    resultController?.abort()
    const controller = (resultController = new AbortController())
    loading.value = true
    try {
      const value = await core.query(
        'library.loudness.page',
        { id: current.id, offset, limit: 200 },
        controller.signal
      )
      if (request !== pageRequest || disposed || plan.value?.id !== current.id) return
      page.value = value
      const next = new Map(results.value)
      for (const item of value.items) {
        if (!['completed', 'cached'].includes(item.state)) {
          next.delete(item.index)
          resultRequests.delete(item.index)
        }
      }
      results.value = next
      error.value = ''
    } catch (reason) {
      if (!controller.signal.aborted && request === pageRequest && !disposed)
        error.value = reason instanceof Error ? reason.message : String(reason)
    } finally {
      if (request === pageRequest) loading.value = false
    }
  }

  async function loadResults(indexes: number[]): Promise<void> {
    const current = plan.value
    if (!current || disposed) return
    await Promise.all(
      indexes.map(async (index) => {
        if (results.value.has(index) || resultRequests.has(index)) return
        const item = page.value?.items.find((candidate) => candidate.index === index)
        if (!item || !['completed', 'cached'].includes(item.state)) return
        const work = core
          .query('library.loudness.result', { id: current.id, index })
          .then((value) => {
            if (!disposed && plan.value?.id === current.id) {
              const next = new Map(results.value)
              next.set(index, value)
              results.value = next
            }
          })
          .catch((reason) => {
            if (!disposed && plan.value?.id === current.id)
              error.value = reason instanceof Error ? reason.message : String(reason)
          })
          .finally(() => resultRequests.delete(index))
        resultRequests.set(index, work)
        await work
      })
    )
  }

  async function action(operation: () => Promise<CoreLoudnessState | void>): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      const value = await operation()
      if (value && !disposed) plan.value = value
      await refreshPage(page.value?.offset ?? 0)
    } catch (reason) {
      if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
    } finally {
      busy.value = false
    }
  }

  const start = () =>
    action(async () => {
      if (!plan.value) return
      return (await core.command('library.loudness.start', {
        id: plan.value.id
      })) as CoreLoudnessState
    })
  const cancel = () =>
    action(async () => {
      if (!plan.value?.status.jobId) return
      return (await core.command('library.loudness.cancel', {
        id: plan.value.id
      })) as CoreLoudnessState
    })
  const clear = () =>
    action(async () => {
      if (!plan.value) return
      await core.command('library.loudness.clear', { id: plan.value.id })
      results.value = new Map()
      resultRequests.clear()
    })
  const reload = async () => {
    if (!plan.value) return prepare()
    await refreshPage(page.value?.offset ?? 0)
  }
  const retryAction = reload

  watch(
    [selection, mode],
    () => {
      if (running.value) return
      void prepare().catch((reason) => {
        if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
      })
    },
    { immediate: true }
  )
  onBeforeUnmount(() => {
    disposed = true
    pageRequest++
    resultController?.abort()
    unsubscribe()
  })

  return {
    plan,
    page,
    results,
    error,
    busy,
    loading,
    running,
    retryGroups,
    start,
    cancel,
    clear,
    reload,
    retryAction,
    refreshPage,
    loadResults,
    adoptedRunningPlan
  }
}
