import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import type { LibraryDatabaseWorkerApi } from './libraryDatabaseProtocol.ts'
import type { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'
import { expandSacdIsoTracks, type SacdIsoMetadataReader } from './sacdIsoTracks.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import {
  PLAYLIST_REPAIR_BATCH_SIZE,
  validatePlaylistRepairRequest,
  type LibraryPlaylistRepairRequest,
  type LibraryPlaylistRepairResponse
} from '../../shared/playlistRepair.ts'

export interface RepairSessionOwner {
  isDestroyed(): boolean
  once(event: 'destroyed', callback: () => void): unknown
  removeListener(event: 'destroyed', callback: () => void): unknown
}
type Session = {
  id: string
  owner: RepairSessionOwner
  abort: AbortController
  operation: Promise<LibraryPlaylistRepairResponse> | null
  closing?: Promise<void>
  timer?: NodeJS.Timeout
  destroyed(): void
  candidateSequence: number
  sequence: number
  ready: boolean
  root?: string
}
type Options = {
  database: Pick<LibraryDatabaseWorkerApi, 'repairCandidates'>
  scanner: Pick<LocalLibraryScanServiceClient, 'scanRepair'>
  coverCacheDir: string
  authorizeDirectory(path: string): Promise<string>
  authorizeFile(path: string): Promise<string>
  reserveScan<T>(action: () => Promise<T>): Promise<T>
  normalizeCoverHandle?: (handle: string) => Promise<string>
  readSacdIsoMetadata?: SacdIsoMetadataReader
  idleMs?: number
}

/** One sender-bound, disposable candidate scan. Only completed scans can
 * resolve; unknown replies are never replayed. No candidate is imported. */
