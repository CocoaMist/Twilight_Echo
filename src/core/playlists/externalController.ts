import type { Cell, PlaylistRuntime } from './ports.ts'
import type { TrackData as Track } from '../../shared/track.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { toPlaylistTrackSnapshot } from './data.ts'
import { withExternalMembership } from './externalMembership.ts'
import {
  EXTERNAL_PLAYLIST_MAX_ENTRIES,
  reconcileImportEntries,
  type ImportedPlaylistEntry,
  type ImportResolution,
  type ImportSong,
  type PlaylistImportDocument
} from '../../shared/externalPlaylist.ts'

export function createExternalPlaylistCommands(options: {
  runtime: PlaylistRuntime
  playlists: Cell<Playlist[]>
  clonePlaylistSnapshot(): Playlist[]
  queuePlaylistPersistence(base: Playlist[]): void
}) {
  const { runtime } = options
  const id = runtime.newId
  function mutate(playlistId: string, apply: (playlist: Playlist) => boolean) {
    const playlist = options.playlists.value.find((p) => p.id === playlistId)
    if (!playlist?.imported) return false
    const base = options.clonePlaylistSnapshot()
    if (!apply(playlist)) return false
    if (playlist.transient) runtime.notify()
    else options.queuePlaylistPersistence(base)
    return true
  }
  function uniqueName(input: string) {
    const stem = input.trim().slice(0, 70) || '导入的歌单'
    let name = stem,
      n = 2
    while (options.playlists.value.some((p) => !p.kind && p.name === name))
      name = `${stem} (${n++})`
    return name
  }
  function createExternalPlaylist(document: PlaylistImportDocument, transient = false) {
    if (document.songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES)
      throw new Error('歌单超过 20,000 条上限')
    const base = options.clonePlaylistSnapshot(),
      playlistId = `pl_${id()}`,
      now = new Date(runtime.now()).toISOString()
    options.playlists.value = [
      ...options.playlists.value,
      {
        id: playlistId,
        name: uniqueName(document.name),
        trackIds: [],
        createdAt: now,
        ...(transient ? { transient: true } : {}),
        imported: {
          version: 1,
          source: document.source,
          entries: reconcileImportEntries([], document.songs, id),
          complete: document.complete,
          expectedTotal: document.total,
          importedAt: now,
          generation: id(),
          membershipRevision: 0
        }
      }
    ]
    if (transient) runtime.notify()
    else options.queuePlaylistPersistence(base)
    return playlistId
  }
  function adoptExternalPlaylist(preview: Playlist) {
    if (!preview.imported?.complete) throw new Error('歌单尚未完整读取，完成后才能保存')
    if (options.playlists.value.some((p) => p.id === preview.id)) throw new Error('歌单已经保存')
    const base = options.clonePlaylistSnapshot()
    const playlist = structuredClone(preview)
    delete playlist.transient
    playlist.name = uniqueName(playlist.name)
    options.playlists.value = [...options.playlists.value, playlist]
    options.queuePlaylistPersistence(base)
    return playlist.id
  }
  function saveExternalPlaylist(playlistId: string) {
    const playlist = options.playlists.value.find((p) => p.id === playlistId && p.imported)
    if (!playlist) throw new Error('歌单已被删除')
    if (!playlist.transient) return playlistId
    if (!playlist.imported!.complete) throw new Error('歌单尚未完整读取，完成后才能保存')
    const base = options.clonePlaylistSnapshot()
    delete playlist.transient
    options.queuePlaylistPersistence(base)
    return playlistId
  }
  function discardExternalPlaylist(playlistId: string) {
    const playlist = options.playlists.value.find((p) => p.id === playlistId && p.transient)
    if (!playlist) return false
    options.playlists.value = options.playlists.value.filter((p) => p !== playlist)
    runtime.notify()
    return true
  }
  function appendExternalPlaylistPage(
    playlistId: string,
    generation: string,
    songs: ImportSong[],
    total: number,
    complete: boolean
  ) {
    return mutate(playlistId, (p) => {
      const data = p.imported!
      if (data.generation !== generation || data.complete) return false
      if (data.entries.length + songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES)
        throw new Error('歌单超过 20,000 条上限')
      const offset = data.entries.length
      data.entries = [
        ...data.entries,
        ...reconcileImportEntries([], songs, id).map((e) => ({
          ...e,
          position: e.position + offset
        }))
      ]
      data.membershipRevision++
      data.expectedTotal = total
      data.complete = complete
      delete data.readError
      return true
    })
  }
  function setExternalPlaylistReadError(playlistId: string, generation: string, error: string) {
    return mutate(playlistId, (p) => {
      if (p.imported!.generation !== generation) return false
      p.imported!.readError = error
      return true
    })
  }
  function applyExternalResolution(
    playlistId: string,
    generation: string,
    entryId: string,
    revision: number,
    resolution: ImportResolution
  ) {
    return applyExternalResolutions(playlistId, generation, [{ entryId, revision, resolution }])
  }
  function applyExternalResolutions(
    playlistId: string,
    generation: string,
    updates: Array<{ entryId: string; revision: number; resolution: ImportResolution }>
  ) {
    return mutate(playlistId, (p) => {
      const data = p.imported!
      if (data.generation !== generation) return false
      const byId = new Map(updates.map((update) => [update.entryId, update]))
      let changed = false
      data.entries = data.entries.map((entry) => {
        const update = byId.get(entry.entryId)
        if (!update || entry.revision !== update.revision) return entry
        const resolution = update.resolution
        changed = true
        return {
          ...entry,
          resolution: {
            ...resolution,
            ...(resolution.track
              ? { track: toPlaylistTrackSnapshot(resolution.track as Track) }
              : {})
          }
        }
      })
      return changed
    })
  }
  function bindExternalEntry(playlistId: string, entryId: string, track: Track | null) {
    return mutate(playlistId, (p) => {
      const data = p.imported!,
        entry = data.entries.find((e) => e.entryId === entryId)
      if (!entry) return false
      const binding = track ? toPlaylistTrackSnapshot(track) : undefined
      data.entries = data.entries.map((e) =>
        e === entry
          ? {
              ...e,
              revision: e.revision + 1,
              manualBinding: binding,
              resolution: { state: 'pending' }
            }
          : e
      )
      return true
    })
  }
  function refreshExternalPlaylist(
    playlistId: string,
    document: PlaylistImportDocument,
    overwrite = false
  ) {
    const playlist = options.playlists.value.find((p) => p.id === playlistId)
    if (!playlist?.imported) throw new Error('歌单已被删除')
    if (!document.complete) throw new Error('尚未完整读取，不能更新歌单')
    if (document.songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES)
      throw new Error('歌单超过 20,000 条上限')
    if (playlist.imported.locallyEdited && !overwrite) return createExternalPlaylist(document)
    mutate(playlistId, (p) => {
      const data = p.imported!
      data.entries = reconcileImportEntries(data.entries, document.songs, id)
      data.source = document.source
      data.generation = id()
      data.refreshGeneration = data.generation
      data.membershipRevision++
      data.complete = true
      data.importedAt = new Date(runtime.now()).toISOString()
      data.expectedTotal = document.songs.length
      delete data.readError
      delete data.locallyEdited
      return true
    })
    return playlistId
  }
  function removeExternalEntries(playlistId: string, entryIds: string[]) {
    return mutate(playlistId, (p) => {
      const data = p.imported!,
        selected = new Set(entryIds)
      p.imported = withExternalMembership(
        data,
        data.entries.filter((e) => !selected.has(e.entryId))
      )
      return true
    })
  }
  return {
    createExternalPlaylist,
    adoptExternalPlaylist,
    saveExternalPlaylist,
    discardExternalPlaylist,
    appendExternalPlaylistPage,
    setExternalPlaylistReadError,
    applyExternalResolution,
    applyExternalResolutions,
    bindExternalEntry,
    refreshExternalPlaylist,
    removeExternalEntries
  }
}

export function importedPlayableTracks(entries: ImportedPlaylistEntry[]): Track[] {
  return entries.flatMap((entry) => {
    const track = entry.resolution.track
    return track && (entry.resolution.state === 'local' || entry.resolution.state === 'streaming')
      ? [{ ...track, queueEntryId: entry.entryId } as Track]
      : []
  })
}
