import type { Ref } from 'vue'
import type { Track } from '../../types/music'
import type {
  Playlist,
  PlaylistBatchMoveResult,
  PlaylistImportApplyResult,
  PlaylistPersistenceNotice,
  PlaylistTrackPageProducer
} from './musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../playlistPersistence.ts'
import { isAggregatePlaylist } from '../../utils/aggregatePlaylistView.ts'
import {
  getRecordingTrackKey as getLogicalTrackKey,
  canShareTrackIdentity,
  getTrackSource
} from '../../utils/logicalTrackModel.ts'
import {
  exportPlaylistDocument,
  findPlaylistRelocations,
  parsePlaylistDocument,
  reorderStableIds,
  type PlaylistFileFormat,
  type PlaylistImportEntry,
  type PlaylistRelocationResult
} from '../../utils/playlistLifecycle.ts'
import {
  clonePlaylist,
  normalizePortableLibraryPath,
  playlistDataEqual,
  replayPlaylistRecord,
  nonEmptySnapshots,
  toPlaylistTrackSnapshot
} from './musicStoreData.ts'
import { createPlaylistState } from './playlistState.ts'
import { createPlaylistTrackResolver } from './playlistTrackResolver.ts'
import { createExternalPlaylistCommands } from './externalPlaylistController.ts'
import { createPlaylistPageCommands, stagePlaylistPages } from './playlistPageCommands.ts'
import { externalEntryForTrack, withExternalMembership } from './externalPlaylistMembership.ts'

const DEFAULT_FAVORITE_PLAYLIST_NAME = '我收藏的音乐'

