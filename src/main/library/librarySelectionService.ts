import type {
  LibrarySelectionApi,
  LibrarySelectionCommand,
  LibrarySelectionReply,
  LibrarySelectionSnapshot
} from '../../shared/librarySelection.ts'
import { validateLibrarySelection } from './libraryDatabaseSelections.ts'
import type { RepairSessionOwner } from './libraryPlaylistRepairService.ts'

type Session = {
  id: string
  owner: RepairSessionOwner
  pending?: Promise<LibrarySelectionSnapshot>
  workerId?: string
  closed: boolean
  reading: boolean
  closing?: Promise<void>
  timer?: NodeJS.Timeout
  destroyed(): void
}

/** Selection reads grant no file/mutation authority. One bounded lease per
 * window; destruction, explicit cancellation and expiry fence late replies. */
export class LibrarySelectionService {
  private readonly sessions = new Map<RepairSessionOwner, Session>()
  private readonly database: LibrarySelectionApi
  private readonly idleMs: number
  private destroyed = false
  constructor(database: LibrarySelectionApi, idleMs = 120_000) {
    this.database = database
    this.idleMs = idleMs
  }

  async handle(owner: RepairSessionOwner, input: unknown): Promise<LibrarySelectionReply> {
    this.validate(input)
    if (this.destroyed) throw new Error('选择服务已关闭')
    if (owner.isDestroyed()) throw new Error('选择窗口已关闭')
    if (input.kind === 'open') {
      const previous = this.sessions.get(owner)
      if (previous?.closed) await this.discard(previous)
      if (this.destroyed || owner.isDestroyed()) throw new Error('选择服务或窗口已关闭')
      if (this.sessions.has(owner)) throw new Error('请先结束当前选择操作')
      if (this.sessions.size >= 4) throw new Error('选择操作过多，请稍后重试')
      validateLibrarySelection(input.request)
      const session: Session = {
        id: input.id,
        owner,
        closed: false,
        reading: false,
        destroyed: () => {
          void this.discard(session).catch(() => {})
        }
      }
      this.sessions.set(owner, session)
      owner.once('destroyed', session.destroyed)
      const pending = (session.pending = Promise.resolve().then(() => {
        this.assertActive(session)
        return this.database.createTrackSelection(input.request)
      }))
      try {
        const snapshot = await pending
        session.workerId = snapshot.id
        this.assertActive(session)
        this.touch(session)
        return { kind: 'ready', id: session.id, snapshot: { ...snapshot, id: session.id } }
      } catch (error) {
        await this.discard(session).catch(() => {})
        throw error
      }
    }
    const session = this.sessions.get(owner)
    if (!session || session.id !== input.id) {
      if (!session && input.kind === 'close') return { kind: 'closed', id: input.id }
      throw new Error('选择会话已失效或不属于当前窗口')
    }
    if (input.kind === 'close') {
      await this.discard(session)
      return { kind: 'closed', id: input.id }
    }
    this.assertActive(session)
    if (!session.workerId || session.reading) throw new Error('选择批次尚未完成')
    session.reading = true
    clearTimeout(session.timer)
    try {
      const page = await this.database.readTrackSelection(
        session.workerId,
        input.cursor,
        input.projection
      )
      this.assertActive(session)
      this.touch(session)
      return {
        kind: 'page',
        id: session.id,
        page: { ...page, snapshot: { ...page.snapshot, id: session.id } }
      }
    } finally {
      session.reading = false
      if (!session.closed) this.touch(session)
    }
  }
  destroy(): void {
    this.destroyed = true
    for (const session of this.sessions.values()) {
      session.closed = true
      clearTimeout(session.timer)
      session.owner.removeListener('destroyed', session.destroyed)
      void this.discard(session).catch(() => {})
    }
    this.sessions.clear()
  }
  private assertActive(session: Session): void {
    if (
      this.destroyed ||
      session.closed ||
      session.owner.isDestroyed() ||
      this.sessions.get(session.owner) !== session
    )
      throw new Error('选择操作已取消，请重新选择')
  }
  private touch(session: Session): void {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      void this.discard(session).catch(() => {})
    }, this.idleMs)
    session.timer.unref?.()
  }
  private discard(session: Session): Promise<void> {
    session.closed = true
    clearTimeout(session.timer)
    if (session.closing) return session.closing
    const close = (async () => {
      const snapshot = await session.pending?.catch(() => null)
      if (snapshot) await this.database.closeTrackSelection(snapshot.id)
      session.owner.removeListener('destroyed', session.destroyed)
      if (this.sessions.get(session.owner) === session) this.sessions.delete(session.owner)
    })()
    session.closing = close
    void close.catch(() => {
      if (session.closing === close) session.closing = undefined
    })
    return close
  }
  private validate(input: unknown): asserts input is LibrarySelectionCommand {
    if (!input || typeof input !== 'object') throw new Error('无效的选择请求')
    const value = input as LibrarySelectionCommand
    if (typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id))
      throw new Error('无效的选择会话')
    if (value.kind === 'open' || value.kind === 'close') return
    if (
      value.kind !== 'read' ||
      (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0)) ||
      (value.projection !== undefined && !['tracks', 'files'].includes(value.projection))
    )
      throw new Error('无效的选择游标')
  }
}
