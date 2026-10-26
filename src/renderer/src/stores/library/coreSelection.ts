import type {
  LibrarySelectionRequest,
  LibrarySelectionSnapshot
} from '../../../../shared/librarySelection.ts'
import type { CoreLibrarySelectionPage } from '../../../../shared/coreLibraryMaintenance.ts'
import { useCoreConnection } from '../coreConnection.ts'
export function coreLibrarySelectionApi(core = useCoreConnection()) {
  return {
    open: (request: LibrarySelectionRequest, signal?: AbortSignal) =>
      core.command('library.selection.open', request, signal) as Promise<LibrarySelectionSnapshot>,
    page: (id: string, cursor?: number, projection?: 'tracks' | 'files', signal?: AbortSignal) =>
      core.query('library.selection.page', { id, cursor, projection }, signal),
    close: (id: string) => core.command('library.selection.close', { id }).then(() => {})
  }
}
export type CoreLibrarySelectionApi = ReturnType<typeof coreLibrarySelectionApi>
export async function openCoreLibrarySelectionLease(
  api: CoreLibrarySelectionApi,
  request: LibrarySelectionRequest,
  signal?: AbortSignal
) {
  const snapshot = await api.open(request, signal)
  let closed = false
  const check = () => {
    signal?.throwIfAborted()
    if (closed) throw new Error('选择操作已取消')
  }
  return {
    snapshot,
    async forEachPage(
      visit: (page: CoreLibrarySelectionPage) => void | Promise<void>,
      projection: 'tracks' | 'files' = 'tracks'
    ) {
      let cursor: number | null = 0,
        count = 0
      do {
        check()
        const page = await api.page(snapshot.id, cursor, projection, signal)
        check()
        await visit(page)
        count += page.rows.length
        cursor = page.nextCursor
      } while (cursor !== null)
      return count
    },
    async close() {
      if (closed) return
      closed = true
      await api.close(snapshot.id)
    }
  }
}
