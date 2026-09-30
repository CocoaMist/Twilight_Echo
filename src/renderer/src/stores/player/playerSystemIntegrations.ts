import { effectScope, watch, type Ref } from 'vue'
import type { Track } from '../../types/music.ts'

type IntegrationTrack = Pick<Track, 'id' | 'queueEntryId' | 'title' | 'artist' | 'album' | 'cover'>
type ReadRef<T> = Readonly<Ref<T>>
type BrowserMediaSession = Pick<
  MediaSession,
  'metadata' | 'playbackState' | 'setActionHandler' | 'setPositionState'
>
interface DiscordActivity {
  title: string
  artist: string
  album: string
  playing: boolean
  startTime: number
}
type DiscordPort = NonNullable<PlayerSystemIntegrationOptions['discord']>
interface DiscordPublication {
  owner: object | null
  desired: DiscordActivity | null
  pending: boolean
  publishing: boolean
}
const discordPublications = new WeakMap<DiscordPort, DiscordPublication>()

function claimDiscordPublication(port: DiscordPort, owner: object) {
  let publication = discordPublications.get(port)
  if (!publication) {
    publication = { owner, desired: null, pending: false, publishing: false }
    discordPublications.set(port, publication)
  }
  const state = publication
  state.owner = owner
  async function drain(): Promise<void> {
    if (state.publishing) return
    state.publishing = true
    try {
      while (state.pending) {
        state.pending = false
        const activity = state.desired
        state.desired = null
        try {
          if (activity) await port.updateActivity(activity)
          else await port.clearActivity()
        } catch {
          /* A transient failure must not block the latest snapshot. */
        }
      }
    } finally {
      state.publishing = false
      if (!state.owner && discordPublications.get(port) === state) discordPublications.delete(port)
    }
  }
  return {
    publish(activity: DiscordActivity | null): void {
      if (state.owner !== owner) return
      state.desired = activity
      state.pending = true
      void drain()
    },
    release(): void {
      if (state.owner !== owner) return
      state.desired = null
      state.pending = true
      state.owner = null
      void drain()
    }
  }
}

export interface PlayerSystemIntegrationOptions {
  currentTrack: ReadRef<IntegrationTrack | null>
  isPlaying: ReadRef<boolean>
  currentTime: ReadRef<number>
  duration: ReadRef<number>
  playbackRate: ReadRef<number>
  mediaEnabled: ReadRef<boolean>
  discordEnabled: ReadRef<boolean>
  commands: {
    togglePlay(): void | Promise<void>
    previous(): void | Promise<void>
    next(): void | Promise<void>
    seek(time: number): void
  }
  getNativeStatus(): Promise<{ active: boolean }>
  mediaSession?: BrowserMediaSession
  createMetadata?(init: MediaMetadataInit): MediaMetadata
  discord?: {
    updateActivity(activity: DiscordActivity): Promise<void>
    clearActivity(): Promise<void>
  }
  now?: () => number
}

