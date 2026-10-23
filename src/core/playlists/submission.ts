import type {
  CorePlaylistSubmitCommand,
  CorePlaylistSubmitReply,
  CorePlaylistSubmitItem
} from '../../shared/corePlaylists.ts'
import type { CoreQueueTrackInput } from '../../shared/coreQueueSubmission.ts'
import type { PlaylistMember } from '../../shared/playlists.ts'
import type { TrackData } from '../../shared/track.ts'
import {
  LIBRARY_QUEUE_BUILD_IDLE_MS,
  LIBRARY_QUEUE_BUILD_MAX_ENTRIES
} from '../../shared/libraryQueueBuild.ts'
import type { CorePlaylistService } from './service.ts'
import type { LibraryQueueSeedItem } from '../../shared/libraryQueueBuild.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'

export function createPlaylistInputResolver(
  resolve: (
    inputs: readonly CoreQueueTrackInput[],
    signal: AbortSignal
  ) => Promise<LibraryQueueSeedItem[]>,
  database: Pick<LibraryDatabaseApi, 'getTracksByIds'>
) {
  return async (
    inputs: readonly CoreQueueTrackInput[],
    signal: AbortSignal
  ): Promise<TrackData[]> => {
    const seeds = await resolve(inputs, signal)
    const ids = seeds.filter((seed) => !seed.snapshot && !seed.localSnapshot).map((seed) => seed.id)
    const page = ids.length ? await database.getTracksByIds(ids) : null
    const local = new Map(page?.tracks.map((record) => [record.id, libraryTrack(record)]))
    signal.throwIfAborted()
    return seeds.map((seed) => {
      const record = seed.localSnapshot ?? seed.snapshot
      const track = record ? libraryTrack({ ...record, id: seed.id }) : local.get(seed.id)
      if (!track) throw new Error('本地曲目已不存在，请刷新曲库')
      return track
    })
  }
}

interface Submission {
  id: string
  clientId: string
  sequence: number
  total: number
  controller: AbortController
  append: ((items: readonly PlaylistMember[]) => Promise<void>) | null
  finish(): void
  work: Promise<{ revision: number; result: unknown }>
  busy: boolean
  committing: boolean
  cancelTimer(): void
}
interface Options {
  playlists: Pick<CorePlaylistService, 'editPages'>
  resolve(inputs: readonly CoreQueueTrackInput[], signal: AbortSignal): Promise<TrackData[]>
  newId(): string
  schedule(callback: () => void, delay: number): () => void
}

/** Client-bound staging feeds the existing playlist transaction. Disconnects
 * discard uncommitted pages; a dispatched commit outlives its window. */
export class CorePlaylistSubmission {
  private readonly stages = new Map<string, Submission>()
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }
  async submit(
    clientId: string,
    command: CorePlaylistSubmitCommand
  ): Promise<CorePlaylistSubmitReply> {
    if (command.kind === 'begin') return this.begin(clientId, command)
    const stage = this.stages.get(command.id)
    if (!stage || stage.clientId !== clientId) throw new Error('歌单提交已结束，请重新选择')
    if (command.kind === 'abort') {
      if (stage.committing) throw new Error('歌单已经开始保存，请等待结果')
      stage.controller.abort(new Error('歌单操作已取消'))
      await stage.work.catch(() => {})
      return this.reply(stage, 'aborted')
    }
    if (stage.busy || stage.committing) throw new Error('请等待上一批歌单提交完成')
    if (command.sequence !== stage.sequence + 1) throw new Error('歌单批次已变化，不可重放旧批次')
    stage.controller.signal.throwIfAborted()
    stage.busy = true
    stage.cancelTimer()
    try {
      if (command.kind === 'append') {
        if (stage.total + command.items.length > LIBRARY_QUEUE_BUILD_MAX_ENTRIES)
          throw new Error('歌单已达到容量上限')
        const items = await this.resolve(command.items, stage.controller.signal)
        stage.controller.signal.throwIfAborted()
        await stage.append!(items)
        stage.sequence = command.sequence
        stage.total += items.length
        this.arm(stage)
        return this.reply(stage, 'building')
      }
      stage.committing = true
      stage.sequence = command.sequence
      stage.finish()
      const saved = await stage.work
      return { ...this.reply(stage, 'committed'), ...saved }
    } catch (error) {
      stage.controller.abort(error)
      await stage.work.catch(() => {})
      throw error
    } finally {
      stage.busy = false
    }
  }
  private async resolve(
    items: readonly CorePlaylistSubmitItem[],
    signal: AbortSignal
  ): Promise<PlaylistMember[]> {
    const inputs = items.flatMap((item) => (item.input ? [item.input] : []))
    const tracks = await this.options.resolve(inputs, signal)
    let index = 0
    return items.map((item) => {
      const track = item.input ? tracks[index++] : undefined
      const id = item.id ?? track?.id
      if (!id) throw new Error('歌单成员身份缺失')
      return { id, ...(track ? { track } : {}) }
    })
  }
  private async begin(
    clientId: string,
    command: Extract<CorePlaylistSubmitCommand, { kind: 'begin' }>
  ) {
    await this.disconnect(clientId)
    const controller = new AbortController()
    let ready!: () => void, finish!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const complete = new Promise<void>((resolve, reject) => {
      finish = resolve
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true
      })
    })
    void complete.catch(() => {})
    const stage: Submission = {
      id: this.options.newId(),
      clientId,
      sequence: 0,
      total: 0,
      controller,
      append: null,
      finish,
      work: Promise.resolve({ revision: command.revision, result: undefined }),
      busy: false,
      committing: false,
      cancelTimer: () => {}
    }
    this.stages.set(stage.id, stage)
    stage.work = this.options.playlists
      .editPages(
        command.revision,
        command.edit,
        async (append) => {
          stage.append = append
          ready()
          await complete
        },
        controller.signal
      )
      .finally(() => {
        stage.cancelTimer()
        this.stages.delete(stage.id)
      })
    await Promise.race([started, stage.work])
    if (!stage.append) throw new Error('无法准备歌单操作')
    void stage.work.catch(() => {})
    this.arm(stage)
    return this.reply(stage, 'building')
  }
  private reply(
    stage: Submission,
    state: CorePlaylistSubmitReply['state']
  ): CorePlaylistSubmitReply {
    return { id: stage.id, state, sequence: stage.sequence, total: stage.total }
  }
  private arm(stage: Submission): void {
    stage.cancelTimer = this.options.schedule(
      () => stage.controller.abort(new Error('歌单提交已超时')),
      LIBRARY_QUEUE_BUILD_IDLE_MS
    )
  }
  async disconnect(clientId: string): Promise<void> {
    const work: Promise<unknown>[] = []
    for (const stage of this.stages.values()) {
      if (stage.clientId !== clientId || stage.committing) continue
      stage.controller.abort(new Error('歌单提交窗口已断开'))
      work.push(stage.work)
    }
    await Promise.allSettled(work)
  }
  async shutdown(): Promise<void> {
    const stages = [...this.stages.values()]
    for (const stage of stages)
      if (!stage.committing) stage.controller.abort(new Error('Core is shutting down'))
    await Promise.allSettled(stages.map((stage) => stage.work))
  }
}
