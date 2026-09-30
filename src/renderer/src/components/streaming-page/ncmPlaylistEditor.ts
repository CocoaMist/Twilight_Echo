import { computed, readonly, ref, shallowRef } from 'vue'
import type { Track } from '../../types/music.ts'

type PlaylistId = string | number
interface PlaylistEditorPorts {
  canManage(): boolean
  captureContext(): () => boolean
  create(name: string): Promise<{ id: PlaylistId }>
  add(id: PlaylistId, trackIds: number[]): Promise<void>
  describeError(error: unknown, fallback: string): string
}

export function uniqueNcmTracks(tracks: readonly Track[]): Track[] {
  const seen = new Set<number>()
  return tracks.filter((track) => {
    const id = track.ncmSongId
    if (id == null || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function appendNcmPlaylistTracks(existing: Track[], added: readonly Track[]): Track[] {
  const ids = new Set(existing.map((track) => track.ncmSongId))
  let result = existing
  for (const track of uniqueNcmTracks(added)) {
    if (ids.has(track.ncmSongId)) continue
    ids.add(track.ncmSongId)
    if (result === existing) result = [...existing]
    result.push(track)
  }
  return result
}

/** Owns create/add transactions and dialog data, without navigation or store access. */
export function createNcmPlaylistEditor(ports: PlaylistEditorPorts) {
  const showCreate = ref(false)
  const name = ref('')
  const createBusy = ref(false)
  const createError = ref('')
  const created = ref(false)
  const showAdd = ref(false)
  const addBusy = ref(false)
  const addError = ref('')
  const addTracks = shallowRef<Track[]>([])
  let seedIds: number[] = []
  let createdId: PlaylistId | null = null
  let createdContext: (() => boolean) | null = null
  let revision = 0
  let disposed = false

  function reset(): void {
    revision++
    showCreate.value = showAdd.value = createBusy.value = addBusy.value = created.value = false
    name.value = createError.value = addError.value = ''
    addTracks.value = []
    seedIds = []
    createdId = null
    createdContext = null
  }

  function canOpen(): boolean {
    return !disposed && !createBusy.value && !addBusy.value && ports.canManage()
  }

  function openCreate(tracks: readonly Track[] = []): boolean {
    if (!canOpen()) return false
    reset()
    seedIds = uniqueNcmTracks(tracks).map((track) => track.ncmSongId!)
    showCreate.value = true
    return true
  }

  function openAdd(tracks: readonly Track[], showDialog = true): boolean {
    if (!canOpen()) return false
    const selected = uniqueNcmTracks(tracks)
    if (selected.length === 0) return false
    reset()
    addTracks.value = selected
    showAdd.value = showDialog
    return true
  }

  function capture(): () => boolean {
    const token = revision
    const isCurrentContext = ports.captureContext()
    return () => !disposed && token === revision && isCurrentContext()
  }

  async function confirmCreate(): Promise<boolean> {
    if (!canOpen() || !showCreate.value || !name.value.trim()) return false
    // A partial success belongs to its original account/provider generation.
    if (createdContext && !createdContext()) {
      reset()
      return false
    }
    const isCurrent = capture()
    const token = revision
    const requestedName = name.value.trim()
    const ids = [...seedIds]
    createBusy.value = true
    createError.value = ''
    try {
      if (createdId === null) {
        const playlist = await ports.create(requestedName)
        if (!isCurrent()) return false
        createdId = playlist.id
        createdContext = isCurrent
        created.value = true
        name.value = requestedName
      }
      // Retry adds to the acknowledged playlist; it never creates it again.
      if (ids.length) await ports.add(createdId, ids)
      if (!isCurrent()) return false
      reset()
      return true
    } catch (error) {
      if (isCurrent())
        createError.value = created.value
          ? ports.describeError(error, '添加歌曲失败') + '；歌单已创建，再次提交仅重试添加歌曲。'
          : ports.describeError(error, '创建歌单失败')
      return false
    } finally {
      if (!disposed && revision === token) createBusy.value = false
    }
  }

  async function confirmAdd(id: PlaylistId): Promise<boolean> {
    if (!canOpen() || addTracks.value.length === 0) return false
    const isCurrent = capture()
    const token = revision
    const ids = addTracks.value.map((track) => track.ncmSongId!)
    addBusy.value = true
    addError.value = ''
    try {
      await ports.add(id, ids)
      if (!isCurrent()) return false
      reset()
      return true
    } catch (error) {
      if (isCurrent()) addError.value = ports.describeError(error, '添加到歌单失败')
      return false
    } finally {
      if (!disposed && revision === token) addBusy.value = false
    }
  }

  return {
    name,
    showCreate: readonly(showCreate),
    createBusy: readonly(createBusy),
    createError: readonly(createError),
    created: readonly(created),
    showAdd: readonly(showAdd),
    addBusy: readonly(addBusy),
    addError: readonly(addError),
    addTracks: computed<readonly Track[]>(() => addTracks.value),
    openCreate,
    openAdd,
    confirmCreate,
    confirmAdd,
    reset,
    closeCreate(): void {
      if (!createBusy.value && showCreate.value) reset()
    },
    closeAdd(): void {
      if (!addBusy.value && showAdd.value) reset()
    },
    convertAddToCreate(): void {
      if (showAdd.value) openCreate(addTracks.value)
    },
    dispose(): void {
      if (!disposed) {
        reset()
        disposed = true
      }
    }
  }
}
