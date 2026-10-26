import { shallowRef } from 'vue'
import { createLibraryPlaylistView as createPortableView } from '../../../../core/playlists/sqlView.ts'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'

export function createLibraryPlaylistView(
  api: Pick<LibraryDatabaseApi, 'syncPlaylistView'>,
  identity: () => string = () => crypto.randomUUID()
) {
  return createPortableView(api, identity, shallowRef)
}
