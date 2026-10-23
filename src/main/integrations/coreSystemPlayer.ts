import {
  installCoreSystemPlayerBridge,
  type CoreSystemPlayerTransport
} from '../coreProcess/systemPlayerBridge.ts'
import { publishCoreMiniPlayerState } from './miniPlayer.ts'
import { publishCoreDesktopLyricsClock, publishCoreDesktopLyricsSession } from './desktopLyrics.ts'
import { publishDynamicIslandLyrics } from './dynamicIsland.ts'
import { clearDiscordActivity, updateDiscordActivity } from './discord.ts'

/** Install once at the production cutover; feed ordered Core snapshots and invalidation. */
export function installCoreSystemPlayer(transport: CoreSystemPlayerTransport) {
  let discordKey = ''
  return installCoreSystemPlayerBridge(transport, {
    state(state) {
      publishCoreMiniPlayerState(state)
      const activity =
        state.track && state.isPlaying
          ? {
              title: state.track.title,
              artist: state.track.artist,
              album: state.track.album,
              playing: true,
              startTime: Math.floor((transport.now() - state.currentTime * 1000) / 1000)
            }
          : null
      const nextDiscordKey = JSON.stringify(activity)
      if (nextDiscordKey !== discordKey) {
        discordKey = nextDiscordKey
        if (activity) updateDiscordActivity(activity)
        else clearDiscordActivity()
      }
    },
    lyrics(session, island) {
      publishCoreDesktopLyricsSession(session)
      publishDynamicIslandLyrics(island)
    },
    clock: publishCoreDesktopLyricsClock
  })
}
