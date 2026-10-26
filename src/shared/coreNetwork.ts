import type {
  NetworkEntry,
  NetworkSourceProfileInput,
  NetworkSourceProfileSummary,
  NetworkSourceErrorCode
} from './networkSources.ts'

/** Private OS capabilities: no executable or environment supplied by a client. */
export interface CoreNetworkSftpRequest {
  operation: { kind: 'list'; path: string } | { kind: 'download'; path: string; local: string }
  connection: { host: string; port: number; username: string; keyPath: string }
}
export interface CoreNetworkMountRequest {
  command: 'net' | 'gio' | 'mount' | 'umount'
  args: string[]
}

export interface CoreNetworkState {
  revision: number
  profiles: number
  jobs: Array<{
    id: string
    profileId: string
    kind: 'scan' | 'enrich'
    state: 'running' | 'completed' | 'cancelled' | 'failed'
    result?: { added?: number; total?: number; enriched?: number; failed?: number }
    error?: string
  }>
}
export interface CoreNetworkPageQuery {
  revision: number
  offset?: number
  limit?: number
}
export interface CoreNetworkPage<T> {
  revision: number
  offset: number
  total: number
  items: T[]
}
/** Source URLs, absolute cached paths and adapter-private mime fields are private. */
export type CoreNetworkEntry = Pick<
  NetworkEntry,
  'id' | 'profileId' | 'name' | 'kind' | 'path' | 'sizeBytes' | 'mtimeMs' | 'metadata'
>
export type CoreNetworkProfileEdit = { revision: number } & (
  | { kind: 'create'; input: NetworkSourceProfileInput }
  | { kind: 'update'; id: string; patch: Partial<NetworkSourceProfileInput> }
  | { kind: 'delete'; id: string }
)
export type CoreNetworkTestResult = { ok: boolean; errorCode?: NetworkSourceErrorCode }
export type CoreNetworkProfile = NetworkSourceProfileSummary
export type CoreNetworkJobCommand = { revision: number } & (
  | { kind: 'scan'; profileId: string; path: string }
  | { kind: 'enrich'; profileId: string }
  | { kind: 'cancel'; id: string }
)
export interface CoreNetworkPlayback {
  revision: number
  profileId: string
  entryId: string
  play?: boolean
}
