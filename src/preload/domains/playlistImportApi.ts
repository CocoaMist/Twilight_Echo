import { IPC } from '../../shared/ipcChannels.ts'
import { ipcRenderer } from 'electron'

export const playlistImportApi = {
  chooseFile: (): Promise<
    import('../../shared/externalPlaylist.ts').PlaylistImportDocument | null
  > => ipcRenderer.invoke(IPC.playlistImport.chooseFile),
  resolveNeteaseShortLink: (request: { input: string; requestId: string }): Promise<
    import('../../shared/externalPlaylist.ts').PlaylistLink
  > => ipcRenderer.invoke(IPC.playlistImport.resolveNeteaseShortLink, request),
  readPage: (request: {
    link: string
    offset: number
    cursor?: string
    requestId?: string
    credentials?: {
      accessToken?: string
      developerToken?: string
      userToken?: string
      country?: string
    }
  }): Promise<import('../../shared/externalPlaylist.ts').PlaylistImportPage> =>
    ipcRenderer.invoke(IPC.playlistImport.readPage, request),
  cancelRead: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.playlistImport.cancelRead, requestId)
}
