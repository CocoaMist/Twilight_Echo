import type { NcmCloudTransferProgress } from './ncmCloud.ts'

export interface CoreCloudTransferState {
  revision: number
  active: number
  total: number
}
export interface CoreCloudTransferQuery {
  revision: number
  offset?: number
  limit?: number
}
export interface CoreCloudTransferPage extends CoreCloudTransferState {
  offset: number
  items: NcmCloudTransferProgress[]
}

export type CoreCloudTransferProviderMethod =
  | 'prepareCloudUpload'
  | 'completeCloudUpload'
  | 'getCloudDownloadUrl'

export const NCM_CLOUD_UPLOAD_EXTENSIONS = [
  'mp3',
  'flac',
  'wav',
  'wave',
  'aac',
  'ogg',
  'wma',
  'm4a',
  'mp4',
  'aiff',
  'aif',
  'opus',
  'webm',
  'alac',
  'ape',
  'wv',
  'dsf',
  'dff',
  'mqa'
] as const
