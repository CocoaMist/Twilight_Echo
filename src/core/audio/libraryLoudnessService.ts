import { join } from 'node:path'
import type { LibraryDatabaseApi, LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { LibrarySelectionApi } from '../../shared/librarySelection.ts'
import type { TrackData } from '../../shared/track.ts'
import type {
  CoreLoudnessPlanRequest,
  CoreLoudnessState,
  CoreLoudnessPage,
  CoreLoudnessResult
} from '../../shared/coreAnalysis.ts'
import {
  idleLoudnessBatchStatus,
  MAX_LOUDNESS_ALBUM_TRACKS,
  MAX_LOUDNESS_BATCH_TRACKS,
  type LoudnessInputGroup,
  type LoudnessInputTrack,
  type LoudnessGroupMeasurement,
  type LoudnessBatchItem
} from '../../shared/libraryLoudness.ts'
import { getTrackSource } from '../../shared/logicalTrackModel.ts'
import { compareAlbumTrackOrder } from '../playlists/data.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { projectCoreError } from '../projections.ts'
import { LibraryLoudnessManager } from './libraryLoudnessManager.ts'
import { LibraryLoudnessCache } from './libraryLoudnessCache.ts'

interface Options {
  root: string
  database: LibrarySelectionApi &
    Pick<LibraryDatabaseApi, 'queryTracks' | 'queryCollections' | 'getMetadata'>
  authorizePath(path: string): Promise<string>
  analyze(group: LoudnessInputGroup): Promise<LoudnessGroupMeasurement>
  cancelWork(): void
  newId(): string
  changed(): void
}
interface Plan {
  id: string
  revision: number
  groups: LoudnessInputGroup[]
  tracks: number
  skipped: number
  started: boolean
}

/** Only SQL-owned selections form plans; cached album identity remains unchanged. */
export class CoreLibraryLoudnessService {
  private readonly options: Options
  private readonly manager: LibraryLoudnessManager
  private plan: Plan | null = null
  private planning: Promise<CoreLoudnessState> | null = null
  private generation = 0
  private suspended = 0
  private stopped = false
  constructor(options: Options) {
    this.options = options
    this.manager = new LibraryLoudnessManager({
      cache: new LibraryLoudnessCache(join(options.root, 'library-loudness')),
      authorizePath: options.authorizePath,
      analyze: options.analyze,
      cancelWork: options.cancelWork,
      onProgress: options.changed
    })
  }
  state(): CoreLoudnessState | null {
    const plan = this.plan
    return plan
      ? {
          id: plan.id,
          libraryRevision: plan.revision,
          groups: plan.groups.length,
          tracks: plan.tracks,
          skipped: plan.skipped,
          status: plan.started ? this.manager.summary() : idleLoudnessBatchStatus()
        }
      : null
  }
  prepare(input: CoreLoudnessPlanRequest, signal?: AbortSignal): Promise<CoreLoudnessState> {
    this.available()
    if (this.planning || this.active()) throw new Error('请先完成或取消当前响度分析')
    const generation = this.generation
    const check = () => {
      signal?.throwIfAborted()
      if (generation !== this.generation) throw new Error('响度分析计划已取消')
    }
    this.planning = this.build(input, check).finally(() => {
      this.planning = null
    })
    return this.planning
  }
  private async build(
    input: CoreLoudnessPlanRequest,
    check: () => void
  ): Promise<CoreLoudnessState> {
    const db = this.options.database
    check()
    const selection = await db.createTrackSelection(input.selection)
    const tracks = new Map<string, LibraryTrackRecord>()
    try {
      if (selection.selectedCount > MAX_LOUDNESS_BATCH_TRACKS)
        throw new Error('单次最多分析 10,000 首，请缩小选择范围')
      let cursor: number | null = 0
      do {
        check()
        const page = await db.readTrackSelection(selection.id, cursor, 'tracks', true)
        for (const row of page.rows) tracks.set(row.track.id, row.track)
        cursor = page.nextCursor
      } while (cursor !== null)
    } finally {
      await db.closeTrackSelection(selection.id)
    }
    check()
    const local = [...tracks.values()].filter(
      (track) => getTrackSource(libraryTrack(track)) === 'local'
    )
    const groups: LoudnessInputGroup[] = []
    let trackCount = 0
    const add = (group: LoudnessInputGroup) => {
      trackCount += group.tracks.length
      if (trackCount > MAX_LOUDNESS_BATCH_TRACKS)
        throw new Error('单次最多分析 10,000 首，请缩小选择范围')
      groups.push(group)
    }
    if (input.mode === 'track') {
      for (const record of local) {
        const track = inputTrack(record)
        add({ id: `track:${record.id}`, title: track.title!, mode: 'track', tracks: [track] })
      }
    } else {
      const albumIds = new Set<string>()
      for (let offset = 0; offset < local.length; offset += 200) {
        check()
        // SQL resolves canonical album aliases globally (including multi-disc
        // cover/release evidence), even when only one selected member is known.
        const albums = await db.queryCollections('albums', {
          ids: local.slice(offset, offset + 200).map((track) => track.id),
          contentRevision: selection.revision,
          limit: 200
        })
        for (const album of albums.items) {
          if (albumIds.has(album.id)) continue
          albumIds.add(album.id)
          const members: LibraryTrackRecord[] = []
          for (let offset = 0; ; offset += 200) {
            check()
            const page = await db.queryTracks({
              albumId: album.id,
              contentRevision: selection.revision,
              offset,
              limit: 200
            })
            if (page.total > MAX_LOUDNESS_ALBUM_TRACKS)
              throw new Error(`「${album.name}」超过单张专辑 256 首的上限，请改用曲目模式`)
            members.push(...page.tracks)
            if (offset + page.tracks.length >= page.total) break
          }
          add({
            id: `album:${album.id}`,
            title: album.name.slice(0, 1024),
            mode: 'album',
            tracks: members.map(libraryTrack).sort(compareAlbumTrackOrder).map(inputTrack)
          })
        }
      }
    }
    check()
    if ((await db.getMetadata()).revision !== selection.revision)
      throw new Error('曲库已变化，请重新选择')
    check()
    this.plan = {
      id: this.options.newId(),
      revision: selection.revision,
      groups,
      tracks: trackCount,
      skipped: tracks.size - local.length,
      started: false
    }
    this.options.changed()
    return this.state()!
  }
  async start(id: string): Promise<CoreLoudnessState> {
    this.available()
    if (this.planning || this.active()) throw new Error('已有响度分析任务')
    const plan = this.current(id)
    if ((await this.options.database.getMetadata()).revision !== plan.revision)
      throw new Error('曲库已变化，请重新选择')
    this.available()
    this.current(id)
    if (this.planning || this.active()) throw new Error('已有响度分析任务')
    if (!plan.groups.length) throw new Error('请选择本地歌曲')
    plan.started = true
    this.manager.start(plan.groups)
    return this.state()!
  }
  async cancel(id: string): Promise<CoreLoudnessState> {
    this.current(id)
    await this.manager.cancel()
    this.current(id)
    return this.state()!
  }
  page(id: string, offset = 0, limit = 200): CoreLoudnessPage {
    const plan = this.current(id)
    const items: LoudnessBatchItem[] = plan.started
      ? this.manager.page(offset, Math.min(limit, 200))
      : plan.groups.slice(offset, offset + Math.min(limit, 200)).map((group) => ({
          id: group.id,
          title: group.title,
          trackCount: group.tracks.length,
          state: 'queued' as const
        }))
    return {
      id,
      offset,
      total: plan.groups.length,
      items: items.map(({ id: _id, ...item }, index) => ({
        ...item,
        index: offset + index,
        ...('reason' in item && item.reason ? { reason: projectCoreError(item.reason) } : {})
      }))
    }
  }
  async result(id: string, index: number): Promise<CoreLoudnessResult> {
    const group = this.current(id).groups[index]
    if (!group) throw new Error('响度分组不存在')
    const [{ id: _id, ...result }] = await this.manager.results([group])
    this.current(id)
    return {
      ...result,
      index,
      ...(result.reason ? { reason: projectCoreError(result.reason) } : {})
    }
  }
  clear(id: string): void {
    this.available()
    this.manager.clear(this.current(id).groups.map((group) => group.id))
    this.options.changed()
  }
  private current(id: string): Plan {
    if (this.plan?.id !== id)
      throw Object.assign(new Error('响度计划已变化'), { code: 'STALE_REVISION' })
    return this.plan
  }
  private active(): boolean {
    return ['running', 'cancelling'].includes(this.manager.summary().state)
  }
  private available(): void {
    if (this.stopped || this.suspended) throw new Error('响度分析正在维护或已停止')
  }
  async maintain<T>(action: () => Promise<T>): Promise<T> {
    this.suspended++
    this.generation++
    try {
      await Promise.all([this.manager.cancel(), this.planning?.catch(() => {})])
      return await action()
    } finally {
      this.suspended--
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.maintain(async () => {})
  }
}

function inputTrack(record: LibraryTrackRecord | TrackData): LoudnessInputTrack {
  const track = libraryTrack({ ...record })
  return {
    id: track.id,
    title: track.title.slice(0, 1024),
    filePath: track.filePath,
    ...(track.cueRange ? { cueRange: { ...track.cueRange } } : {}),
    ...(track.subTrack ? { subTrack: track.subTrack } : {})
  }
}
