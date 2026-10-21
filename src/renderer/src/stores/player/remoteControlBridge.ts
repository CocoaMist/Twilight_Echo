import type { Ref } from 'vue'
import type { Track } from '../../types/music.ts'
import type { PlayMode } from '../../types/settings.ts'
import type {
  LibraryDatabaseApi,
  LibraryQuery,
  LibraryQueuePage,
  LibraryQueueReadOptions,
  LibraryQueueSnapshot,
  LibraryTrackRecord
} from '../../../../shared/libraryDatabase.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import type {
  PlayerRemoteCommand,
  RemoteBrowseItem,
  RemoteBrowseRequest,
  RemoteBrowseResult,
  RemotePlayMode
} from '../../../../shared/remoteControl.ts'

interface RemotePlaylist {
  id: string
  name: string
  trackIds: string[]
}

type RemoteLibraryApi = Pick<
  LibraryDatabaseApi,
  'queryTracks' | 'queryCollections' | 'getTracksByIds' | 'readLibraryQueue'
>

export interface RemoteControlBridgeOptions {
  tracks: Ref<Track[]>
  playlists: Ref<RemotePlaylist[]>
  getPlaylistTracks: (playlistId: string) => Track[]
  queue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  playTrack: (track: Track, trackList?: Track[]) => Promise<void>
  enqueueTrack: (track: Track) => void | Promise<void>
  jumpQueue: (index: number) => void
  removeQueueItem: (index: number) => void
  setPlayMode: (mode: PlayMode) => void
  /** SQLite preview owns the complete library outside the renderer array. */
  getStorageMode?: () => Promise<'json' | 'sqlite'>
  database?: RemoteLibraryApi
  playLibraryQuery?: (query: LibraryQuery, selectedId: string) => Promise<void>
  enqueueLibraryTrack?: (id: string) => Promise<void> | void
  queryLibraryPlaylist?: (
    playlistId: string,
    request: RemoteBrowseRequest
  ) => Promise<{
    page: import('../../../../shared/libraryDatabase.ts').LibraryPage
    query: LibraryQuery
  }>
  getLibraryQueue?: () => LibraryQueueSnapshot | null
  readLibraryQueue?: RemoteLibraryApi['readLibraryQueue']
}

interface TrackToken {
  trackId: string
  playlistId?: string
}

type LibraryToken = {
  id: string
  query: LibraryQuery
  queue?: { id: string; revision: number }
}

const toRemoteMode = (mode: PlayMode): RemotePlayMode => {
  if (mode === 'listLoop') return 'loop'
  if (mode === 'repeat') return 'single'
  return mode === 'shuffle' ? 'shuffle' : 'sequence'
}

const toDesktopMode = (mode: RemotePlayMode): PlayMode => {
  if (mode === 'loop') return 'listLoop'
  if (mode === 'single') return 'repeat'
  return mode === 'shuffle' ? 'shuffle' : 'sequential'
}

const remoteId = (): string => crypto.randomUUID()

function trackItem(id: string, track: Track, index?: number): RemoteBrowseItem {
  return {
    id,
    title: track.title || '未知曲目',
    artist: track.artist || '未知艺术家',
    album: track.album || '',
    duration: Math.max(0, Number(track.duration) || 0),
    ...(index === undefined ? {} : { index })
  }
}

function matches(track: Track, needle: string): boolean {
  if (!needle) return true
  return (
    String(track.title ?? '')
      .toLocaleLowerCase('zh-CN')
      .includes(needle) ||
    String(track.artist ?? '')
      .toLocaleLowerCase('zh-CN')
      .includes(needle) ||
    String(track.album ?? '')
      .toLocaleLowerCase('zh-CN')
      .includes(needle)
  )
}

