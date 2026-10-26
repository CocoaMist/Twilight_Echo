import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreSystemPlayerBridge, type CoreSystemPlayerTransport } from './systemPlayerBridge.ts'
import type { CoreSnapshot } from '../../shared/coreProtocol.ts'
import type {
  CorePlayerPresentation,
  CoreSystemLyrics,
  CoreSystemPlaybackAction
} from '../../shared/coreSystemPlayer.ts'
import type { MiniPlayerStateSnapshot } from '../../shared/miniPlayer.ts'
import {
  acceptsDesktopLyricsClock,
  type DesktopLyricsClockSnapshot,
  type DesktopLyricsSession
} from '../../shared/desktopLyrics.ts'
import type { DynamicIslandLyricsPayload } from '../../shared/dynamicIsland.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function snapshot(patch: Partial<CoreSnapshot> = {}): CoreSnapshot {
  return {
    epoch: 'one',
    sequence: 1,
    phase: 'ready',
    track: { id: 'local:1', title: 'Song', artist: 'Artist', album: 'Album', duration: 180 },
    playback: {
      state: 'playing',
      position: 23,
      duration: 180,
      playbackRate: 1,
      volume: 0.4,
      playMode: 'sequential'
    },
    queue: { id: 'queue', revision: 7, index: 0, total: 2, occurrenceId: 'first' },
    mute: { muted: false, userVolume: 0.7, lastAudibleVolume: 0.7 },
    presentationRevision: 1,
    playlistsRevision: 2,
    lyricsRevision: 3,
    lyricsContentRevision: 4,
    loading: false,
    ...patch
  } as CoreSnapshot
}
function presentation(occurrenceId = 'first', cover = 'cover://song'): CorePlayerPresentation {
  return {
    current: { trackId: 'local:1', occurrenceId },
    cover,
    coverSource: null,
    favorite: { available: true, liked: true, loading: false }
  }
}
function lyrics(occurrenceId = 'first'): CoreSystemLyrics {
  const current = { trackId: 'local:1', occurrenceId }
  return {
    state: {
      revision: 3,
      contentRevision: 4,
      current,
      preferences: {
        globalOffsetMs: 0,
        showOriginal: true,
        showTranslation: true,
        showRomanization: false
      },
      loadState: { trackId: 'local:1', status: 'ready' },
      error: null
    },
    content: {
      revision: 3,
      contentRevision: 4,
      current,
      automatic: null,
      effective: {
        original: '[00:01.00]Hello\n[00:02.00]World',
        translation: null,
        romanization: null,
        originalSource: 'local',
        translationSource: null,
        romanizationSource: null
      },
      override: null,
      offsetSeconds: 0.25
    }
  }
}
function fixture(extra: Partial<CoreSystemPlayerTransport> = {}) {
  const states: MiniPlayerStateSnapshot[] = []
  const clocks: DesktopLyricsClockSnapshot[] = []
  const sessions: DesktopLyricsSession[] = []
  const islands: DynamicIslandLyricsPayload[] = []
  const commands: CoreSystemPlaybackAction[] = []
  const errors: unknown[] = []
  let presentations = 0,
    lyricReads = 0
  const bridge = new CoreSystemPlayerBridge(
    {
      command: async (command) => {
        commands.push(command)
      },
      presentation: async () => {
        presentations++
        return presentation()
      },
      lyrics: async () => {
        lyricReads++
        return lyrics()
      },
      queuePage: async (input) =>
        ({
          ...input,
          total: 2,
          items: [{ index: input.offset, queueEntryId: 'second', track: null }]
        }) as never,
      now: () => 1234,
      failed: (error) => errors.push(error),
      ...extra
    },
    {
      state: (value) => states.push(value),
      clock: (value) => clocks.push(value),
      lyrics: (session, island) => {
        sessions.push(session)
        islands.push(island)
      }
    }
  )
  return {
    bridge,
    states,
    clocks,
    sessions,
    islands,
    commands,
    errors,
    get presentations() {
      return presentations
    },
    get lyricReads() {
      return lyricReads
    }
  }
}

