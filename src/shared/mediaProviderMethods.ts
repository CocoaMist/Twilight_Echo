export type TwilightMediaProviderMethod =
  | 'getPlaybackUrl'
  | 'getLyrics'
  | 'searchSongs'
  | 'searchAlbums'
  | 'searchPlaylists'
  | 'searchArtists'
  | 'fetchPlaylistTracks'
  | 'fetchPlaylistTracksPage'
  | 'readPlaylistImportPage'
  | 'createDownload'
  | 'getDownloadStatus'
  | 'getDownloadFile'
  | 'cancelDownload'
  | 'checkLogin'
  | 'getProfile'
  | 'logout'
  | 'openOfficialLogin'
  | 'sendCaptcha'
  | 'loginByPhonePassword'
  | 'loginByPhoneCaptcha'
  | 'loginByEmailPassword'
  | 'loginWithServer'
  | 'getQrLogin'
  | 'getQrKey'
  | 'getQrImage'
  | 'checkQrLogin'
  | 'fetchUserLibrary'
  | 'fetchLikedTracks'
  | 'fetchLikedTracksPage'
  | 'fetchCloudSongsPage'
  | 'prepareCloudUpload'
  | 'completeCloudUpload'
  | 'getCloudDownloadUrl'
  | 'fetchRecommendSongs'
  | 'fetchRecommendPlaylists'
  | 'fetchPlaylistCategories'
  | 'fetchDiscoveryPlaylists'
  | 'fetchHighQualityPlaylists'
  | 'fetchToplists'
  | 'fetchPersonalFm'
  | 'fetchPrivateContent'
  | 'fetchArtistTopSongs'
  | 'fetchArtistAlbums'
  | 'fetchSavedAlbums'
  | 'fetchSavedArtists'
  | 'fetchArtistIntro'
  | 'fetchArtistFollowState'
  | 'fetchAlbumTracks'
  | 'fetchArtistPlaylists'
  | 'fetchUserPlaylistsByUid'
  | 'fetchUserFollows'
  | 'fetchUserFolloweds'
  | 'fetchPlayRecords'
  | 'fetchRecentSongs'
  | 'fetchIntelligenceList'
  | 'followArtist'
  | 'followUser'
  | 'likeTrack'
  | 'isTrackLiked'
  | 'createPlaylist'
  | 'deletePlaylist'
  | 'addTracksToPlaylist'
  | 'removeTracksFromPlaylist'

export const TWILIGHT_MEDIA_PROVIDER_METHODS = [
  'getPlaybackUrl',
  'getLyrics',
  'searchSongs',
  'searchAlbums',
  'searchPlaylists',
  'searchArtists',
  'fetchPlaylistTracks',
  'fetchPlaylistTracksPage',
  'readPlaylistImportPage',
  'createDownload',
  'getDownloadStatus',
  'getDownloadFile',
  'cancelDownload',
  'checkLogin',
  'getProfile',
  'logout',
  'openOfficialLogin',
  'sendCaptcha',
  'loginByPhonePassword',
  'loginByPhoneCaptcha',
  'loginByEmailPassword',
  'loginWithServer',
  'getQrLogin',
  'getQrKey',
  'getQrImage',
  'checkQrLogin',
  'fetchUserLibrary',
  'fetchLikedTracks',
  'fetchLikedTracksPage',
  'fetchCloudSongsPage',
  'prepareCloudUpload',
  'completeCloudUpload',
  'getCloudDownloadUrl',
  'fetchRecommendSongs',
  'fetchRecommendPlaylists',
  'fetchPlaylistCategories',
  'fetchDiscoveryPlaylists',
  'fetchHighQualityPlaylists',
  'fetchToplists',
  'fetchPersonalFm',
  'fetchPrivateContent',
  'fetchArtistTopSongs',
  'fetchArtistAlbums',
  'fetchSavedAlbums',
  'fetchSavedArtists',
  'fetchArtistIntro',
  'fetchArtistFollowState',
  'fetchAlbumTracks',
  'fetchArtistPlaylists',
  'fetchUserPlaylistsByUid',
  'fetchUserFollows',
  'fetchUserFolloweds',
  'fetchPlayRecords',
  'fetchRecentSongs',
  'fetchIntelligenceList',
  'followArtist',
  'followUser',
  'likeTrack',
  'isTrackLiked',
  'createPlaylist',
  'deletePlaylist',
  'addTracksToPlaylist',
  'removeTracksFromPlaylist'
] as const satisfies readonly TwilightMediaProviderMethod[]

export function isTwilightMediaProviderMethod(
  method: string
): method is TwilightMediaProviderMethod {
  return (TWILIGHT_MEDIA_PROVIDER_METHODS as readonly string[]).includes(method)
}
