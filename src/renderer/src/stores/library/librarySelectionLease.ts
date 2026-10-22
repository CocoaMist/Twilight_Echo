import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import { selectionContains } from '../../../../shared/librarySelectionRanges.ts'
import type {
  LibrarySelectionBridgeApi,
  LibrarySelectionPage,
  LibrarySelectionRequest
} from '../../../../shared/librarySelection.ts'

/** One explicit action owns a frozen intent. Pages are consumed serially and
 * never accumulated here. Cancellation/unknown replies never replay an action. */
export async function openLibrarySelectionLease(
  api: LibrarySelectionBridgeApi,
  request: LibrarySelectionRequest,
  signal?: AbortSignal
) {
  request = structuredClone(request)
  const id = crypto.randomUUID()
  let closed = false,
    closeTask: Promise<void> | undefined
  function close(): Promise<void> {
    closed = true
    signal?.removeEventListener('abort', abort)
    closeTask ??= api.selection({ kind: 'close', id }).then((reply) => {
      if (reply.kind !== 'closed' || reply.id !== id) throw new Error('选择会话释放回复无效')
    })
    return closeTask
  }
  function check(): void {
    if (closed || signal?.aborted) throw new Error('选择操作已取消')
  }
  function abort(): void {
    void close().catch(() => {})
  }
  check()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const reply = await api.selection({ kind: 'open', id, request })
    check()
    if (
      reply.kind !== 'ready' ||
      reply.id !== id ||
      reply.snapshot.id !== id ||
      reply.snapshot.revision !== request.query.contentRevision ||
      reply.snapshot.historyRevision !==
        (request.query.sort === 'lastPlayed' ? request.query.historyRevision : undefined) ||
      reply.snapshot.total !== request.total ||
      !Number.isSafeInteger(reply.snapshot.localTrackCount) ||
      reply.snapshot.localTrackCount < 0 ||
      reply.snapshot.localTrackCount > reply.snapshot.selectedCount ||
      !Number.isSafeInteger(reply.snapshot.fileCount) ||
      reply.snapshot.fileCount < 0 ||
      reply.snapshot.fileCount > reply.snapshot.localTrackCount ||
      reply.snapshot.selectedCount !==
        request.ranges.reduce((n, [start, end]) => n + end - start, 0)
    )
      throw new Error('选择快照与当前请求不一致')
    const snapshot = reply.snapshot
    let consuming = false,
      failed = false
    async function forEachPage(
      visit: (page: LibrarySelectionPage) => void | Promise<void>,
      projection: 'tracks' | 'files' = 'tracks'
    ): Promise<number> {
      check()
      if (failed) throw new Error('选择操作已中断，请重新选择')
      if (consuming) throw new Error('选择批次正在读取')
      consuming = true
      let cursor: number | null = 0,
        count = 0,
        lastPosition = -1
      try {
        do {
          check()
          const reply = await api.selection({ kind: 'read', id, cursor, projection })
          check()
          if (
            reply.kind !== 'page' ||
            reply.id !== id ||
            reply.page.snapshot.id !== id ||
            reply.page.snapshot.revision !== snapshot.revision ||
            reply.page.snapshot.selectedCount !== snapshot.selectedCount ||
            reply.page.snapshot.total !== snapshot.total ||
            reply.page.snapshot.localTrackCount !== snapshot.localTrackCount ||
            reply.page.snapshot.fileCount !== snapshot.fileCount ||
            reply.page.snapshot.historyRevision !== snapshot.historyRevision ||
            reply.page.rows.length > LIBRARY_PAGE_SIZE ||
            (reply.page.nextCursor !== null && reply.page.rows.length === 0) ||
            (reply.page.nextCursor !== null &&
              (!Number.isSafeInteger(reply.page.nextCursor) ||
                reply.page.nextCursor <= cursor ||
                reply.page.nextCursor >= snapshot.selectedCount))
          )
            throw new Error('选择批次已失效')
          count += reply.page.rows.length
          const expected = projection === 'files' ? snapshot.fileCount : snapshot.selectedCount
          if (count > expected || (reply.page.nextCursor === null && count !== expected))
            throw new Error('选择批次不完整，操作已中断')
          for (const row of reply.page.rows) {
            if (
              !Number.isSafeInteger(row.position) ||
              row.position <= lastPosition ||
              !selectionContains(request.ranges, row.position)
            )
              throw new Error('选择批次位置已失效')
            lastPosition = row.position
          }
          await visit(reply.page)
          check()
          cursor = reply.page.nextCursor
        } while (cursor !== null)
        if (count !== (projection === 'files' ? snapshot.fileCount : snapshot.selectedCount))
          throw new Error('选择批次不完整，操作已中断')
        return count
      } catch (error) {
        failed = true
        throw error
      } finally {
        consuming = false
      }
    }
    return { snapshot, forEachPage, close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
