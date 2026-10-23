import { useCoreConnection } from './coreConnection.ts'
import { createCoreMusicStore } from './library/coreMusicStore.ts'
export type { CorePlaylistDescriptor as Playlist } from '../../../shared/corePlaylists.ts'
export type {
  PlaylistImportApplyResult,
  PlaylistBatchMoveResult,
  PlaylistPersistenceNotice
} from '../../../shared/playlists.ts'
let singleton: ReturnType<typeof createCoreMusicStore> | null = null
export function useMusicStore() {
  return (singleton ??= createCoreMusicStore(useCoreConnection()))
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    singleton?.dispose()
    singleton = null
  })