/** Owns only external publications and handlers, never playback state or queues. */
export function createPlayerSystemIntegrations(options: PlayerSystemIntegrationOptions) {
  const scope = effectScope(true)
  const session = options.mediaSession
  const boundActions = new Set<MediaSessionAction>()
  const now = options.now ?? Date.now
  let started = false
  let disposed = false
  let rendererOwnsSession = false
  let metadataKey = ''
  let discordTrack = ''
  let discordStart: number | null = null
  let discordKey = ''
  let discordPublication: ReturnType<typeof claimDiscordPublication> | null = null

  function clearSession(): void {
    if (!session || !rendererOwnsSession) return
    for (const action of boundActions) {
      try {
        session.setActionHandler(action, null)
      } catch {
        /* Unsupported action. */
      }
    }
    boundActions.clear()
    metadataKey = ''
    session.metadata = null
    session.playbackState = 'none'
    try {
      session.setPositionState()
    } catch {
      /* Optional Chromium API. */
    }
  }

  function publishPosition(): void {
    if (!session || !rendererOwnsSession || disposed || !options.mediaEnabled.value) return
    const total = options.duration.value
    const position = options.currentTime.value
    const rate = options.playbackRate.value
    try {
      if (
        !options.currentTrack.value ||
        !Number.isFinite(total) ||
        total <= 0 ||
        !Number.isFinite(position)
      ) {
        session.setPositionState()
      } else {
        session.setPositionState({
          duration: total,
          position: Math.min(total, Math.max(0, position)),
          playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1
        })
      }
    } catch {
      /* Invalid or unsupported platform state must not interrupt playback. */
    }
  }

  function bindActions(): void {
    if (!session || boundActions.size > 0) return
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        if (!options.isPlaying.value) void options.commands.togglePlay()
      },
      pause: () => {
        if (options.isPlaying.value) void options.commands.togglePlay()
      },
      previoustrack: () => {
        void options.commands.previous()
      },
      nexttrack: () => {
        void options.commands.next()
      },
      seekto: (details) => {
        if (details.seekTime != null) options.commands.seek(details.seekTime)
      },
      seekbackward: () => options.commands.seek(Math.max(0, options.currentTime.value - 10)),
      seekforward: () =>
        options.commands.seek(Math.min(options.duration.value, options.currentTime.value + 10))
    }
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action as MediaSessionAction, handler!)
        boundActions.add(action as MediaSessionAction)
      } catch {
        /* Register supported actions even when one action is unavailable. */
      }
    }
  }

  function publishSession(): void {
    if (!session || !rendererOwnsSession || disposed) return
    if (!options.mediaEnabled.value) {
      clearSession()
      return
    }
    bindActions()
    const track = options.currentTrack.value
    if (!track) {
      metadataKey = ''
      session.metadata = null
    } else {
      const key = JSON.stringify([track.id, track.title, track.artist, track.album, track.cover])
      if (key !== metadataKey) {
        const metadata =
          options.createMetadata?.({
            title: track.title || '',
            artist: track.artist || '',
            album: track.album || '',
            artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : []
          }) ?? null
        session.metadata = metadata
        metadataKey = key
      }
    }
    session.playbackState = track ? (options.isPlaying.value ? 'playing' : 'paused') : 'none'
    publishPosition()
  }

  function publishDiscord(): void {
    if (!options.discord || disposed) return
    const track = options.currentTrack.value
    let activity: DiscordActivity | null = null
    if (track && options.isPlaying.value && options.discordEnabled.value) {
      const identity = JSON.stringify([track.id, track.queueEntryId])
      if (discordTrack !== identity || discordStart === null) discordStart = now()
      discordTrack = identity
      activity = {
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        playing: true,
        startTime: discordStart
      }
    } else {
      discordTrack = ''
      discordStart = null
    }
    const key = JSON.stringify(activity)
    if (key === discordKey) return
    discordKey = key
    discordPublication?.publish(activity)
  }

  return {
    start(): void {
      if (started || disposed) return
      started = true
      if (options.discord) discordPublication = claimDiscordPublication(options.discord, {})
      scope.run(() => {
        watch(
          [
            options.mediaEnabled,
            options.discordEnabled,
            options.isPlaying,
            () => options.currentTrack.value?.id,
            () => options.currentTrack.value?.queueEntryId,
            () => options.currentTrack.value?.title,
            () => options.currentTrack.value?.artist,
            () => options.currentTrack.value?.album,
            () => options.currentTrack.value?.cover
          ],
          () => {
            publishSession()
            publishDiscord()
          },
          { immediate: true }
        )
        watch([options.currentTime, options.duration, options.playbackRate], publishPosition)
      })
      void (async () => {
        let nativeActive = false
        try {
          nativeActive = (await options.getNativeStatus()).active === true
        } catch {
          /* Browser fallback. */
        }
        if (disposed) return
        rendererOwnsSession = !nativeActive
        publishSession()
      })()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      scope.stop()
      if (started) {
        clearSession()
        discordPublication?.release()
        discordPublication = null
      }
    }
  }
}
