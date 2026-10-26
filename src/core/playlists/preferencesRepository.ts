import type { Playlist } from '../../shared/playlists.ts'
import type { MusicPreferencesDatabaseApi } from '../../shared/musicPreferences.ts'
import { isVersionedDataEnvelope, type VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import type { LogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'

interface Options {
  legacy: { load(): Promise<unknown> }
  database: Pick<MusicPreferencesDatabaseApi, 'preferencesPlaylistsLoad' | 'preferencesPlaylistsMigrate' | 'preferencesPlaylistsSave'> & Partial<Pick<LibraryDatabaseApi, 'getTracksByIds'>>
  identity?: LogicalTrackModel
  now(): number
}
/** Switch every playlist consumer together. Retained JSON is recovery material, never a second writer. */
export function createPreferencesPlaylistRepository(options: Options) {
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => undefined).then(action); tail = result; return result
  }
  async function load(): Promise<VersionedDataEnvelope<Playlist[]>> {
    const current = await options.database.preferencesPlaylistsLoad()
    if (current) return current
    const first = await options.legacy.load(), second = await options.legacy.load()
    const valid = (value: unknown): value is Playlist[] => Array.isArray(value)
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('迁移期间原歌单发生变化，请重新加载后重试')
    if (first !== null && !isVersionedDataEnvelope(first, valid)) throw new Error('未读取到完整、有版本的原歌单快照，收藏迁移尚未发布')
    const envelope: VersionedDataEnvelope<Playlist[]> = first === null
      ? { version: 2, revision: 0, savedAt: new Date(options.now()).toISOString(), data: [] }
      : first
    const p = envelope.data.find(p => p.isDefault), identity = options.identity ?? createLogicalTrackModel(() => undefined)
    const snapshots = new Map<string, TrackData>(Object.entries(p?.trackSnapshots ?? {})), missing = [...new Set(p?.trackIds ?? [])].filter(id => !snapshots.has(id))
    if (options.database.getTracksByIds) for (let offset = 0; offset < missing.length; offset += 200) {
      const page = await options.database.getTracksByIds(missing.slice(offset, offset + 200))
      for (const raw of page.tracks) snapshots.set(raw.id, libraryTrack(raw))
    }
    const ids = new Set<string>(), buckets = new Map<string, TrackData[]>(); let logicalMemberCount = 0
    for (const id of p?.trackIds ?? []) {
      if (ids.has(id)) continue
      ids.add(id)
      const track = snapshots.get(id)
      if (!track) { logicalMemberCount++; continue }
      const key = identity.getRecordingTrackKey(track), known = buckets.get(key) ?? []
      if (known.some(other => identity.canShareTrackIdentity(other, track))) continue
      known.push(track); buckets.set(key, known); logicalMemberCount++
    }
    return options.database.preferencesPlaylistsMigrate(envelope, options.now(), { logicalMemberCount })
  }
  return {
    load: () => serial(load),
    save: (data: Playlist[], expectedRevision: number) => serial(async () => {
      await load()
      return options.database.preferencesPlaylistsSave(data, expectedRevision, options.now())
    })
  }
}
