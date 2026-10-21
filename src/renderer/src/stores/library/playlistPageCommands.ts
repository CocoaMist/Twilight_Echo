import type { Ref } from 'vue'
import type { Track } from '../../types/music.ts'
import type {
  Playlist,
  PlaylistBatchMoveResult,
  PlaylistFavoritePageState,
  PlaylistMember,
  PlaylistMemberPageProducer,
  PlaylistPageProducer,
  PlaylistTrackIdPageProducer,
  PlaylistTrackPageProducer
} from './musicStoreTypes.ts'
import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import { getMusicVersions, musicVersionRevision } from '../musicVersions.ts'
import { canShareTrackIdentity, getRecordingTrackKey } from '../../utils/logicalTrackModel.ts'
import { reorderStableIds } from '../../utils/playlistLifecycle.ts'
import {
  clonePlaylist,
  nonEmptySnapshots,
  playlistDataEqual,
  toPlaylistTrackSnapshot
} from './musicStoreData.ts'
import {
  EXTERNAL_PLAYLIST_MAX_ENTRIES,
  externalRefreshGeneration,
  type ImportedPlaylistEntry
} from '../../../../shared/externalPlaylist.ts'
import {
  copyExternalEntry,
  externalEntryForTrack,
  withExternalMembership
} from './externalPlaylistMembership.ts'

/** Keep the final source fence synchronous with publication. A rejected append
 * poisons the transaction even if the producer catches that rejection. */
export async function stagePlaylistPages<T>(
  produce: PlaylistPageProducer<T>,
  consume: (page: readonly T[]) => void,
  signal?: AbortSignal
): Promise<() => void> {
  function checkAbort(): void {
    if (signal?.aborted) throw new Error('歌单操作已取消')
  }
  checkAbort()
  let accepting = true,
    failed = false
  let guard: void | (() => void)
  try {
    guard = await produce(async (page) => {
      try {
        checkAbort()
        if (!accepting || failed) throw new Error('歌单数据源已关闭')
        if (!Array.isArray(page) || page.length > LIBRARY_PAGE_SIZE)
          throw new Error(`歌单每批最多 ${LIBRARY_PAGE_SIZE} 首`)
        consume(page)
      } catch (error) {
        failed = true
        throw error
      }
    })
  } finally {
    accepting = false
  }
  return () => {
    checkAbort()
    if (failed) throw new Error('歌单分批读取失败，请重试')
    guard?.()
    checkAbort()
  }
}

function validateTrack(track: Track): void {
  if (!track || typeof track.id !== 'string' || !track.id) throw new Error('歌单曲目身份无效')
  if (track.source === 'playlist-import') throw new Error('未匹配的导入条目不能作为可播放曲目添加')
}

