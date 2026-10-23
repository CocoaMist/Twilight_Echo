import type { CorePlaylistCommands, CorePlaylistReadRequest } from '../../shared/corePlaylists.ts'
import type { CorePlaylistService } from './service.ts'

type ProjectionCommands = Omit<CorePlaylistCommands, 'playlists.submit'>
type Write = {
  [K in keyof ProjectionCommands]: { name: K; payload: ProjectionCommands[K] }
}[keyof ProjectionCommands]
export async function executePlaylistProjection(
  service: CorePlaylistService,
  request: CorePlaylistReadRequest | Write,
  signal?: AbortSignal
) {
  switch (request.name) {
    case 'playlists.collection':
      return service.collection(request.payload, signal)
    case 'playlists.catalog':
      return service.catalog(
        request.payload.offset,
        request.payload.limit,
        request.payload.revision
      )
    case 'playlists.state':
      return service.state()
    case 'playlists.members':
      return service.members(request.payload)
    case 'playlists.membership':
      return service.membership(request.payload.id, request.payload.revision, request.payload.ids)
    case 'playlists.export':
      return service.exportDocument(
        request.payload.id,
        request.payload.revision,
        request.payload.format,
        signal
      )
    case 'playlists.importDocument':
      return service.importDocument(
        request.payload.id,
        request.payload.revision,
        request.payload.fileName,
        request.payload.contents,
        signal
      )
    case 'playlists.flush':
      return service.flush()
  }
}
