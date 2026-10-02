import { toRaw, triggerRef, type Ref } from 'vue'
import type { Playlist, PlaylistPersistenceNotice } from './musicStoreTypes.ts'
import { PlaylistPersistence, type PlaylistPersistenceStatus } from '../playlistPersistence.ts'
import {
  isVersionedDataEnvelope,
  isPersistentDataRevisionConflict,
  type VersionedDataEnvelope
} from '../../../../shared/versionedPersistence.ts'
import {
  playlistDataEqual,
  replayPlaylistTransaction,
  slimPlaylistLegacySnapshots
} from './musicStoreData.ts'

/** Own the save queue, authoritative revision and conflict recovery together. */
export function createPlaylistState({
  playlists,
  playlistPersistenceStatus,
  playlistPersistenceNotice,
  onChange
}: {
  playlists: Ref<Playlist[]>
  playlistPersistenceStatus: Ref<PlaylistPersistenceStatus>
  playlistPersistenceNotice: Ref<PlaylistPersistenceNotice | null>
  onChange: () => void
}) {
  let playlistsRevision = 0
  let playlistAuthoritativeSnapshot: Playlist[] = []
  let playlistPersistence: PlaylistPersistence<Playlist[]> | null = null

  function clonePlaylistSnapshot(source: Playlist[] = playlists.value): Playlist[] {
    // Freeze the queued transaction and strip Vue proxies before it reaches the
    // persistence queue. toRaw unwraps the reactive root (nested storage stays
    // raw); the JSON fallback covers a reactive proxy ever nested in the tree,
    // which Chromium's structuredClone serializer rejects outright.
    const raw = toRaw(source)
    try {
      return structuredClone(raw)
    } catch {
      return JSON.parse(JSON.stringify(raw)) as Playlist[]
    }
  }

  function getPlaylistPersistence(): PlaylistPersistence<Playlist[]> {
    if (playlistPersistence) return playlistPersistence
    playlistPersistence = new PlaylistPersistence({
      write: persistPlaylistSnapshot,
      onStatus: (status) => {
        playlistPersistenceStatus.value = status
      },
      flushDelayMs: 250,
      retryDelayMs: 1_000,
      // queuePlaylistPersistence only ever enqueues clonePlaylistSnapshot()
      // results (frozen plain data), so the queue does not need to re-clone.
      cloneSnapshot: (snapshot) => snapshot
    })
    return playlistPersistence
  }

  function queuePlaylistPersistence(
    base = clonePlaylistSnapshot(playlistAuthoritativeSnapshot)
  ): void {
    onChange()
    // playlists 是 shallowRef：就地修改（trackIds/trackSnapshots/name/cover）不会
    // 自动通知，所有变更路径都在此汇合，统一触发。
    triggerRef(playlists)
    getPlaylistPersistence().enqueue(clonePlaylistSnapshot(), base)
  }

  function isPlaylistData(value: unknown): value is Playlist[] {
    return Array.isArray(value)
  }

  async function loadPlaylistEnvelopeForConflict(): Promise<VersionedDataEnvelope<
    Playlist[]
  > | null> {
    const loaded = await window.api.data.loadPlaylists()
    return isVersionedDataEnvelope(loaded, isPlaylistData) ? loaded : null
  }

  async function persistPlaylistSnapshot(snapshot: Playlist[], base: Playlist[]): Promise<void> {
    let expectedRevision = playlistsRevision
    // A preceding queued write may have recovered a CAS conflict while this
    // transaction was waiting. In that case `base` predates the newly merged
    // authoritative snapshot even though `expectedRevision` is current. Replay
    // the local delta before the first attempt so the next successful write
    // cannot silently erase data recovered by the previous transaction.
    let desired = playlistDataEqual(base, playlistAuthoritativeSnapshot)
      ? snapshot
      : replayPlaylistTransaction(base, snapshot, playlistAuthoritativeSnapshot)
    let recoveredConflictRevision: number | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = await window.api.data.savePlaylists(desired, expectedRevision)
        if (isVersionedDataEnvelope(saved, isPlaylistData)) {
          playlistsRevision = saved.revision
          playlistAuthoritativeSnapshot = clonePlaylistSnapshot(saved.data)
          // Do not overwrite an action that arrived while this write was in flight.
          if (playlistDataEqual(playlists.value, snapshot)) {
            playlists.value = clonePlaylistSnapshot(saved.data)
            onChange()
          }
        } else {
          playlistAuthoritativeSnapshot = clonePlaylistSnapshot(desired)
        }
        if (recoveredConflictRevision !== null) {
          playlistPersistenceNotice.value = {
            kind: 'revision-conflict-recovered',
            message: '检测到歌单被其他窗口更新，已合并权威版本并保存本次修改',
            authoritativeRevision: recoveredConflictRevision,
            recoveredAt: new Date().toISOString()
          }
        }
        return
      } catch (error) {
        if (!isPersistentDataRevisionConflict(error)) throw error
        const current = isVersionedDataEnvelope(error.current, isPlaylistData)
          ? error.current
          : await loadPlaylistEnvelopeForConflict()
        if (!current) throw error
        // Reapply only the immutable local delta to the authoritative snapshot.
        // Sending the old whole-file snapshot here would erase concurrent edits.
        desired = replayPlaylistTransaction(base, snapshot, current.data)
        playlistsRevision = current.revision
        expectedRevision = current.revision
        recoveredConflictRevision = current.revision
      }
    }
    throw new Error('Playlist persistence revision conflict did not settle after 3 retries')
  }

  async function savePlaylists(): Promise<void> {
    queuePlaylistPersistence()
  }

  async function flushPlaylists(): Promise<boolean> {
    return getPlaylistPersistence().flush()
  }

  async function loadPlaylists(): Promise<void> {
    const loadedResult = await window.api.data.loadPlaylists()
    const saved = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.data
      : loadedResult
    playlistsRevision = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.revision
      : 0
    const DEFAULT_PLAYLIST: Playlist = {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      trackIds: [],
      isDefault: true,
      createdAt: new Date().toISOString()
    }

    if (!saved || !Array.isArray(saved) || saved.length === 0) {
      // First launch: create default playlist
      playlists.value = [DEFAULT_PLAYLIST]
      playlistAuthoritativeSnapshot = []
      queuePlaylistPersistence([])
      return
    }

    // 旧版本保存的歌单快照可能携带歌词全文 / bpmAnalysis / metadataMatch，
    // 加载时统一瘦身，避免数十 MB 载荷随歌单驻留。
    const loaded = (saved as Playlist[]).map(slimPlaylistLegacySnapshots)
    // Ensure default playlist exists
    if (!loaded.find((p) => p.isDefault)) {
      loaded.unshift(DEFAULT_PLAYLIST)
    }
    playlists.value = loaded
    playlistAuthoritativeSnapshot = clonePlaylistSnapshot(loaded)
  }
  return {
    clonePlaylistSnapshot,
    queuePlaylistPersistence,
    savePlaylists,
    flushPlaylists,
    loadPlaylists
  }
}
