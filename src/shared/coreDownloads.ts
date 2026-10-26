import type {
  ProviderDownloadCreateInput,
  ProviderDownloadTaskSnapshot
} from './providerDownloads.ts'

export type CoreDownloadCreate = ProviderDownloadCreateInput
/** Jobs, filesystem destinations and provider extensions never enter public pages. */
export type CoreDownloadTask = Omit<
  ProviderDownloadTaskSnapshot,
  'providerJobId' | 'targetPath' | 'track'
> & {
  track: { id: string | number; title: string; artist: string; album?: string; cover?: string }
}
export interface CoreDownloadsState {
  revision: number
  active: number
  total: number
}
export interface CoreDownloadsQuery {
  revision: number
  offset?: number
  limit?: number
}
export interface CoreDownloadsPage extends CoreDownloadsState {
  offset: number
  items: CoreDownloadTask[]
}
