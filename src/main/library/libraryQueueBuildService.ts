import { randomUUID } from 'node:crypto'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import {
  LIBRARY_QUEUE_BUILD_IDLE_MS,
  LIBRARY_QUEUE_BUILD_MAX_ENTRIES,
  type LibraryQueueBuildCommand,
  type LibraryQueueBuildReply
} from '../../shared/libraryQueueBuild.ts'
import { validateLibraryQueueBuild } from './libraryDatabaseValidation.ts'
import type { RepairSessionOwner } from './libraryPlaylistRepairService.ts'

type Database = Pick<LibraryDatabaseApi, 'deleteLibraryQueue'> & {
  buildLibraryQueue(command: LibraryQueueBuildCommand): Promise<LibraryQueueBuildReply>
}
type Session = {
  id: string
  workerId: string
  owner: RepairSessionOwner
  sequence: number
  total: number
  closed: boolean
  pending?: Promise<LibraryQueueBuildReply>
  closing?: Promise<void>
  timer?: NodeJS.Timeout
  destroyed(): void
}

/** One uncommitted seed per window. No window can continue another window's
 * build or choose the ID of a persistent queue. Failed/uncertain writes are
 * retired, never replayed. Ready queues transfer to the existing queue owner. */
export class LibraryQueueBuildService {
  private readonly sessions = new Map<RepairSessionOwner, Session>()
  private stopped = false
  private readonly database: Database
  private readonly idleMs: number
  constructor(database: Database, idleMs = LIBRARY_QUEUE_BUILD_IDLE_MS) {
    this.database = database
    this.idleMs = idleMs
  }

  async handle(owner: RepairSessionOwner, input: unknown): Promise<LibraryQueueBuildReply> {
    if (this.stopped || owner.isDestroyed()) throw new Error('队列构建服务或窗口已关闭')
    let session = this.sessions.get(owner)
    try {
      validateLibraryQueueBuild(input)
    } catch (error) {
      // A malformed continuation poisons only its own lease, not another ID.
      if (session && input && typeof input === 'object' && 'id' in input && input.id === session.id)
        await this.discard(session).catch(() => {})
      throw error
    }
    if (input.kind === 'begin') {
      if (session?.closed) await this.discard(session)
      if (this.stopped || owner.isDestroyed()) throw new Error('队列构建服务或窗口已关闭')
      if (this.sessions.has(owner)) throw new Error('请先结束当前队列构建')
      if (this.sessions.size >= 4) throw new Error('队列构建过多，请稍后重试')
      session = {
        id: input.id,
        workerId: randomUUID(),
        owner,
        sequence: 0,
        total: 0,
        closed: false,
        destroyed: () => {
          void this.discard(session!).catch(() => {})
        }
      }
      this.sessions.set(owner, session)
      owner.once('destroyed', session.destroyed)
    } else {
      if (!session || session.id !== input.id) {
        if (!session && input.kind === 'abort') return { kind: 'aborted', id: input.id }
        throw new Error('队列构建已失效或不属于当前窗口')
      }
      if (input.kind === 'abort') {
        await this.discard(session)
        return { kind: 'aborted', id: input.id }
      }
      this.assertActive(session)
      if (session.pending) {
        await this.discard(session)
        throw new Error('请等待当前队列批次完成；构建已中止')
      }
      if (
        input.sequence !== session.sequence + 1 ||
        (input.kind === 'append' &&
          session.total + input.items.length > LIBRARY_QUEUE_BUILD_MAX_ENTRIES) ||
        (input.kind === 'commit' &&
          (session.total === 0
            ? input.selectedIndex !== -1
            : input.selectedIndex < 0 || input.selectedIndex >= session.total))
      ) {
        await this.discard(session)
        throw new Error('队列批次或选择位置已失效，请重新开始，不要重放批次')
      }
    }
    this.assertActive(session)
    clearTimeout(session.timer)
    // Keep only the actual worker call here: cleanup joins it, not handle(),
    // whose error path itself waits for cleanup.
    const command = { ...input, id: session.workerId }
    const pending = (session.pending = Promise.resolve().then(() => {
      this.assertActive(session!)
      return this.database.buildLibraryQueue(command)
    }))
    try {
      const reply = await pending
      this.assertActive(session)
      if (reply.kind === 'ready') {
        if (
          input.kind !== 'commit' ||
          reply.id !== session.workerId ||
          reply.queue.id !== session.workerId
        )
          throw new Error('队列构建返回无效，未切换播放来源')
        // Synchronous transfer: an abort after this point must not delete the
        // ready queue, even if its IPC reply is subsequently lost.
        this.release(session)
        return { ...reply, id: session.id }
      }
      const total = session.total + (input.kind === 'append' ? input.items.length : 0)
      const sequence = input.kind === 'begin' ? 0 : input.sequence
      if (
        reply.kind !== 'building' ||
        reply.id !== session.workerId ||
        reply.sequence !== sequence ||
        reply.total !== total
      )
        throw new Error('队列构建返回无效，请重新开始，不要重放批次')
      session.sequence = sequence
      session.total = total
      this.touch(session)
      return { ...reply, id: session.id }
    } catch (error) {
      await this.discard(session).catch(() => {})
      throw error
    } finally {
      if (session.pending === pending) session.pending = undefined
    }
  }

  destroy(): void {
    this.stopped = true
    for (const session of this.sessions.values()) void this.discard(session).catch(() => {})
  }

  private assertActive(session: Session): void {
    if (
      this.stopped ||
      session.closed ||
      session.owner.isDestroyed() ||
      this.sessions.get(session.owner) !== session
    )
      throw new Error('队列构建已取消，未切换播放来源')
  }
  private touch(session: Session): void {
    session.timer = setTimeout(() => {
      void this.discard(session).catch(() => {})
    }, this.idleMs)
    session.timer.unref?.()
  }
  private release(session: Session): void {
    session.closed = true
    clearTimeout(session.timer)
    session.owner.removeListener('destroyed', session.destroyed)
    if (this.sessions.get(session.owner) === session) this.sessions.delete(session.owner)
  }
  private discard(session: Session): Promise<void> {
    session.closed = true
    clearTimeout(session.timer)
    if (session.closing) return session.closing
    const cleanup = (async () => {
      const reply = await session.pending?.catch(() => undefined)
      // A known late commit was never handed to renderer. An unknown commit
      // may leave an unreferenced ready queue for normal GC, but is not retried.
      if (reply?.kind === 'ready' && reply.queue.id === session.workerId)
        await this.database.deleteLibraryQueue(reply.queue.id, reply.queue.revision)
      else await this.database.buildLibraryQueue({ kind: 'abort', id: session.workerId })
      this.release(session)
    })()
    session.closing = cleanup
    void cleanup.catch(() => {
      if (session.closing === cleanup) session.closing = undefined
    })
    return cleanup
  }
}
