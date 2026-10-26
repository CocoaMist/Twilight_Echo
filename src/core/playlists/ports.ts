import type { Playlist } from '../../shared/playlists.ts'
import type { VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import type { LogicalTrackModel } from '../../shared/logicalTrackModel.ts'

export interface Cell<T> {
  value: T
}
export interface PlaylistRuntime {
  now(): number
  newId(): string
  clone<T>(value: T): T
  notify(): void
  identity: LogicalTrackModel
  versions: { ensure(): void; revision(): number }
  repository: {
    load(): Promise<unknown>
    save(
      data: Playlist[],
      expectedRevision: number
    ): Promise<VersionedDataEnvelope<Playlist[]> | unknown>
  }
}