export class LibraryPlaylistRepairService {
  private active: Session | null = null
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }

  async handle(owner: RepairSessionOwner, input: unknown): Promise<LibraryPlaylistRepairResponse> {
    validatePlaylistRepairRequest(input)
    if (owner.isDestroyed()) throw new Error('歌单修复窗口已关闭')
    let session = this.active
    if (input.kind === 'open') {
      if (session?.abort.signal.aborted) {
        await this.discard(session)
        session = this.active
      }
      if (session) throw new Error('已有歌单修复正在运行，请稍后重试')
      session = {
        id: randomUUID(),
        owner,
        abort: new AbortController(),
        operation: null,
        destroyed: () => {
          void this.discard(session!).catch(() => {})
        },
        candidateSequence: 0,
        sequence: 0,
        ready: false
      }
      this.active = session
      owner.once('destroyed', session.destroyed)
    } else if (!session || session.owner !== owner || session.id !== input.id) {
      // Closing an already released own session is harmless; another sender
      // can neither resolve nor abort an active scan.
      if (input.kind === 'close' && !session) return { kind: 'closed', id: input.id }
      throw new Error('歌单修复会话已失效或不属于当前窗口')
    }
    clearTimeout(session.timer)
    if (input.kind === 'close') {
      await this.discard(session)
      return { kind: 'closed', id: input.id }
    }
    if (session.closing || session.operation) throw new Error('歌单修复批次尚未完成')
    const operation =
      input.kind === 'open' ? this.open(session, input.folder) : this.resolve(session, input)
    session.operation = operation
    try {
      return await operation
    } catch (error) {
      // Wait for cleanup before accepting another session, including a begin
      // whose SQL reply was lost. close is idempotent; resolve is not.
      void this.discard(session).catch(() => {})
      throw error
    } finally {
      if (session.operation === operation) session.operation = null
      if (!session.closing && this.active === session)
        session.timer = setTimeout(() => {
          void this.discard(session!).catch(() => {})
        }, this.options.idleMs ?? 120_000)
    }
  }

  private open(session: Session, folder: string): Promise<LibraryPlaylistRepairResponse> {
    return this.options.reserveScan(async () => {
      const root = await this.options.authorizeDirectory(folder)
      session.root = root
      const check = () => {
        if (session.abort.signal.aborted || session.owner.isDestroyed())
          throw new Error('歌单修复已取消')
      }
      const authorize = async (path: string, fileOnly = false) => {
        check()
        const canonical = await realpath(path),
          scope = relative(root, canonical)
        if (
          scope === '..' ||
          scope.startsWith('../') ||
          scope.startsWith('..\\') ||
          isAbsolute(scope)
        )
          throw new Error('修复候选的实际位置超出所选文件夹')
        if (!fileOnly && (await stat(canonical)).isDirectory())
          await this.options.authorizeDirectory(canonical)
        else await this.options.authorizeFile(canonical)
        check()
      }
      check()
      await this.options.database.repairCandidates({ kind: 'begin', id: session.id })
      await this.options.scanner.scanRepair(
        session.id,
        root,
        this.options.coverCacheDir,
        async (call) => {
          check()
          if (call.kind === 'authorize') {
            for (const path of call.paths) await authorize(path)
            return
          }
          let pending: LibraryTrackRecord[] = []
          const flush = async () => {
            if (!pending.length) return
            check()
            await this.options.database.repairCandidates({
              kind: 'append',
              id: session.id,
              sequence: ++session.candidateSequence,
              tracks: pending
            })
            pending = []
          }
          for (const raw of call.tracks) {
            await authorize(raw.filePath, true)
            const expanded = this.options.readSacdIsoMetadata
              ? ((await expandSacdIsoTracks(
                  [raw],
                  this.options.readSacdIsoMetadata
                )) as LibraryTrackRecord[])
              : [raw]
            for (const expandedTrack of expanded) {
              const track = compactPlaylistRecord(expandedTrack)
              if (this.options.normalizeCoverHandle)
                for (const field of ['cover', 'coverSmall'] as const)
                  if (typeof track[field] === 'string')
                    track[field] = await this.options.normalizeCoverHandle(track[field])
              pending.push(track)
              if (pending.length === PLAYLIST_REPAIR_BATCH_SIZE) await flush()
            }
          }
          await flush()
        },
        session.abort.signal
      )
      check()
      const sealed = await this.options.database.repairCandidates({
        kind: 'seal',
        id: session.id,
        sequence: ++session.candidateSequence
      })
      session.ready = true
      return { kind: 'ready', id: session.id, candidateCount: sealed.count }
    })
  }
  private async resolve(
    session: Session,
    request: Extract<LibraryPlaylistRepairRequest, { kind: 'resolve' }>
  ): Promise<LibraryPlaylistRepairResponse> {
    if (!session.ready || request.sequence !== session.sequence + 1)
      throw new Error('歌单修复批次已失效，请重新修复')
    const reply = await this.options.database.repairCandidates({
      kind: 'resolve',
      id: session.id,
      sequence: ++session.candidateSequence,
      missing: request.missing.map((track) => ({
        id: track.id,
        filePath: track.filePath,
        fileName: track.fileName,
        title: track.title,
        artist: track.artist,
        duration: track.duration
      }))
    })
    if (!reply.result) throw new Error('未收到有效的歌单修复结果')
    const root = await this.options.authorizeDirectory(session.root!)
    for (const relocation of reply.result.relocations) {
      const path = await this.options.authorizeFile(relocation.toTrack.filePath)
      const scope = relative(root, path)
      if (
        scope === '..' ||
        scope.startsWith('../') ||
        scope.startsWith('..\\') ||
        isAbsolute(scope)
      )
        throw new Error('修复候选的实际位置超出所选文件夹')
    }
    if (session.abort.signal.aborted || session.owner.isDestroyed())
      throw new Error('歌单修复已取消')
    session.sequence = request.sequence
    return { kind: 'resolved', id: session.id, sequence: request.sequence, result: reply.result }
  }
  private discard(session: Session): Promise<void> {
    if (session.closing) return session.closing
    session.abort.abort()
    clearTimeout(session.timer)
    session.owner.removeListener('destroyed', session.destroyed)
    return (session.closing = (async () => {
      await session.operation?.catch(() => {})
      await this.options.database.repairCandidates({ kind: 'close', id: session.id })
      if (this.active === session) this.active = null
    })().catch((error) => {
      session.closing = undefined
      throw error
    }))
  }
  destroy(): void {
    if (this.active) void this.discard(this.active).catch(() => {})
  }
}