/** Playlist commands share one resolver and persistence owner across store consumers. */
export function createPlaylistController(options: {
  playlists: Ref<Playlist[]>
  tracks: Ref<Track[]>
  trackById: ReadonlyMap<string, Track>
  getTracksRevision: () => number
  playlistPersistenceStatus: Ref<PlaylistPersistenceStatus>
  playlistPersistenceNotice: Ref<PlaylistPersistenceNotice | null>
  /** null explicitly selects the original JSON implementation. Discovery or
   * SQL errors must reject, never silently use an incomplete renderer index. */
  resolveImportPaths?(paths: readonly string[]): Promise<Array<Track | null> | null>
  /** Only explicit JSON mode returns null. Failed membership reads must not
   * turn unloaded library records into missing playlist entries. */
  readTrackPresence?(ids: readonly string[]): Promise<ReadonlySet<string> | null>
  findRelocationsInFolder?(
    missing: readonly Track[],
    folder: string
  ): Promise<PlaylistRelocationResult>
  /** Explicit JSON mode returns null; SQLite writes only a completed, fenced export. */
  exportDocument?(playlist: Playlist, format: PlaylistFileFormat): Promise<string | null>
}) {
  const { playlists, tracks, trackById } = options
  const resolver = createPlaylistTrackResolver(options)
  const state = createPlaylistState({ ...options, onChange: resolver.invalidate })
  const { clonePlaylistSnapshot, queuePlaylistPersistence } = state
  const external = createExternalPlaylistCommands({
    playlists,
    clonePlaylistSnapshot,
    queuePlaylistPersistence
  })
  const { getPlaylistTrackSnapshot, getPlaylistIdentity, resolvePlaylistTracks } = resolver
  const pageCommands = createPlaylistPageCommands({
    ...options,
    getDefaultFavoritePlaylist,
    getPlaylistTrackSnapshot,
    clonePlaylistSnapshot,
    queuePlaylistPersistence
  })

  /**
   * 按名字查找歌单时一律排除聚合歌单。聚合歌单只能通过 id 访问，所以它和普通
   * 歌单可以同名，而所有既有的 by-name API 都不会被它劫持。
   */
  function findLocalPlaylistByName(name: string): Playlist | undefined {
    return playlists.value.find((item) => !isAggregatePlaylist(item) && item.name === name)
  }

  /** 重名校验只在同一类歌单内进行——两类是两个命名空间。 */
  function hasSiblingPlaylistName(playlist: Playlist, name: string): boolean {
    return playlists.value.some(
      (item) =>
        item.id !== playlist.id &&
        isAggregatePlaylist(item) === isAggregatePlaylist(playlist) &&
        item.name === name
    )
  }

  function ensurePlaylist(name: string, options: { isDefault?: boolean } = {}): Playlist {
    const existing = findLocalPlaylistByName(name)
    if (existing) return existing
    const playlist: Playlist = {
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      trackIds: [],
      ...(options.isDefault ? { isDefault: true } : {}),
      createdAt: new Date().toISOString()
    }
    playlists.value = [...playlists.value, playlist]
    return playlist
  }

  function createPlaylist(name: string): string {
    const existing = findLocalPlaylistByName(name)
    if (existing) return existing.id
    const base = clonePlaylistSnapshot()
    const playlist = ensurePlaylist(name)
    queuePlaylistPersistence(base)
    return playlist.id
  }

  function createPlaylistWithTracks(name: string, playlistTracks: Track[]): string {
    const base = clonePlaylistSnapshot()
    const existing = findLocalPlaylistByName(name)
    const playlist = existing ?? ensurePlaylist(name)
    const changed = appendTracksToPlaylist(playlist, playlistTracks)
    if (!existing || changed) queuePlaylistPersistence(base)
    return playlist.id
  }

  /** Stage one compact document, not an ever-growing source Track[]. Nothing
   * is published or persisted until every source page and its final fence pass. */
  async function stagePlaylistTrackPages(
    original: Playlist | undefined,
    name: string,
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal,
    kind?: Playlist['kind']
  ): Promise<{ id: string; added: number }> {
    if (signal?.aborted) throw new Error('歌单操作已取消')
    if (original?.imported)
      return {
        id: original.id,
        added: await pageCommands.addTrackPagesToExternalPlaylistById(original.id, produce, signal)
      }
    const base = original ? clonePlaylist(original) : undefined
    const draft: Playlist = base
      ? { ...base, trackIds: base.trackIds.slice(), trackSnapshots: { ...base.trackSnapshots } }
      : {
          id: `pl_${crypto.randomUUID()}`,
          name,
          trackIds: [],
          trackSnapshots: {},
          ...(kind ? { kind } : {}),
          createdAt: new Date().toISOString()
        }
    const known = new Set(draft.trackIds)
    let changed = false
    const finish = await stagePlaylistPages(
      produce,
      (page) => {
        for (const track of page) {
          if (!track || typeof track.id !== 'string' || !track.id)
            throw new Error('歌单曲目身份无效')
          if (track.source === 'playlist-import')
            throw new Error('未匹配的导入条目不能作为可播放曲目添加')
          if (!known.has(track.id)) {
            known.add(track.id)
            draft.trackIds.push(track.id)
            changed = true
          }
          if (!Object.hasOwn(draft.trackSnapshots!, track.id)) {
            Object.defineProperty(draft.trackSnapshots!, track.id, {
              value: toPlaylistTrackSnapshot(track),
              enumerable: true,
              configurable: true,
              writable: true
            })
            changed = true
          }
        }
      },
      signal
    )
    finish()
    const current = base ? playlists.value.find((item) => item.id === base.id) : undefined
    if (base && (!current || current.kind !== base.kind || current.imported))
      throw new Error('目标歌单已删除或类型已变化，请重新选择')
    if (!base && playlists.value.some((item) => item.kind === kind && item.name === name))
      throw new Error('读取期间已创建同名歌单，请重新选择')
    if (base && !changed) return { id: base.id, added: 0 }
    // Rebase once against the latest record. Concurrent rename, cover, settings,
    // additions and removals survive; the original target ID never retargets.
    // Appending only fills missing snapshots. A concurrent add or snapshot edit of
    // the same ID wins over this older source page, just like synchronous append.
    if (current?.trackSnapshots) {
      for (const id of Object.keys(draft.trackSnapshots!)) {
        if (Object.hasOwn(current.trackSnapshots, id))
          draft.trackSnapshots![id] = current.trackSnapshots[id]
      }
    }
    draft.trackSnapshots = nonEmptySnapshots(draft.trackSnapshots!)
    const next = base && current ? replayPlaylistRecord(base, draft, current) : draft
    const added = next.trackIds.length - (current?.trackIds.length ?? 0)
    const before = clonePlaylistSnapshot()
    playlists.value = current
      ? playlists.value.map((item) => (item.id === current.id ? next : item))
      : [...playlists.value, next]
    queuePlaylistPersistence(before)
    return { id: next.id, added }
  }

  async function createPlaylistWithTrackPages(
    name: string,
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal
  ): Promise<string> {
    const normalized = normalizePlaylistName(name)
    return (
      await stagePlaylistTrackPages(
        findLocalPlaylistByName(normalized),
        normalized,
        produce,
        signal
      )
    ).id
  }

  async function addTrackPagesToPlaylistById(
    playlistId: string,
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal
  ): Promise<number> {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) throw new Error('目标歌单已不存在，请重新选择')
    return (await stagePlaylistTrackPages(playlist, playlist.name, produce, signal)).added
  }

  async function createAggregatePlaylistWithTrackPages(
    name: string,
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal
  ): Promise<string> {
    const normalized = normalizePlaylistName(name)
    const existing = playlists.value.find(
      (item) => isAggregatePlaylist(item) && item.name === normalized
    )
    return (await stagePlaylistTrackPages(existing, normalized, produce, signal, 'aggregate')).id
  }

  function normalizePlaylistName(value: string): string {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (!normalized) throw new Error('歌单名称不能为空')
    if (normalized.length > 80) throw new Error('歌单名称不能超过 80 个字符')
    return normalized
  }

  function touchPlaylist(playlist: Playlist): void {
    playlist.updatedAt = new Date().toISOString()
  }

  function updatePlaylist(playlist: Playlist, patch: Partial<Playlist>): boolean {
    const base = clonePlaylistSnapshot()
    Object.assign(playlist, patch)
    touchPlaylist(playlist)
    queuePlaylistPersistence(base)
    return true
  }

  function renamePlaylist(playlistId: string, name: string): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) return false
    const normalizedName = normalizePlaylistName(name)
    if (playlist.name === normalizedName) return false
    if (hasSiblingPlaylistName(playlist, normalizedName)) {
      throw new Error('已存在同名歌单')
    }
    return updatePlaylist(playlist, { name: normalizedName })
  }

  function setPlaylistCover(playlistId: string, cover: string | null): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) return false
    const nextCover = cover?.trim() || null
    if (nextCover && nextCover.length > 8 * 1024 * 1024) {
      throw new Error('歌单封面数据超过 8 MiB 上限')
    }
    if (nextCover && !/^(data:image\/(?:png|jpeg|webp);base64,|cover:\/\/)/i.test(nextCover)) {
      throw new Error('歌单封面必须是受支持的图片数据')
    }
    if ((playlist.cover ?? null) === nextCover) return false
    return updatePlaylist(playlist, { cover: nextCover })
  }

  function copyPlaylist(playlistId: string, name: string): string | null {
    const source = playlists.value.find((item) => item.id === playlistId)
    if (!source) return null
    const normalizedName = normalizePlaylistName(name)
    if (hasSiblingPlaylistName(source, normalizedName)) {
      throw new Error('已存在同名歌单')
    }
    const base = clonePlaylistSnapshot()
    const now = new Date().toISOString()
    const copy: Playlist = {
      ...clonePlaylist(source),
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: normalizedName,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    }
    playlists.value = [...playlists.value, copy]
    queuePlaylistPersistence(base)
    return copy.id
  }

  function reorderPlaylistTracks(
    playlistName: string,
    trackIds: Iterable<string>,
    targetIndex: number
  ): boolean {
    const playlist = findLocalPlaylistByName(playlistName)
    if (!playlist || !Number.isInteger(targetIndex)) return false
    const nextTrackIds = reorderStableIds(playlist.trackIds, trackIds, targetIndex)
    if (playlistDataEqual(nextTrackIds, playlist.trackIds)) return false
    return updatePlaylist(playlist, { trackIds: nextTrackIds })
  }

  function movePlaylistTracks(
    sourcePlaylistName: string,
    targetPlaylistName: string,
    trackIds: Iterable<string>
  ): PlaylistBatchMoveResult {
    const source = findLocalPlaylistByName(sourcePlaylistName)
    const target = findLocalPlaylistByName(targetPlaylistName)
    if (!source || !target || source === target) return { moved: 0, sourceRemoved: 0 }
    const selected = new Set(trackIds)
    if (selected.size === 0) return { moved: 0, sourceRemoved: 0 }
    const sourceIds = source.trackIds.filter((id) => selected.has(id))
    if (sourceIds.length === 0) return { moved: 0, sourceRemoved: 0 }
    const base = clonePlaylistSnapshot()
    const targetKnown = new Set(target.trackIds)
    const nextTargetIds = target.trackIds.slice()
    const nextTargetSnapshots = { ...(target.trackSnapshots ?? {}) }
    let moved = 0
    for (const id of sourceIds) {
      if (!targetKnown.has(id)) {
        targetKnown.add(id)
        nextTargetIds.push(id)
        moved++
      }
      const snapshot = source.trackSnapshots?.[id] ?? trackById.get(id)
      if (snapshot && !nextTargetSnapshots[id])
        nextTargetSnapshots[id] = toPlaylistTrackSnapshot(snapshot)
    }
    source.trackIds = source.trackIds.filter((id) => !selected.has(id))
    if (source.trackSnapshots) {
      const nextSourceSnapshots = { ...source.trackSnapshots }
      for (const id of selected) delete nextSourceSnapshots[id]
      source.trackSnapshots = nonEmptySnapshots(nextSourceSnapshots)
    }
    target.trackIds = nextTargetIds
    target.trackSnapshots = nonEmptySnapshots(nextTargetSnapshots)
    touchPlaylist(source)
    touchPlaylist(target)
    queuePlaylistPersistence(base)
    return { moved, sourceRemoved: sourceIds.length }
  }

  function importPlaylistDocument(
    name: string,
    fileName: string,
    contents: string
  ): PlaylistImportApplyResult {
    const parsed = parsePlaylistDocument(contents, fileName)
    return applyPlaylistEntries(name, parsed.entries, parsed.warnings)
  }

  /**
   * The shared tail of every import path: match entries against the live
   * library, create-or-extend the playlist, and queue persistence. Plugins reach
   * it through `importPlaylistPaths` without going through playlist *text*.
   */
  function applyPlaylistEntries(
    name: string,
    entries: readonly PlaylistImportEntry[],
    warnings: string[] = []
  ): PlaylistImportApplyResult {
    return applyPlaylistEntryBatch([{ name, entries, warnings }])[0]
  }

  function applyPlaylistEntryBatch(
    batch: readonly {
      name: string
      entries: readonly PlaylistImportEntry[]
      warnings?: string[]
    }[]
  ): PlaylistImportApplyResult[] {
    if (batch.length === 0) return []
    // Validate all names before mutating, and share the index and transaction
    // snapshots across the whole batch rather than copying every growing prefix.
    const normalizedNames = batch.map((item) => normalizePlaylistName(item.name))
    const byPath = new Map<string, Track>()
    for (const track of tracks.value)
      byPath.set(normalizePortableLibraryPath(track.filePath), track)
    const resolved = batch.map(({ entries, warnings = [] }, index) => {
      const imported: Track[] = []
      let unresolvedEntries = 0
      for (const entry of entries) {
        const normalizedPath = normalizePortableLibraryPath(entry.path)
        let matched = byPath.get(normalizedPath)
        if (!matched && !/^[a-zA-Z]:\\/.test(normalizedPath) && !normalizedPath.startsWith('\\')) {
          const suffix = `\\${normalizedPath}`
          const candidates = tracks.value.filter((track) =>
            normalizePortableLibraryPath(track.filePath).endsWith(suffix)
          )
          if (candidates.length === 1) matched = candidates[0]
        }
        if (matched) imported.push(matched)
        else unresolvedEntries++
      }
      return { name: normalizedNames[index], imported, unresolvedEntries, warnings }
    })
    return applyResolvedImports(resolved)
  }

  function applyResolvedImports(
    batch: readonly {
      name: string
      imported: Track[]
      unresolvedEntries: number
      warnings: string[]
    }[]
  ): PlaylistImportApplyResult[] {
    const base = clonePlaylistSnapshot()
    let batchChanged = false
    const results = batch.map(({ name: normalizedName, imported, unresolvedEntries, warnings }) => {
      const existing = findLocalPlaylistByName(normalizedName)
      const playlist = existing ?? ensurePlaylist(normalizedName)
      const changed = appendTracksToPlaylist(playlist, imported)
      if (changed || !existing) {
        touchPlaylist(playlist)
        batchChanged = true
      }
      return {
        playlistId: playlist.id,
        importedCount: imported.length,
        unresolvedEntries,
        warnings
      }
    })
    if (batchChanged) queuePlaylistPersistence(base)
    return results
  }

  async function importPlaylistEntryBatchAsync(
    batch: readonly {
      name: string
      entries: readonly PlaylistImportEntry[]
      warnings?: string[]
    }[]
  ): Promise<PlaylistImportApplyResult[]> {
    if (!batch.length) return []
    const names = batch.map((item) => normalizePlaylistName(item.name))
    const targets = names.map((name) => findLocalPlaylistByName(name)?.id)
    const resolved = await options.resolveImportPaths?.(
      batch.flatMap((item) => item.entries.map((entry) => entry.path))
    )
    for (let i = 0; i < names.length; i++)
      if (targets[i] && findLocalPlaylistByName(names[i])?.id !== targets[i])
        throw new Error('目标歌单已被重命名或删除，请重新导入')
    if (resolved == null) return applyPlaylistEntryBatch(batch)
    if (resolved.length !== batch.reduce((total, item) => total + item.entries.length, 0))
      throw new Error('曲库返回了不完整的歌单匹配结果')
    let offset = 0
    return applyResolvedImports(
      batch.map((item, i) => {
        const matched = resolved.slice(offset, offset + item.entries.length)
        offset += item.entries.length
        return {
          name: names[i],
          imported: matched.filter((track): track is Track => track !== null),
          unresolvedEntries: matched.filter((track) => track === null).length,
          warnings: item.warnings ?? []
        }
      })
    )
  }

  async function importPlaylistDocumentAsync(
    name: string,
    fileName: string,
    contents: string
  ): Promise<PlaylistImportApplyResult> {
    const parsed = parsePlaylistDocument(contents, fileName)
    return (
      await importPlaylistEntryBatchAsync([
        { name, entries: parsed.entries, warnings: parsed.warnings }
      ])
    )[0]
  }

  function importPlaylistPathBatchAsync(
    batch: readonly { name: string; paths: readonly string[] }[]
  ): Promise<PlaylistImportApplyResult[]> {
    return importPlaylistEntryBatchAsync(
      batch.map((item) => ({ name: item.name, entries: item.paths.map((path) => ({ path })) }))
    )
  }

  /**
   * Entry point for plugin-supplied playlists (see `shared/pluginPlaylistImport`).
   * Paths are matched against the library exactly like a `#EXTINF` entry would
   * be, so a plugin never has to know local track ids.
   */
  function importPlaylistPaths(name: string, paths: readonly string[]): PlaylistImportApplyResult {
    return applyPlaylistEntries(
      name,
      paths.map((path) => ({ path }))
    )
  }

  function importPlaylistPathBatch(
    batch: readonly { name: string; paths: readonly string[] }[]
  ): PlaylistImportApplyResult[] {
    return applyPlaylistEntryBatch(
      batch.map(({ name, paths }) => ({
        name,
        entries: paths.map((path) => ({ path }))
      }))
    )
  }

  function exportPlaylistDocumentForStore(
    playlistName: string,
    format: PlaylistFileFormat
  ): string | null {
    const playlist = findLocalPlaylistByName(playlistName)
    if (!playlist) return null
    return exportPlaylistDocument(getPlaylistTracks(playlistName), format)
  }

  function repairPlaylistMissingTracks(
    playlistName: string,
    candidates: Track[]
  ): PlaylistRelocationResult {
    const playlist = findLocalPlaylistByName(playlistName)
    if (!playlist) return { relocations: [], unresolvedTrackIds: [], ambiguousTrackIds: [] }
    const missing = playlist.trackIds
      .filter((id) => !trackById.has(id))
      .map((id) => playlist.trackSnapshots?.[id])
      .filter((track): track is Track => !!track && getTrackSource(track) === 'local')
    const result = findPlaylistRelocations(missing, candidates)
    return applyPlaylistRelocations(playlist, result)
  }

  async function exportPlaylistDocumentAsync(
    playlistName: string,
    format: PlaylistFileFormat
  ): Promise<string | null> {
    const playlist = findLocalPlaylistByName(playlistName)
    if (!playlist) return null
    const id = playlist.id,
      ids = playlist.trackIds.slice(),
      snapshots = playlist.trackSnapshots
    const document = await options.exportDocument?.(playlist, format)
    const current = findLocalPlaylistByName(playlistName)
    if (
      current?.id !== id ||
      !playlistDataEqual(current.trackIds, ids) ||
      !playlistDataEqual(current.trackSnapshots, snapshots)
    )
      throw new Error('歌单在导出期间发生变化，请重试')
    return document ?? exportPlaylistDocumentForStore(playlistName, format)
  }

  /** ID-based asynchronous entry point for current UI consumers. The old
   * synchronous by-name command retains its complete JSON-library contract. */
  async function repairPlaylistMissingTracksAsync(
    playlistId: string,
    candidates: Track[] | string
  ): Promise<PlaylistRelocationResult> {
    const original = playlists.value.find(
      (item) => item.id === playlistId && !isAggregatePlaylist(item)
    )
    if (!original) throw new Error('目标歌单已不存在，请重新修复')
    const name = original.name,
      ids = original.trackIds.slice(),
      snapshots = original.trackSnapshots ? clonePlaylist(original.trackSnapshots) : undefined
    const present = await options.readTrackPresence?.(ids)
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist || playlist.name !== name || isAggregatePlaylist(playlist))
      throw new Error('目标歌单已被重命名或删除，请重新修复')
    if (present == null && typeof candidates !== 'string')
      return repairPlaylistMissingTracks(name, candidates)
    const currentIds = new Set(playlist.trackIds)
    const missing: Track[] = []
    for (const id of ids) {
      if (!currentIds.has(id) || (present ?? trackById).has(id)) continue
      const snapshot = snapshots?.[id]
      if (!snapshot || getTrackSource(snapshot) !== 'local') continue
      if (!playlistDataEqual(snapshot, playlist.trackSnapshots?.[id]))
        throw new Error('歌单曲目在检查期间发生变化，请重新修复')
      missing.push(snapshot)
    }
    if (typeof candidates !== 'string')
      return applyPlaylistRelocations(playlist, findPlaylistRelocations(missing, candidates))
    if (!options.findRelocationsInFolder) throw new Error('歌单目录修复尚不可用')
    const result = await options.findRelocationsInFolder(missing, candidates)
    // A long directory scan may outlive library changes. Re-read exact missing
    // membership, then commit synchronously only against unchanged snapshots.
    const nowPresent =
      present == null
        ? trackById
        : await options.readTrackPresence!(missing.map((track) => track.id))
    if (nowPresent == null) throw new Error('曲库存储在修复期间发生变化，请重试')
    if (present != null && missing.some((track) => nowPresent.has(track.id)))
      throw new Error('曲库在修复期间发生变化，请重新检查缺失文件')
    const current = playlists.value.find((item) => item.id === playlistId)
    if (!current || current.name !== name || isAggregatePlaylist(current))
      throw new Error('目标歌单已被重命名或删除，请重新修复')
    const kept = new Set(current.trackIds)
    for (const track of missing)
      if (
        kept.has(track.id) &&
        !playlistDataEqual(snapshots?.[track.id], current.trackSnapshots?.[track.id])
      )
        throw new Error('歌单曲目在修复期间发生变化，请重新修复')
    result.relocations = result.relocations.filter(
      (item) => kept.has(item.trackId) && !nowPresent.has(item.trackId)
    )
    result.unresolvedTrackIds = result.unresolvedTrackIds.filter(
      (id) => kept.has(id) && !nowPresent.has(id)
    )
    result.ambiguousTrackIds = result.ambiguousTrackIds.filter(
      (id) => kept.has(id) && !nowPresent.has(id)
    )
    return applyPlaylistRelocations(current, result)
  }

  function applyPlaylistRelocations(
    playlist: Playlist,
    result: PlaylistRelocationResult
  ): PlaylistRelocationResult {
    if (result.relocations.length === 0) return result
    const base = clonePlaylistSnapshot()
    const replacements = new Map(result.relocations.map((item) => [item.trackId, item.toTrack]))
    const nextTrackIds: string[] = []
    const snapshots: Record<string, Track> = { ...(playlist.trackSnapshots ?? {}) }
    const seen = new Set<string>()
    for (const id of playlist.trackIds) {
      const replacement = replacements.get(id)
      const nextId = replacement?.id ?? id
      if (seen.has(nextId)) continue
      seen.add(nextId)
      nextTrackIds.push(nextId)
      if (replacement) {
        delete snapshots[id]
        snapshots[nextId] = toPlaylistTrackSnapshot(replacement)
      }
    }
    playlist.trackIds = nextTrackIds
    playlist.trackSnapshots = nonEmptySnapshots(snapshots)
    touchPlaylist(playlist)
    queuePlaylistPersistence(base)
    return result
  }

  function deletePlaylist(playlistId: string): void {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl || pl.isDefault) return
    const base = clonePlaylistSnapshot()
    playlists.value = playlists.value.filter((p) => p.id !== playlistId)
    queuePlaylistPersistence(base)
  }

  function addToPlaylist(playlistName: string, trackId: string, trackSnapshot?: Track): void {
    const track = trackSnapshot ?? trackById.get(trackId)
    if (track) {
      addTracksToPlaylist(playlistName, [track])
      return
    }
    const playlist = findLocalPlaylistByName(playlistName)
    if (!playlist || playlist.trackIds.includes(trackId)) return
    const base = clonePlaylistSnapshot()
    playlist.trackIds = [...playlist.trackIds, trackId]
    queuePlaylistPersistence(base)
  }

  function appendTracksToPlaylist(playlist: Playlist, playlistTracks: Track[]): boolean {
    if (playlist.imported) {
      if (playlist.imported.entries.length + playlistTracks.length > 20_000)
        throw new Error('歌单超过 20,000 条上限')
      const offset = playlist.imported.entries.length
      playlist.imported = withExternalMembership(playlist.imported, [
        ...playlist.imported.entries,
        ...playlistTracks.map((track, index) => externalEntryForTrack(track, offset + index))
      ])
      return playlistTracks.length > 0
    }
    const knownIds = new Set(playlist.trackIds)
    const nextTrackIds = playlist.trackIds.slice()
    const nextSnapshots = { ...(playlist.trackSnapshots ?? {}) }
    let changed = false
    for (const track of playlistTracks) {
      if (!knownIds.has(track.id)) {
        knownIds.add(track.id)
        nextTrackIds.push(track.id)
        changed = true
      }
      const snapshot = toPlaylistTrackSnapshot(track)
      if (!nextSnapshots[track.id]) {
        nextSnapshots[track.id] = snapshot
        changed = true
      }
    }
    if (!changed) return false
    playlist.trackIds = nextTrackIds
    playlist.trackSnapshots = nonEmptySnapshots(nextSnapshots)
    return true
  }

  function addTracksToPlaylistRecord(playlist: Playlist, playlistTracks: Track[]): number {
    if (playlistTracks.length === 0) return 0
    const base = clonePlaylistSnapshot()
    const beforeCount = playlist.imported?.entries.length ?? playlist.trackIds.length
    const changed = appendTracksToPlaylist(playlist, playlistTracks)
    if (changed) queuePlaylistPersistence(base)
    return (playlist.imported?.entries.length ?? playlist.trackIds.length) - beforeCount
  }

  function addTracksToPlaylist(playlistName: string, playlistTracks: Track[]): number {
    const playlist = findLocalPlaylistByName(playlistName)
    return playlist ? addTracksToPlaylistRecord(playlist, playlistTracks) : 0
  }

  function addTracksToPlaylistById(playlistId: string, playlistTracks: Track[]): number {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    return playlist ? addTracksToPlaylistRecord(playlist, playlistTracks) : 0
  }

  function removeFromPlaylist(playlistName: string, trackId: string): void {
    removeTracksFromPlaylist(playlistName, [trackId])
  }

  function removeTracksFromPlaylistRecord(playlist: Playlist, trackIds: Iterable<string>): number {
    const removedIds = new Set(trackIds)
    if (playlist.imported) {
      const selected = playlist.imported.entries
        .filter(
          (e) =>
            removedIds.has(e.entryId) ||
            (e.resolution.track && removedIds.has(e.resolution.track.id))
        )
        .map((e) => e.entryId)
      external.removeExternalEntries(playlist.id, selected)
      return selected.length
    }
    if (removedIds.size === 0) return 0
    const nextTrackIds = playlist.trackIds.filter((trackId) => !removedIds.has(trackId))
    const removedCount = playlist.trackIds.length - nextTrackIds.length
    if (removedCount === 0) return 0
    const base = clonePlaylistSnapshot()
    playlist.trackIds = nextTrackIds
    if (playlist.trackSnapshots) {
      const nextSnapshots = { ...playlist.trackSnapshots }
      for (const trackId of removedIds) delete nextSnapshots[trackId]
      playlist.trackSnapshots = nonEmptySnapshots(nextSnapshots)
    }
    queuePlaylistPersistence(base)
    return removedCount
  }

  function removeTracksFromPlaylist(playlistName: string, trackIds: Iterable<string>): number {
    const playlist = findLocalPlaylistByName(playlistName)
    return playlist ? removeTracksFromPlaylistRecord(playlist, trackIds) : 0
  }

  function removeTracksFromPlaylistById(playlistId: string, trackIds: Iterable<string>): number {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    return playlist ? removeTracksFromPlaylistRecord(playlist, trackIds) : 0
  }

  function getDefaultFavoritePlaylist(): Playlist | null {
    return (
      playlists.value.find((playlist) => playlist.isDefault) ??
      findLocalPlaylistByName(DEFAULT_FAVORITE_PLAYLIST_NAME) ??
      null
    )
  }

  function isFavoriteTrack(track: Track): boolean {
    const playlist = getDefaultFavoritePlaylist()
    if (!playlist) return false
    const identity = getPlaylistIdentity(playlist)
    if (identity.ids.has(track.id)) return true
    const candidates = identity.snapshotsByLogicalKey.get(getLogicalTrackKey(track))
    return candidates?.some((candidate) => canShareTrackIdentity(candidate, track)) ?? false
  }

  function addFavoriteTrack(track: Track): boolean {
    return setFavoriteTracks([track], true) > 0
  }

  function removeFavoriteTrack(track: Track): boolean {
    return setFavoriteTracks([track], false) > 0
  }

  function setFavoriteTracks(favoriteTracks: Track[], favorite: boolean): number {
    if (favoriteTracks.length === 0) return 0
    const playlist = getDefaultFavoritePlaylist()
    if (favorite) {
      const base = clonePlaylistSnapshot()
      const target = playlist ?? ensurePlaylist(DEFAULT_FAVORITE_PLAYLIST_NAME, { isDefault: true })
      const identity = getPlaylistIdentity(target)
      const knownIds = new Set(identity.ids)
      // Copy the buckets: the map above is cached and must not be mutated.
      const knownByLogicalKey = new Map<string, Track[]>()
      for (const [key, snapshots] of identity.snapshotsByLogicalKey) {
        knownByLogicalKey.set(key, [...snapshots])
      }
      const toAdd = favoriteTracks.filter((track) => {
        if (knownIds.has(track.id)) return false
        const logicalKey = getLogicalTrackKey(track)
        const known = knownByLogicalKey.get(logicalKey)
        if (known?.some((candidate) => canShareTrackIdentity(candidate, track))) return false
        knownIds.add(track.id)
        if (known) known.push(track)
        else knownByLogicalKey.set(logicalKey, [track])
        return true
      })
      const created = !playlist
      const added = appendTracksToPlaylist(target, toAdd)
      if (created || added) queuePlaylistPersistence(base)
      return toAdd.length
    }

    if (!playlist) return 0
    const ids = new Set(favoriteTracks.map((track) => track.id))
    // Mirror the add/query rule: drop the entries that are this recording, and
    // leave a same-titled neighbour alone.
    const requestedByLogicalKey = new Map<string, Track[]>()
    for (const track of favoriteTracks) {
      const key = getLogicalTrackKey(track)
      const bucket = requestedByLogicalKey.get(key)
      if (bucket) bucket.push(track)
      else requestedByLogicalKey.set(key, [track])
    }
    const nextTrackIds = playlist.trackIds.filter((trackId) => {
      if (ids.has(trackId)) return false
      const snapshot = getPlaylistTrackSnapshot(playlist, trackId)
      if (!snapshot) return true
      const requested = requestedByLogicalKey.get(getLogicalTrackKey(snapshot))
      return !requested?.some((track) => canShareTrackIdentity(track, snapshot))
    })
    const removedCount = playlist.trackIds.length - nextTrackIds.length
    if (removedCount === 0) return 0
    const base = clonePlaylistSnapshot()
    const keptTrackIds = new Set(nextTrackIds)
    playlist.trackIds = nextTrackIds
    if (playlist.trackSnapshots) {
      const snapshots = { ...playlist.trackSnapshots }
      for (const trackId of Object.keys(snapshots)) {
        if (!keptTrackIds.has(trackId)) delete snapshots[trackId]
      }
      playlist.trackSnapshots = nonEmptySnapshots(snapshots)
    }
    queuePlaylistPersistence(base)
    return removedCount
  }

  function getPlaylistTracks(playlistName: string): Track[] {
    const pl = findLocalPlaylistByName(playlistName)
    return pl ? resolvePlaylistTracks(pl) : []
  }

  function getPlaylistTracksById(playlistId: string): Track[] {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl) return []
    return resolvePlaylistTracks(pl, isAggregatePlaylist(pl))
  }

  function createAggregatePlaylist(name: string): string {
    const normalizedName = normalizePlaylistName(name)
    // 聚合歌单与普通歌单是两个命名空间，所以只在聚合歌单里查重——用户不该因为
    // 某个普通歌单占了名字而没法这么叫自己的聚合歌单。
    const existing = playlists.value.find(
      (playlist) => isAggregatePlaylist(playlist) && playlist.name === normalizedName
    )
    if (existing) return existing.id
    const base = clonePlaylistSnapshot()
    const playlist: Playlist = {
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: normalizedName,
      trackIds: [],
      kind: 'aggregate',
      createdAt: new Date().toISOString()
    }
    playlists.value = [...playlists.value, playlist]
    queuePlaylistPersistence(base)
    return playlist.id
  }

  function setPlaylistPinned(playlistId: string, pinned: boolean): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) return false
    // 重复置顶不刷新时间戳，否则同一个按钮点两下会让列表无意义地重排。
    if (pinned === !!playlist.pinnedAt) return false
    return updatePlaylist(playlist, { pinnedAt: pinned ? new Date().toISOString() : null })
  }

  function setPlaylistHiddenSources(playlistId: string, sources: string[]): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) return false
    const normalized = Array.from(new Set(sources.map((source) => source.trim()).filter(Boolean)))
    const nextValue = normalized.length > 0 ? normalized : undefined
    if (playlistDataEqual(playlist.hiddenSources, nextValue)) return false
    return updatePlaylist(playlist, { hiddenSources: nextValue })
  }

  function setPlaylistVariantPreference(
    playlistId: string,
    anchorTrackId: string,
    source: string | null
  ): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist || !anchorTrackId) return false
    const current = playlist.variantPreferences ?? {}
    const normalizedSource = source?.trim() || null
    if ((current[anchorTrackId] ?? null) === normalizedSource) return false
    const next = { ...current }
    if (normalizedSource) next[anchorTrackId] = normalizedSource
    else delete next[anchorTrackId]
    return updatePlaylist(playlist, {
      variantPreferences: Object.keys(next).length > 0 ? next : undefined
    })
  }
  return {
    ...state,
    ...external,
    ...pageCommands,
    createPlaylist,
    createPlaylistWithTracks,
    createPlaylistWithTrackPages,
    createAggregatePlaylistWithTrackPages,
    addTrackPagesToPlaylistById,
    renamePlaylist,
    setPlaylistCover,
    copyPlaylist,
    reorderPlaylistTracks,
    movePlaylistTracks,
    importPlaylistDocument,
    importPlaylistDocumentAsync,
    importPlaylistPathBatchAsync,
    importPlaylistPaths,
    importPlaylistPathBatch,
    exportPlaylistDocument: exportPlaylistDocumentForStore,
    exportPlaylistDocumentAsync,
    repairPlaylistMissingTracks,
    repairPlaylistMissingTracksAsync,
    deletePlaylist,
    addToPlaylist,
    addTracksToPlaylist,
    addTracksToPlaylistById,
    removeFromPlaylist,
    removeTracksFromPlaylist,
    removeTracksFromPlaylistById,
    isFavoriteTrack,
    addFavoriteTrack,
    removeFavoriteTrack,
    setFavoriteTracks,
    getPlaylistTracks,
    getPlaylistTracksById,
    createAggregatePlaylist,
    setPlaylistPinned,
    setPlaylistHiddenSources,
    setPlaylistVariantPreference
  }
}
