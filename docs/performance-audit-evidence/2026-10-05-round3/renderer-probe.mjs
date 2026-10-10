import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shallowRef, ref, nextTick } from 'vue'
import { ListeningStatsPersistence } from '../../../src/renderer/src/stores/listeningStatsPersistence.ts'
import { createPlaybackSessionPersistence } from '../../../src/renderer/src/app/usePlaybackSessionPersistence.ts'
import { PlaybackSessionWriter } from '../../../src/renderer/src/app/playbackSessionWriter.ts'
import { createBpmAnalysisController } from '../../../src/renderer/src/stores/player/bpmAnalysisController.ts'
import { BpmAnalysisManager } from '../../../src/main/bpm/bpmAnalysisManager.ts'
import { toPlaybackQueueSnapshot } from '../../../src/renderer/src/utils/playbackQueueVirtualization.ts'

const emit = value => console.log(JSON.stringify(value))
const root = new URL('../../../', import.meta.url)
const playerSource = readFileSync(new URL('src/renderer/src/stores/usePlayerStore.ts', root), 'utf8')
const patchBody = playerSource.match(/function patchTrackInQueues\(updatedTrack: Track\): void \{([\s\S]*?)\n\}/)?.[1]
assert.ok(patchBody, 'Production queue patch function must be found')

// Virtual time drives the real persistence scheduler, without a 5 minute wait.
let clock = 0, id = 0, writes = 0
const tasks = new Map()
const advance = to => {
  while (true) {
    const next = [...tasks].filter(([, task]) => task.at <= to).sort((a,b) => a[1].at - b[1].at)[0]
    if (!next) break
    clock = next[1].at; tasks.delete(next[0]); next[1].callback()
  }
  clock = to
}
const persistence = new ListeningStatsPersistence({
  key: 'probe', storage: { getItem: () => null, setItem: () => writes++ },
  getSnapshot: () => ({ seconds: clock / 1000 }), beforePersist: () => {}, onStatus: () => {},
  flushDelayMs: 30000, retryDelayMs: 60000,
  setTimeout: (callback, delay) => { const token = ++id; tasks.set(token, { at: clock + delay, callback }); return token },
  clearTimeout: token => tasks.delete(token)
})
for (let time = 5000; time <= 300000; time += 5000) { advance(time); persistence.markDirty() }
const duringPlayback = writes
advance(329999)
assert.equal(writes, 0)
advance(330000)
assert.equal(writes, 1)
emit({ kind: 'statsTimer', simulatedPlaybackSeconds: 300, dirtyUpdates: 60, writesDuringPlayback: duringPlayback,
  firstWriteSeconds: clock / 1000 })
persistence.dispose()

const makeTrack = i => ({ id: `local:${i}`, queueEntryId: `queue:${i}`, title: `Track ${i}`, artist: 'Artist', album: 'Album',
  filePath: `D:/AuditMusic/${i}.flac`, fileName: `${i}.flac`, duration: 180, size: 1000000, cover: null, lyrics: null, source: 'local' })
const queue = shallowRef(Array.from({ length: 5000 }, (_,i) => makeTrack(i)))
const originalQueue = shallowRef([...queue.value])
const currentTrack = shallowRef(null), position = ref(0), playing = ref(false)
const patch = new Function('queue','originalQueue','toPlaybackQueueSnapshot','updatedTrack', patchBody)
const writer = new PlaybackSessionWriter()
const saved = []
let revision = 0
const dataApi = {
  loadPlaybackSession: async () => null,
  clearPlaybackSession: async () => undefined,
  savePlaybackSession: async session => { saved.push({ entries: session.queue?.length ?? 0, track: session.track.id });
    return { version: 2, revision: ++revision, data: session } }
}
const session = createPlaybackSessionPersistence({ settings: ref({ playbackResumeMode: 'trackAndPosition' }),
  currentTrack, currentTime: position, isPlaying: playing, queue, dataApi, sessionWriter: writer,
  restorePlaybackSession: () => {}, syncPluginProviders: async () => {},
  createPlaybackSession: mode => currentTrack.value ? ({ version: 1, savedAt: '', mode, track: currentTrack.value, position: 0 }) : null
})
await session.restoreSavedPlaybackSession('trackAndPosition')
session.startAutosaveWatchers()
for (let i = 0; i < 12; i++) {
  currentTrack.value = { ...queue.value[i] }
  // resolvePlayTarget -> patchTrackInQueues is part of every manual load.
  patch(queue, originalQueue, toPlaybackQueueSnapshot, currentTrack.value)
  await nextTick(); await writer.whenIdle()
}
session.stop()
assert.equal(saved.length, 12)
assert.equal(saved.filter(s => s.entries === 5000).length, 12)
emit({ kind: 'rapidSelectionSessionWrites', selections: 12, fullQueueSize: 5000, immediateWrites: saved.length,
  fullQueueWrites: saved.filter(s => s.entries === 5000).length, totalQueueEntriesSent: saved.reduce((sum,s) => sum+s.entries,0),
  note: 'real queue patch, Vue post watchers and writer; disk/IPC replaced by receipt stub; store debounce not invoked' })

// A real manager emits onComplete before returning completed to its requester.
const directory = mkdtempSync(join(tmpdir(), 'twilight-bpm-dual-delivery-'))
const filePath = join(directory, 'fixture.flac'); writeFileSync(filePath, 'analysis-boundary-placeholder')
const target = { ...makeTrack(0), filePath }
const bpmTrack = shallowRef(target), bpmQueue = shallowRef([target]), bpmOriginal = shallowRef([target])
let controller, patches = 0, libraryWrites = 0, analyses = 0, events = 0
const result = { bpm: 120, confidence: .9, source: 'analyzed', analyzedAt: '2026-10-05T00:00:00Z', algorithmVersion: 1 }
const manager = new BpmAnalysisManager({ cache: { get: async () => null, set: async () => {}, deleteIfMatches: async () => {} },
  analyzeFile: async () => { analyses++; return result },
  onComplete: event => { events++; controller.applyBpmAnalysisToTrack(event.trackId, event.filePath, event.analysis) }
})
controller = createBpmAnalysisController({ currentTrack: bpmTrack, queue: bpmQueue, originalQueue: bpmOriginal,
  isEnabled: () => true, patchTrackInQueues: () => patches++,
  getMusicStore: () => ({ applyBpmAnalysis: () => { libraryWrites++; return true }, clearBpmAnalysis: () => true }),
  getAnalysisApi: () => ({ request: request => manager.requestAnalysis(request) })
})
await controller.requestBpmAnalysisForTrack(target)
assert.equal(analyses, 1); assert.equal(patches, 2); assert.equal(libraryWrites, 2)
emit({ kind: 'bpmDualDelivery', analyses, completionEvents: events, playbackQueuePatches: patches, libraryApplyCalls: libraryWrites,
  note: 'real file identity, main manager and renderer controller; analysis, cache, IPC transport and library are stubs' })
