import type { TrackData } from '../../shared/track.ts'
import type { RadioStation } from '../../shared/radioStations.ts'
import {
  podcastEpisodeTrackId,
  type PodcastEpisode,
  type PodcastSubscription
} from '../../shared/podcastSubscriptions.ts'

export function radioStationToTrack(station: RadioStation): TrackData {
  return {
    id: station.id,
    title: station.name,
    artist: '网络电台',
    album: 'Radio',
    filePath: station.streamUrl,
    fileName: station.name,
    duration: 0,
    size: 0,
    cover: station.favicon ?? null,
    lyrics: null,
    source: 'radio',
    streamUrl: station.streamUrl
  }
}
export function podcastEpisodeToTrack(
  subscription: PodcastSubscription,
  episode: PodcastEpisode
): TrackData {
  return {
    id: podcastEpisodeTrackId(subscription.id, episode.guid),
    title: episode.title,
    artist: subscription.author || subscription.title || '播客',
    album: subscription.title,
    filePath: episode.mediaUrl,
    fileName: episode.title,
    duration: episode.durationSeconds || 0,
    size: 0,
    cover: episode.coverUrl ?? subscription.coverUrl ?? null,
    lyrics: null,
    source: 'podcast',
    streamUrl: episode.mediaUrl
  }
}
