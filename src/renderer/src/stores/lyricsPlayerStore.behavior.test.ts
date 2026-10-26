import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, shallowRef } from 'vue'
import { CoreLyricsService } from '../../../core/lyrics/service.ts'
import { createCoreLyricsManagement } from './lyricsManagement.ts'
import {
  DEFAULT_LYRICS_MANAGEMENT,
  type LyricsManagementDocument
} from '../../../shared/lyricsManagement.ts'
import { coreSnapshot } from './coreTestFixtures.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreLyricsMutation } from '../../../shared/coreLyrics.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'
import type { TrackData } from '../../../shared/track.ts'

const turn = async () => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
}
const track: TrackData = {
  id: 'provider:song',
  source: 'provider',
  queueEntryId: 'second',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  filePath: '',
  fileName: '',
  duration: 180,
  size: 0,
  cover: null,
  lyrics: null
}

test('real Core lyrics survive renderer disposal and reconnect without replaying edits or resolution', async (t) => {
  const state = shallowRef<CoreSnapshot | null>(null)
  let document: LyricsManagementDocument = structuredClone(DEFAULT_LYRICS_MANAGEMENT)
  let revision = 0,
    resolutions = 0
  const writes: unknown[] = [],
    commands: string[] = []
  const envelope = () => ({
    version: 2 as const,
    revision,
    savedAt: '2026-10-23T00:00:00Z',
    data: structuredClone(document)
  })
  const publish = () => {
    state.value = coreSnapshot({
      phase: 'ready',
      epoch: 'core-one',
      sequence: (state.value?.sequence ?? 0) + 1,
      track,
      queue: { id: 'q', revision: 1, total: 1, index: 0, occurrenceId: track.queueEntryId! },
      lyricsRevision: service.getRevision(),
      lyricsContentRevision: service.getContentRevision()
    })
  }
  const service = new CoreLyricsService({
    repository: {
      load: async () => envelope(),
      save: async (next, expected) => {
        assert.equal(expected, revision)
        writes.push(structuredClone(next))
        document = structuredClone(next)
        revision++
        return envelope()
      }
    },
    now: Date.now,
    changed: () => publish(),
    failed: (error) => {
      throw error
    },
    timers: { setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
    sources: {
      getAppSettings: () => ({ value: { onlineLyricsFallback: false } }),
      loadLocalLyrics: async () => null,
      resolveProviderLyrics: async () => {
        resolutions++
        return { lyrics: '[00:01]Provider', translatedLyrics: '[00:01]Translation' }
      },
      loadAmlTtml: async () => null,
      loadOnlineLyrics: async () => null
    },
    search: async (current) => ({
      query: { title: current.title, artist: current.artist },
      candidates: [],
      best: null
    }),
    importDraft: async () => '[00:02]Imported',
    exportDraft: async () => 'D:/fixture/lyrics.lrc'
  })
  t.after(() => service.shutdown())
  await service.initialize()
  service.observe(track)
  service.activate()
  for (let i = 0; i < 20 && service.state().loadState.status !== 'ready'; i++) await turn()
  publish()
  const core: Pick<CorePlayerClient, 'state' | 'attach' | 'query' | 'command'> = {
    state,
    attach: async () => state.value!,
    query: async (name) => (name === 'lyrics.state' ? service.state() : service.content()) as never,
    command: async (name, payload) => {
      commands.push(name)
      if (name === 'lyrics.edit') return service.edit(payload as CoreLyricsMutation)
      if (name === 'lyrics.importDraft') return service.importDraft()
      if (name === 'lyrics.exportDraft')
        return service.exportDraft((payload as { contents: string }).contents)
      throw new Error(name)
    }
  }
  const first = createCoreLyricsManagement(core)
  await first.ensureLoaded()
  const read = first.getRevision()
  await first.updateTrack(
    track.id,
    { originalSelection: 'manual', original: '[00:02]Edited', offsetMs: 200 },
    read
  )
  await turn()
  assert.equal(first.entryFor(track.id)?.original, '[00:02]Edited')
  assert.equal(service.content().effective?.original, '[00:02]Edited')
  assert.equal(await first.importDraft(), '[00:02]Imported')
  assert.equal(await first.exportDraft('[00:02]Draft only'), 'D:/fixture/lyrics.lrc')
  assert.equal(writes.length, 1)
  first.dispose()
  await service.edit({ revision: 1, edit: { kind: 'globalOffset', offsetMs: -50 } })
  const count = resolutions,
    commandCount = commands.length
  const second = createCoreLyricsManagement(core)
  t.after(second.dispose)
  await second.ensureLoaded()
  assert.equal(second.entryFor(track.id)?.original, '[00:02]Edited')
  assert.equal(second.effectiveOffsetSeconds(track.id), 0.15)
  assert.equal(resolutions, count)
  assert.equal(commands.length, commandCount)
  assert.equal(writes.length, 2)
  assert.deepEqual(Object.keys(second.document.value.tracks), [track.id])
})