function putSnapshot(snapshots: Record<string, Track>, id: string, snapshot: Track): void {
  Object.defineProperty(snapshots, id, {
    value: snapshot,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

type PlaylistTarget = Pick<Playlist, 'id' | 'kind'> & {
  imported: boolean
  refreshGeneration?: string
}
type RecordingEntry = { id: string; track: Track }

/** Streaming commands edit compact playlist documents, never an accumulated
 * source Track[]. The existing playlist state remains the sole CAS/save owner. */
export function createPlaylistPageCommands(options: {
  playlists: Ref<Playlist[]>
  trackById: ReadonlyMap<string, Track>
  getTracksRevision(): number
  getDefaultFavoritePlaylist(): Playlist | null
  getPlaylistTrackSnapshot(playlist: Playlist, id: string): Track | undefined
  clonePlaylistSnapshot(): Playlist[]
  queuePlaylistPersistence(base: Playlist[]): void
}) {
  const { playlists } = options

  function currentPlaylist(target: PlaylistTarget): Playlist {
    const current = playlists.value.find((playlist) => playlist.id === target.id)
    if (!current || current.kind !== target.kind || !!current.imported !== target.imported)
      throw new Error('歌单已删除或类型已变化，请重新选择')
    if (
      current.imported &&
      externalRefreshGeneration(current.imported) !== target.refreshGeneration
    )
      throw new Error('导入歌单已刷新，请重新选择')
    return current
  }

  function captureTarget(id: string): PlaylistTarget {
    const playlist = playlists.value.find((item) => item.id === id)
    if (!playlist) throw new Error('歌单已不存在，请重新选择')
    return {
      id,
      kind: playlist.kind,
      imported: !!playlist.imported,
      ...(playlist.imported
        ? { refreshGeneration: externalRefreshGeneration(playlist.imported) }
        : {})
    }
  }

  function memberIds(playlist: Playlist): string[] {
    return playlist.imported
      ? playlist.imported.entries.map((entry) => entry.entryId)
      : playlist.trackIds
  }

  function publish(next: Playlist[]): void {
    const changes = new Map(next.map((playlist) => [playlist.id, playlist]))
    const before = next.some((playlist) => !playlist.transient)
      ? options.clonePlaylistSnapshot()
      : null
    const updated = playlists.value.map((playlist) => {
      const replacement = changes.get(playlist.id)
      changes.delete(playlist.id)
      return replacement ?? playlist
    })
    playlists.value = [...updated, ...changes.values()]
    if (before) options.queuePlaylistPersistence(before)
  }

  async function addTrackPagesToExternalPlaylistById(
    id: string,
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal
  ): Promise<number> {
    const target = captureTarget(id)
    if (!target.imported) throw new Error('请选择导入歌单')
    const additions: ImportedPlaylistEntry[] = []
    const finish = await stagePlaylistPages(
      produce,
      (page) => {
        if (additions.length + page.length > EXTERNAL_PLAYLIST_MAX_ENTRIES)
          throw new Error('歌单超过 20,000 条上限')
        for (const track of page) {
          validateTrack(track)
          additions.push(externalEntryForTrack(track, additions.length))
        }
      },
      signal
    )
    finish()
    const current = currentPlaylist(target)
    if (!additions.length) return 0
    publish([
      {
        ...current,
        imported: withExternalMembership(current.imported!, [
          ...current.imported!.entries,
          ...additions
        ])
      }
    ])
    return additions.length
  }

  async function collectIds(
    target: PlaylistTarget,
    produce: PlaylistTrackIdPageProducer,
    signal?: AbortSignal,
    maximum?: number
  ) {
    return collectItems(target, produce, (id) => ({ id }), signal, maximum)
  }

  async function collectMembers(
    target: PlaylistTarget,
    produce: PlaylistMemberPageProducer,
    signal?: AbortSignal,
    maximum?: number
  ) {
    return collectItems(target, produce, (member) => member, signal, maximum)
  }

  async function collectItems<T>(
    target: PlaylistTarget,
    produce: PlaylistPageProducer<T>,
    asMember: (item: T) => PlaylistMember,
    signal?: AbortSignal,
    maximum?: number
  ) {
    const original = currentPlaylist(target)
    const originalIds = new Set(memberIds(original))
    const selected = new Set<string>()
    const snapshots = new Map<string, Track>()
    const finish = await stagePlaylistPages(
      produce,
      (page) => {
        for (const item of page) {
          const member = asMember(item)
          const id = member?.id
          if (typeof id !== 'string' || !id) throw new Error('歌单成员身份无效')
          if (originalIds.has(id)) {
            selected.add(id)
            if (maximum !== undefined && selected.size > maximum)
              throw new Error('歌单超过 20,000 条上限')
            if (
              !original.imported &&
              !Object.hasOwn(original.trackSnapshots ?? {}, id) &&
              !options.trackById.has(id) &&
              member.track?.id === id &&
              !snapshots.has(id)
            ) {
              validateTrack(member.track)
              snapshots.set(id, toPlaylistTrackSnapshot(member.track))
            }
          }
        }
      },
      signal
    )
    return { selected, snapshots, finish }
  }

  function withoutTracks(current: Playlist, selected: ReadonlySet<string>) {
    if (current.imported) {
      const entries = current.imported.entries.filter((entry) => !selected.has(entry.entryId))
      const removed = current.imported.entries.length - entries.length
      return {
        next: removed
          ? { ...current, imported: withExternalMembership(current.imported, entries) }
          : current,
        removed
      }
    }
    const trackIds = current.trackIds.filter((id) => !selected.has(id))
    const removed = current.trackIds.length - trackIds.length
    if (!removed) return { next: current, removed }
    const snapshots = { ...current.trackSnapshots }
    for (const id of selected) delete snapshots[id]
    return { next: { ...current, trackIds, trackSnapshots: nonEmptySnapshots(snapshots) }, removed }
  }

  async function removeTrackIdPagesFromPlaylistById(
    id: string,
    produce: PlaylistTrackIdPageProducer,
    signal?: AbortSignal
  ): Promise<number> {
    const target = captureTarget(id)
    const { selected, finish } = await collectIds(target, produce, signal)
    finish()
    const { next, removed } = withoutTracks(currentPlaylist(target), selected)
    if (removed) publish([next])
    return removed
  }

  async function movePlaylistTrackIdPagesById(
    sourceId: string,
    targetId: string,
    produce: PlaylistTrackIdPageProducer,
    signal?: AbortSignal
  ): Promise<PlaylistBatchMoveResult> {
    return moveMembers(sourceId, targetId, (target, maximum) =>
      collectIds(target, produce, signal, maximum)
    )
  }

  async function movePlaylistMemberPagesById(
    sourceId: string,
    targetId: string,
    produce: PlaylistMemberPageProducer,
    signal?: AbortSignal
  ): Promise<PlaylistBatchMoveResult> {
    return moveMembers(sourceId, targetId, (target, maximum) =>
      collectMembers(target, produce, signal, maximum)
    )
  }

  async function moveMembers(
    sourceId: string,
    targetId: string,
    collect: (target: PlaylistTarget, maximum?: number) => ReturnType<typeof collectMembers>
  ): Promise<PlaylistBatchMoveResult> {
    const sourceTarget = captureTarget(sourceId),
      targetTarget = captureTarget(targetId)
    const {
      selected,
      snapshots: fallbacks,
      finish
    } = await collect(
      sourceTarget,
      targetTarget.imported ? EXTERNAL_PLAYLIST_MAX_ENTRIES : undefined
    )
    finish()
    const source = currentPlaylist(sourceTarget),
      target = currentPlaylist(targetTarget)
    if (sourceId === targetId) return { moved: 0, sourceRemoved: 0 }
    if (!!source.transient !== !!target.transient) throw new Error('请先保存导入歌单，再移动歌曲')
    const { next: nextSource, removed: sourceRemoved } = withoutTracks(source, selected)
    if (!sourceRemoved) return { moved: 0, sourceRemoved: 0 }
    const known = new Set(target.trackIds),
      trackIds = target.trackIds.slice()
    const snapshots = { ...target.trackSnapshots }
    const entries = target.imported?.entries.slice()
    let moved = 0
    function appendEntry(entry: ImportedPlaylistEntry): void {
      if (entries!.length >= EXTERNAL_PLAYLIST_MAX_ENTRIES)
        throw new Error('歌单超过 20,000 条上限')
      entries!.push(entry)
      moved++
    }
    function appendTrack(id: string, snapshot?: Track): void {
      if (entries) {
        if (!snapshot) throw new Error('原配置成员缺少快照，请从完整查询提供精确身份后重试')
        appendEntry(externalEntryForTrack(snapshot, entries.length))
        return
      }
      if (!known.has(id)) {
        known.add(id)
        trackIds.push(id)
        moved++
      }
      if (snapshot && !Object.hasOwn(snapshots, id))
        putSnapshot(snapshots, id, toPlaylistTrackSnapshot(snapshot))
    }
    // The latest source order and snapshots win over older pages. A concurrent
    // removal is not resurrected in the destination by this move.
    if (source.imported) {
      for (const entry of source.imported.entries) {
        if (!selected.has(entry.entryId)) continue
        if (entries) appendEntry(copyExternalEntry(entry, entries.length))
        else {
          const snapshot = entry.resolution.track
          if (!snapshot || !['local', 'streaming'].includes(entry.resolution.state))
            throw new Error('选中条目尚未匹配，普通歌单无法保存其信息，请选择导入歌单')
          appendTrack(snapshot.id, snapshot)
        }
      }
    } else {
      for (const id of source.trackIds) {
        if (!selected.has(id)) continue
        const snapshot =
          (Object.hasOwn(source.trackSnapshots ?? {}, id)
            ? source.trackSnapshots![id]
            : undefined) ??
          options.trackById.get(id) ??
          fallbacks.get(id)
        appendTrack(id, snapshot)
      }
    }
    const updatedAt = new Date().toISOString()
    publish([
      { ...nextSource, updatedAt },
      entries
        ? { ...target, imported: withExternalMembership(target.imported!, entries), updatedAt }
        : { ...target, trackIds, trackSnapshots: nonEmptySnapshots(snapshots), updatedAt }
    ])
    return { moved, sourceRemoved }
  }

  async function reorderPlaylistTrackIdPagesById(
    id: string,
    produce: PlaylistTrackIdPageProducer,
    targetIndex: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (!Number.isInteger(targetIndex)) throw new Error('歌单目标位置无效')
    const target = captureTarget(id)
    const originalOrder = memberIds(currentPlaylist(target)).slice()
    const { selected, finish } = await collectIds(target, produce, signal)
    finish()
    const current = currentPlaylist(target)
    const currentIds = memberIds(current)
    const currentPositions = new Map(currentIds.map((trackId, index) => [trackId, index]))
    // Anchor the drop to the first surviving, unselected original neighbour.
    // Concurrent insertions/reorders must not turn an old numeric offset into
    // a different destination, or be erased by a full old-order replay.
    let insertion = currentIds.length
    for (let index = Math.max(0, targetIndex); index < originalOrder.length; index++) {
      const anchor = originalOrder[index],
        position = currentPositions.get(anchor)
      if (!selected.has(anchor) && position !== undefined) {
        insertion = position
        break
      }
    }
    const trackIds = reorderStableIds(currentIds, selected, insertion)
    if (playlistDataEqual(currentIds, trackIds)) return false
    const byId = new Map(current.imported?.entries.map((entry) => [entry.entryId, entry]))
    publish([
      {
        ...current,
        updatedAt: new Date().toISOString(),
        ...(current.imported
          ? {
              imported: withExternalMembership(
                current.imported,
                trackIds.map((id) => byId.get(id)!)
              )
            }
          : { trackIds })
      }
    ])
    return true
  }

  function recordingIndex(playlist?: Playlist) {
    const ids = new Set(playlist?.trackIds)
    const byKey = new Map<string, RecordingEntry[]>()
    function add(id: string, track: Track): void {
      ids.add(id)
      const key = getRecordingTrackKey(track),
        entry = { id, track }
      const bucket = byKey.get(key)
      if (bucket) bucket.push(entry)
      else byKey.set(key, [entry])
    }
    for (const id of ids) {
      const snapshot = options.getPlaylistTrackSnapshot(playlist!, id)
      if (snapshot) add(id, snapshot)
    }
    function matches(track: Track): boolean {
      return (
        ids.has(track.id) ||
        !!byKey
          .get(getRecordingTrackKey(track))
          ?.some((candidate) => canShareTrackIdentity(candidate.track, track))
      )
    }
    return { ids, byKey, add, matches }
  }

  function captureFavorites(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('歌单操作已取消')
    // Load lazy version rules before capturing their revision.
    getMusicVersions()
    const tracksRevision = options.getTracksRevision(),
      versionRevision = musicVersionRevision.value
    const original = options.getDefaultFavoritePlaylist()
    if (original?.imported) throw new Error('导入歌单暂不支持流式收藏编辑')
    const base = original ? clonePlaylist(original) : undefined
    function current(): Playlist | undefined {
      if (
        tracksRevision !== options.getTracksRevision() ||
        versionRevision !== musicVersionRevision.value
      )
        throw new Error('曲库或录音版本已变化，请重新选择')
      const latest = options.getDefaultFavoritePlaylist() ?? undefined
      if (latest?.id !== base?.id || latest?.kind !== base?.kind || latest?.imported)
        throw new Error('收藏歌单已删除或类型已变化，请重新选择')
      return latest
    }
    return { base, current }
  }

  async function readFavoriteTrackPages(
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal
  ): Promise<PlaylistFavoritePageState> {
    const { base, current } = captureFavorites(signal)
    const index = recordingIndex(base)
    let count = 0,
      favoriteCount = 0
    const finish = await stagePlaylistPages(
      produce,
      (page) => {
        for (const track of page) {
          validateTrack(track)
          count++
          if (index.matches(track)) favoriteCount++
        }
      },
      signal
    )
    finish()
    const latest = current()
    const latestIds = new Set(latest?.trackIds)
    if (
      index.ids.size !== latestIds.size ||
      [...index.ids].some((id) => !latestIds.has(id)) ||
      !playlistDataEqual(base?.trackSnapshots, latest?.trackSnapshots)
    )
      throw new Error('收藏状态已变化，请重试')
    return { count, favoriteCount }
  }

  async function setFavoriteTrackPages(
    produce: PlaylistTrackPageProducer,
    favorite: boolean,
    signal?: AbortSignal
  ): Promise<number> {
    const { base, current } = captureFavorites(signal)
    const index = recordingIndex(base)
    // Only new compact snapshots (or IDs to remove) are staged. Unselected
    // source records never survive a page, including during unfavorite.
    const additions = new Map<string, Track>(),
      removals = new Set<string>()
    const finish = await stagePlaylistPages(
      produce,
      (page) => {
        for (const track of page) {
          validateTrack(track)
          if (favorite) {
            if (index.matches(track)) continue
            const snapshot = toPlaylistTrackSnapshot(track)
            additions.set(track.id, snapshot)
            index.add(track.id, snapshot)
          } else {
            if (index.ids.has(track.id)) removals.add(track.id)
            for (const candidate of index.byKey.get(getRecordingTrackKey(track)) ?? []) {
              if (canShareTrackIdentity(candidate.track, track)) removals.add(candidate.id)
            }
          }
        }
      },
      signal
    )
    finish()
    const latest = current()
    if (!favorite) {
      if (!latest) return 0
      const { next, removed } = withoutTracks(latest, removals)
      if (removed) publish([next])
      return removed
    }
    if (!additions.size) return 0
    const latestIndex = recordingIndex(latest)
    const next: Playlist = latest
      ? {
          ...latest,
          trackIds: latest.trackIds.slice(),
          trackSnapshots: { ...latest.trackSnapshots }
        }
      : {
          id: `pl_${crypto.randomUUID()}`,
          name: '我收藏的音乐',
          isDefault: true,
          trackIds: [],
          trackSnapshots: {},
          createdAt: new Date().toISOString()
        }
    let added = 0
    for (const snapshot of additions.values()) {
      if (latestIndex.matches(snapshot)) continue
      latestIndex.add(snapshot.id, snapshot)
      next.trackIds.push(snapshot.id)
      putSnapshot(next.trackSnapshots!, snapshot.id, snapshot)
      added++
    }
    if (added) publish([next])
    return added
  }

  return {
    addTrackPagesToExternalPlaylistById,
    removeTrackIdPagesFromPlaylistById,
    movePlaylistTrackIdPagesById,
    movePlaylistMemberPagesById,
    reorderPlaylistTrackIdPagesById,
    readFavoriteTrackPages,
    setFavoriteTrackPages
  }
}
