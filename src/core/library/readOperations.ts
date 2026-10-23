import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { CoreLibraryReadRequest } from '../../shared/coreLibrary.ts'
import { projectCoreTrack } from '../projections.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import type { TrackData } from '../../shared/track.ts'

export type CoreLibraryReadDatabase = Pick<
  LibraryDatabaseApi,
  'queryCollections' | 'getTracksByIds' | 'lookupTracksByPaths' | 'lookupPlaylistTracks'
>

export async function executeLibraryRead(
  database: CoreLibraryReadDatabase,
  request: Exclude<CoreLibraryReadRequest, { name: 'library.artwork' | 'library.recent.resolve' }>
) {
  switch (request.name) {
    case 'library.collections':
      return database.queryCollections(request.payload.kind, request.payload.query)
    case 'library.byIds': {
      const page = await database.getTracksByIds(request.payload.ids, request.payload.revision)
      return { ...page, tracks: page.tracks.map((track) => projectCoreTrack(track)) }
    }
    case 'library.paths.lookup':
      return database.lookupTracksByPaths(request.payload.paths, request.payload.revision)
  }
}

export async function executeLibraryArtwork(
  database: Pick<LibraryDatabaseApi, 'getTracksByIds'>,
  request: import('../../shared/coreLibrary.ts').CoreLibraryQueries['library.artwork']['input'],
  present: (track: TrackData, signal: AbortSignal) => Promise<{ cover: string | null }>,
  signal: AbortSignal
) {
  const page = await database.getTracksByIds(request.ids, request.revision)
  const items: Array<{ id: string; cover: string | null }> = []
  for (const record of page.tracks) {
    signal.throwIfAborted()
    const artwork = await present(libraryTrack(record), signal)
    items.push({ id: record.id, cover: artwork.cover })
  }
  return { revision: page.revision, items }
}
