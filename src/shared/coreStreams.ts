import type { RadioStation } from './radioStations.ts'
import type { PodcastSubscription, PodcastEpisode } from './podcastSubscriptions.ts'

export interface RadioBrowserStation {
  stationuuid: string
  name: string
  url: string
  urlResolved: string
  homepage?: string
  favicon?: string
  tags: string[]
  countryCode?: string
  bitrate?: number
  codec?: string
  votes?: number
}

export type CoreRadioStation = Omit<RadioStation, 'streamUrl'>
export type CorePodcast = Omit<
  PodcastSubscription,
  'episodes' | 'feedUrl' | 'feedEtag' | 'feedLastModified'
> & { episodeCount: number }
export type CorePodcastEpisode = Omit<PodcastEpisode, 'mediaUrl'>
export interface CoreStreamsState {
  radioRevision: number
  podcastRevision: number
  preferencesRevision: number
  defaultPlaybackRate: number
  stations: number
  subscriptions: number
  refreshing: string[]
  error: string | null
}
export interface CoreStreamPageQuery {
  revision: number
  offset?: number
  limit?: number
}
export interface CoreStreamPage<T> {
  revision: number
  offset: number
  total: number
  items: T[]
}
export type CoreRadioEdit = {
  revision: number
  edit:
    | {
        kind: 'add'
        name: string
        streamUrl: string
        homepage?: string
        favicon?: string
        tags?: string[]
        allowInsecureHttp?: boolean
      }
    | { kind: 'remove'; id: string }
    | { kind: 'import'; text: string; fileNameHint?: string; allowInsecureHttp?: boolean }
}
export type CorePodcastEdit = {
  revision: number
  edit: { kind: 'unsubscribe'; id: string } | { kind: 'restore'; token: string }
}
export interface CoreStreamMutationResult {
  state: CoreStreamsState
  id?: string
  added?: number
  undoToken?: string
}
/** Identity only: sources and resume position come from the Core repository. */
export type CoreStreamPlayback = { revision: number; play?: boolean } & (
  | { kind: 'radio'; id: string }
  | { kind: 'podcast'; id: string; guid: string; resume?: boolean }
)
