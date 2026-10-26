import type {
  ImportSong,
  PlaylistImportDocument,
  ImportResolutionState
} from './externalPlaylist.ts'
import type { ImportColumnMap } from './playlistImportTable.ts'
import type { CoreTrackView } from './coreViews.ts'

export interface PlaylistReadCredentials {
  accessToken?: string
  developerToken?: string
  userToken?: string
  country?: string
}
export interface CoreImportPreview {
  id: string
  revision: number
  name: string
  source: PlaylistImportDocument['source']
  reading: boolean
  saving: boolean
  complete: boolean
  count: number
  total: number | null
  error: string | null
  warnings: string[]
  columnCount: number
  playlistCount: number
}
export interface CoreImportPreviewChoices {
  revision: number
  offset: number
  total: number
  items: Array<{ index: number; name: string; count?: number }>
}
export interface CoreImportPreviewPage {
  revision: number
  offset: number
  total: number
  items: Array<{
    id: string
    original: Omit<ImportSong, 'locations'>
    state: ImportResolutionState
    message?: string
    track: CoreTrackView | null
  }>
}
export interface CoreImportPreviewConfigure {
  id: string
  revision: number
  name?: string
  playlistIndex?: number
  columns?: ImportColumnMap
}
export interface CoreImportPreviewSave {
  id: string
  revision: number
  playlistsRevision: number
  target?: { id: string; generation: string; overwrite?: boolean }
}
