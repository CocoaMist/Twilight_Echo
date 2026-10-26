import { shallowReadonly, shallowRef, watch } from 'vue'
import type { NcmCloudTransferProgress } from '../../../shared/ncmCloud.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreCloudTransferPage } from '../../../shared/coreCloudTransfer.ts'
import type { ShallowRef } from 'vue'

/** Transfer work is never tied to this projection's lifetime or account UI reset. */
export function createCoreCloudTransfers(options: {
  state: Readonly<ShallowRef<CoreSnapshot | null>>
  page(revision: number, offset: number, signal: AbortSignal): Promise<CoreCloudTransferPage>
  completed(task: NcmCloudTransferProgress): void
  failed(error: unknown): void
}) {
  const tasks = shallowRef<Record<string, NcmCloudTransferProgress>>({})
  let active: AbortController | null = null
  const key = () => {
    const state = options.state.value
    return state?.phase === 'ready' && state.cloudTransfers
      ? `${state.epoch}:${state.cloudTransfers.revision}`
      : ''
  }
  const dispose = watch(
    key,
    async (expected) => {
      active?.abort()
      if (!expected) {
        tasks.value = {}
        return
      }
      const request = (active = new AbortController())
      const revision = options.state.value!.cloudTransfers!.revision
      const next: Record<string, NcmCloudTransferProgress> = {}
      try {
        for (let offset = 0; ; offset += 200) {
          const page = await options.page(revision, offset, request.signal)
          if (request.signal.aborted || key() !== expected) return
          for (const task of page.items) next[task.transferId] = task
          if (offset + 200 >= page.total) break
        }
        for (const task of Object.values(next)) {
          const previous = tasks.value[task.transferId]
          if (task.stage === 'completed' && previous && previous.stage !== 'completed')
            options.completed(task)
        }
        tasks.value = next
      } catch (error) {
        if (!request.signal.aborted && key() === expected) options.failed(error)
      }
    },
    { immediate: true, flush: 'sync' }
  )
  return {
    tasks: shallowReadonly(tasks),
    dispose() {
      active?.abort()
      dispose()
    }
  }
}