export function createRemoteControlBridge(options: RemoteControlBridgeOptions): {
  /** JSON callers receive a value; SQLite callers receive an awaited value from the IPC handler. */
  browse: (request: RemoteBrowseRequest) => RemoteBrowseResult
  command: (command: PlayerRemoteCommand) => Promise<void>
  snapshot: () => { playMode: RemotePlayMode; queueRevision: number }
} {
  const trackTokens = new Map<string, TrackToken>()
  const tokenByTrackContext = new Map<string, string>()
  const playlistTokens = new Map<string, string>()
  const tokenByPlaylistId = new Map<string, string>()
  const libraryTokens = new Map<string, LibraryToken>()
  let indexedTracks: readonly Track[] | null = null
  let tracksById = new Map<string, Track>()
  let indexedPlaylists: readonly RemotePlaylist[] | null = null
  let playlistsById = new Map<string, RemotePlaylist>()
  let knownQueue: readonly Track[] | null = null
  let queueRevision = 0

  const refreshTrackIndex = (): void => {
    if (indexedTracks === options.tracks.value) return
    indexedTracks = options.tracks.value
    tracksById = new Map()
    for (const track of indexedTracks) tracksById.set(track.id, track)
    for (const [token, entry] of trackTokens) {
      if (!entry.playlistId && !tracksById.has(entry.trackId)) {
        trackTokens.delete(token)
        tokenByTrackContext.delete(`\u0000${entry.trackId}`)
      }
    }
  }

  const refreshPlaylistIndex = (): void => {
    if (indexedPlaylists === options.playlists.value) return
    indexedPlaylists = options.playlists.value
    playlistsById = new Map()
    for (const playlist of indexedPlaylists) playlistsById.set(playlist.id, playlist)
    for (const [token, playlistId] of playlistTokens) {
      if (!playlistsById.has(playlistId)) {
        playlistTokens.delete(token)
        tokenByPlaylistId.delete(playlistId)
        for (const [trackToken, entry] of trackTokens) {
          if (entry.playlistId !== playlistId) continue
          trackTokens.delete(trackToken)
          tokenByTrackContext.delete(`${playlistId}\u0000${entry.trackId}`)
        }
      }
    }
  }

  const refreshQueueRevision = (): number => {
    if (knownQueue === options.queue.value) return queueRevision
    knownQueue = options.queue.value
    queueRevision++
    return queueRevision
  }

  const tokenForTrack = (track: Track, playlistId?: string): string => {
    const context = `${playlistId ?? ''}\u0000${track.id}`
    const known = tokenByTrackContext.get(context)
    if (known && trackTokens.has(known)) return known
    const token = remoteId()
    trackTokens.set(token, { trackId: track.id, ...(playlistId ? { playlistId } : {}) })
    tokenByTrackContext.set(context, token)
    return token
  }

  const tokenForPlaylist = (playlist: RemotePlaylist): string => {
    const known = tokenByPlaylistId.get(playlist.id)
    if (known && playlistTokens.has(known)) return known
    const token = remoteId()
    playlistTokens.set(token, playlist.id)
    tokenByPlaylistId.set(playlist.id, token)
    return token
  }

  const playlistTracks = (playlistId: string): Track[] => {
    if (!playlistsById.has(playlistId)) throw new Error('playlist_not_found')
    return options.getPlaylistTracks(playlistId)
  }

  const databasePageItem = (token: string, record: LibraryTrackRecord, index?: number) => {
    const track = libraryTrack(record)
    return trackItem(token, track, index)
  }

  const databaseQuery = (request: RemoteBrowseRequest): LibraryQuery => ({
    search: request.query,
    ...(request.query.trim() ? { searchLiteral: true } : {}),
    sort: 'insertion',
    direction: 'asc',
    offset: request.offset,
    limit: request.limit
  })

  async function browseDatabase(request: RemoteBrowseRequest): Promise<RemoteBrowseResult> {
    if (!options.database) throw new Error('library_database_unavailable')
    if (request.view === 'library') {
      const query = databaseQuery(request)
      const { offset: _offset, limit: _limit, ...fullQuery } = query
      const page = await options.database.queryTracks(query)
      const items = page.tracks.map((record) => {
        const token = remoteId()
        libraryTokens.set(token, { id: record.id, query: fullQuery })
        return databasePageItem(token, record, undefined)
      })
      return {
        items,
        total: page.total,
        offset: page.offset,
        limit: request.limit,
        revision: page.revision
      }
    }
    if (request.view === 'queue') {
      const queue = options.getLibraryQueue?.()
      const read = options.readLibraryQueue ?? options.database.readLibraryQueue
      if (!queue)
        return { items: [], total: 0, offset: request.offset, limit: request.limit, revision: 0 }
      const readOptions: LibraryQueueReadOptions = {
        expectedRevision: queue.revision,
        ...(request.query.trim() ? { search: request.query } : {})
      }
      const page: LibraryQueuePage = await read(
        queue.id,
        request.offset,
        request.limit,
        readOptions
      )
      const items = page.items.flatMap((entry) => {
        if (!entry.track) return []
        const token = remoteId()
        libraryTokens.set(token, {
          id: entry.track.id,
          query: {},
          queue: { id: queue.id, revision: page.revision }
        })
        return [databasePageItem(token, entry.track, entry.position)]
      })
      return {
        items,
        total: page.total,
        offset: page.offset,
        limit: request.limit,
        revision: page.revision
      }
    }
    if (request.playlistId && options.queryLibraryPlaylist) {
      const playlistId = playlistTokens.get(request.playlistId)
      if (!playlistId) throw new Error('playlist_not_found')
      const { page, query } = await options.queryLibraryPlaylist(playlistId, request)
      const items = page.tracks.map((record) => {
        const token = remoteId()
        libraryTokens.set(token, { id: record.id, query })
        return databasePageItem(token, record)
      })
      return {
        items,
        total: page.total,
        offset: page.offset,
        limit: request.limit,
        revision: page.revision
      }
    }
    // Playlist headers remain the lightweight persisted playlist configuration;
    // track details are still resolved only after the user opens a playlist.
    refreshPlaylistIndex()
    const needle = request.query.trim().toLocaleLowerCase('zh-CN')
    const items: RemoteBrowseItem[] = []
    let total = 0
    const end = request.offset + request.limit
    for (const playlist of options.playlists.value) {
      if (!playlist.name.toLocaleLowerCase('zh-CN').includes(needle)) continue
      if (total >= request.offset && total < end) {
        const token = tokenForPlaylist(playlist)
        items.push({
          id: token,
          title: playlist.name || '未命名歌单',
          artist: '',
          album: '',
          duration: 0,
          trackCount: playlist.trackIds.length
        })
      }
      total++
    }
    return { items, total, offset: request.offset, limit: request.limit }
  }

  const browseTracks = (
    source: readonly Track[],
    request: RemoteBrowseRequest,
    playlistId?: string,
    revision?: number
  ): RemoteBrowseResult => {
    const needle = request.query.trim().toLocaleLowerCase('zh-CN')
    const items: RemoteBrowseItem[] = []
    let total = 0
    const end = request.offset + request.limit
    for (let index = 0; index < source.length; index++) {
      const track = source[index]
      if (!matches(track, needle)) continue
      if (total >= request.offset && total < end) {
        items.push(
          trackItem(
            tokenForTrack(track, playlistId),
            track,
            request.view === 'queue' ? index : undefined
          )
        )
      }
      total++
    }
    return {
      items,
      total,
      offset: request.offset,
      limit: request.limit,
      ...(revision === undefined ? {} : { revision })
    }
  }

  return {
    browse(request) {
      if (options.database && options.getStorageMode)
        return options
          .getStorageMode()
          .then((mode) =>
            mode === 'sqlite' ? browseDatabase(request) : browseLegacy(request)
          ) as unknown as RemoteBrowseResult
      return browseLegacy(request)
    },
    async command(command) {
      if (
        options.database &&
        options.getStorageMode &&
        (await options.getStorageMode()) === 'sqlite'
      ) {
        const library = libraryTokens.get(
          command.action === 'playTrack' || command.action === 'enqueueTrack' ? command.id : ''
        )
        if (command.action === 'playTrack' || command.action === 'enqueueTrack') {
          if (!library) throw new Error('track_not_found')
          if (command.action === 'playTrack') {
            if (!options.playLibraryQuery) throw new Error('library_database_unavailable')
            await options.playLibraryQuery(library.query, library.id)
          } else if (options.enqueueLibraryTrack) await options.enqueueLibraryTrack(library.id)
          else throw new Error('library_database_unavailable')
          return
        }
        if (command.action === 'jumpQueue' || command.action === 'removeQueue') {
          const queue = options.getLibraryQueue?.()
          if (!queue || command.revision !== queue.revision) throw new Error('queue_changed')
          if (command.index >= queue.total) throw new Error('queue_item_not_found')
          if (command.action === 'jumpQueue') options.jumpQueue(command.index)
          else options.removeQueueItem(command.index)
          return
        }
        if (command.action === 'setPlayMode') {
          options.setPlayMode(toDesktopMode(command.mode))
          return
        }
        return
      }
      return commandLegacy(command)
    },
    snapshot: () => {
      const queue = options.getLibraryQueue?.()
      return queue
        ? { playMode: toRemoteMode(options.playMode.value), queueRevision: queue.revision }
        : { playMode: toRemoteMode(options.playMode.value), queueRevision: refreshQueueRevision() }
    }
  }

  function browseLegacy(request: RemoteBrowseRequest): RemoteBrowseResult {
    refreshTrackIndex()
    refreshPlaylistIndex()
    if (request.view === 'playlists' && !request.playlistId) {
      const needle = request.query.trim().toLocaleLowerCase('zh-CN')
      const items: RemoteBrowseItem[] = []
      let total = 0
      const end = request.offset + request.limit
      for (const playlist of options.playlists.value) {
        if (!playlist.name.toLocaleLowerCase('zh-CN').includes(needle)) continue
        if (total >= request.offset && total < end) {
          items.push({
            id: tokenForPlaylist(playlist),
            title: playlist.name || '未命名歌单',
            artist: '',
            album: '',
            duration: 0,
            trackCount: playlist.trackIds.length
          })
        }
        total++
      }
      return { items, total, offset: request.offset, limit: request.limit }
    }
    if (request.view === 'queue') {
      return browseTracks(options.queue.value, request, undefined, refreshQueueRevision())
    }
    if (request.playlistId) {
      const playlistId = playlistTokens.get(request.playlistId)
      if (!playlistId) throw new Error('playlist_not_found')
      return browseTracks(playlistTracks(playlistId), request, playlistId)
    }
    return browseTracks(options.tracks.value, request)
  }

  async function commandLegacy(command: PlayerRemoteCommand): Promise<void> {
    refreshTrackIndex()
    refreshPlaylistIndex()
    if (command.action === 'playTrack' || command.action === 'enqueueTrack') {
      const entry = trackTokens.get(command.id)
      const playlistContext = entry?.playlistId ? playlistTracks(entry.playlistId) : undefined
      const track = entry?.playlistId
        ? playlistContext?.find((candidate) => candidate.id === entry.trackId)
        : entry
          ? tracksById.get(entry.trackId)
          : undefined
      if (!entry || !track) throw new Error('track_not_found')
      if (command.action === 'playTrack') {
        await options.playTrack(track, playlistContext)
      } else await options.enqueueTrack(track)
      return
    }
    if (command.action === 'jumpQueue' || command.action === 'removeQueue') {
      if (command.revision !== refreshQueueRevision()) throw new Error('queue_changed')
      if (command.index >= options.queue.value.length) throw new Error('queue_item_not_found')
      if (command.action === 'jumpQueue') options.jumpQueue(command.index)
      else options.removeQueueItem(command.index)
      refreshQueueRevision()
      return
    }
    if (command.action === 'setPlayMode') options.setPlayMode(toDesktopMode(command.mode))
  }
}