test('system state and lyrics are produced from Core without a renderer or playback commands', async () => {
  const f = fixture()
  f.bridge.update(snapshot({ loading: true }))
  await turn()
  const state = f.states.at(-1)!
  assert.equal(state.track?.cover, 'cover://song')
  assert.equal(state.currentTime, 23)
  assert.equal(state.volume, 0.7)
  assert.equal(state.isLoading, true)
  assert.equal(state.favoriteLiked, true)
  assert.equal(f.sessions.at(-1)?.status, 'ready')
  assert.equal(f.sessions.at(-1)?.lyricOffsetMs, 250)
  assert.equal(f.sessions.at(-1)?.lines.length, 2)
  assert.equal(f.islands.at(-1)?.lines[0].original, 'Hello')
  assert.deepEqual(f.commands, [])
  f.bridge.update(snapshot({ sequence: 1, loading: false }))
  assert.equal(f.states.at(-1)?.isLoading, true)
})

test('asynchronous presentation revisions refresh cover/favorite without rereading unchanged lyrics', async () => {
  const f = fixture()
  f.bridge.update(snapshot())
  await turn()
  f.bridge.update(snapshot({ sequence: 2, presentationRevision: 2 }))
  await turn()
  assert.equal(f.presentations, 2)
  assert.equal(f.lyricReads, 1)
  assert.equal(f.errors.length, 0)
})

test('late replies cannot cross occurrences or Core epochs', async () => {
  const art = deferred<CorePlayerPresentation>()
  const text = deferred<CoreSystemLyrics>()
  const f = fixture({ presentation: () => art.promise, lyrics: () => text.promise })
  f.bridge.update(snapshot())
  f.bridge.update(
    snapshot({ epoch: 'two', sequence: 0, queue: { ...snapshot().queue!, occurrenceId: 'second' } })
  )
  art.resolve(presentation())
  text.resolve(lyrics())
  await turn()
  assert.equal(f.states.at(-1)?.track?.cover, null)
  assert.equal(f.sessions.at(-1)?.status, 'loading')
  assert.equal(f.states.at(-1)?.currentTime, 23)
  assert.deepEqual(f.commands, [])
})

test('resume resync emits an accepted fresh lyric clock even without a new Core snapshot', async () => {
  const f = fixture()
  f.bridge.update(snapshot())
  await turn()
  const previous = f.clocks.at(-1)!
  f.bridge.resync()
  await turn()
  const next = f.clocks.at(-1)!
  assert.equal(next.sessionId, previous.sessionId)
  assert.equal(acceptsDesktopLyricsClock(previous, next, previous.sessionId), true)
  assert.equal(f.presentations, 2)
  assert.deepEqual(f.commands, [])
})

test('shortcuts and queue jump route only typed Core actions with occurrence and revision fences', async () => {
  const f = fixture()
  f.bridge.update(snapshot())
  f.bridge.shortcut('playPause')
  f.bridge.shortcut('volumeDown')
  f.bridge.shortcut({ action: 'seek', positionSeconds: 42 })
  f.bridge.shortcut({ action: 'setVolume', volume: 0.25 })
  f.bridge.shortcut({ action: 'jumpQueue', index: 1 })
  await turn()
  assert.deepEqual(f.commands, [
    { type: 'toggle-play' },
    { type: 'volume-step', direction: 'volumeDown' },
    { type: 'seek', value: 42 },
    { type: 'set-volume', value: 0.25 },
    { type: 'queue-jump', id: 'queue', revision: 7, index: 1, occurrenceId: 'second' }
  ])
})

test('Core invalidation clears system projections and cancels a pending queue jump', async () => {
  const page = deferred<Awaited<ReturnType<CoreSystemPlayerTransport['queuePage']>>>()
  const f = fixture({ queuePage: () => page.promise })
  f.bridge.update(snapshot())
  f.bridge.shortcut({ action: 'jumpQueue', index: 1 })
  f.bridge.invalidate()
  page.resolve({
    id: 'queue',
    revision: 7,
    total: 2,
    offset: 1,
    items: [{ index: 1, queueEntryId: 'second', track: null }]
  } as never)
  await turn()
  assert.equal(f.states.at(-1)?.track, null)
  assert.equal(f.states.at(-1)?.isPlaying, false)
  assert.equal(f.sessions.at(-1)?.status, 'idle')
  assert.equal(f.clocks.at(-1)?.state, 'idle')
  assert.equal(f.errors.length, 1)
  assert.deepEqual(f.commands, [])
  await assert.rejects(f.bridge.command({ type: 'play' }), /not ready/)
})
