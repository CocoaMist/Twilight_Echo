import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import type { Track } from '../../types/music'
import { createBpmAnalysisController } from './bpmAnalysisController.ts'

const analysis: NonNullable<Track['bpmAnalysis']> = {
  bpm: 120,
  confidence: 0.9,
  source: 'analyzed',
  analyzedAt: '2026-10-02T00:00:00Z',
  algorithmVersion: 1
}
const track = (id: string, filePath = `D:\\Music\\${id}.flac`): Track =>
  ({ id, filePath, bpm: 118 }) as Track

function fixture(request: typeof window.api.bpmAnalysis.request) {
  const currentTrack = shallowRef<Track | null>(track('active'))
  const queue = shallowRef<Track[]>([currentTrack.value!, track('next')])
  const originalQueue = shallowRef<Track[]>(queue.value.slice())
  const patches: Track[] = []
  const writes: unknown[][] = []
  let enabled = true
  const controller = createBpmAnalysisController({
    currentTrack,
    queue,
    originalQueue,
    isEnabled: () => enabled,
    patchTrackInQueues: (updated) => patches.push(updated),
    getAnalysisApi: () => ({ request }) as typeof window.api.bpmAnalysis,
    getMusicStore: () => ({
      applyBpmAnalysis: (...args) => {
        writes.push(args)
        return true
      },
      clearBpmAnalysis: () => {
        writes.push(['clear'])
        return true
      }
    })
  })
  return {
    ...controller,
    currentTrack,
    queue,
    originalQueue,
    patches,
    writes,
    disable: () => {
      enabled = false
    }
  }
}

test('background BPM requests deduplicate pending work and release their key after errors', async () => {
  let calls = 0
  let finish!: (result: Awaited<ReturnType<typeof window.api.bpmAnalysis.request>>) => void
  const state = fixture(async (request) => {
    calls++
    assert.equal(request.referenceBpm, 118)
    if (calls === 2) throw new Error('offline')
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const target = track('next')
  const first = state.requestBpmAnalysisForTrack(target)
  await state.requestBpmAnalysisForTrack(target)
  assert.equal(calls, 1)
  finish({ status: 'completed', analysis })
  await first
  assert.equal(state.queue.value[1].bpmAnalysis?.bpm, 120)
  assert.equal(state.originalQueue.value[1].bpmAnalysis?.bpm, 120)
  assert.equal(state.queue.value[0], state.currentTrack.value)
  await state.requestBpmAnalysisForTrack(target)
  const retry = state.requestBpmAnalysisForTrack(target)
  assert.equal(calls, 3)
  finish({ status: 'skipped', reason: 'unsupported' })
  await retry
  assert.equal(state.writes.length, 1)
})

test('active BPM completion preserves transient fields and reset clears both queues and library', () => {
  const state = fixture(async () => ({ status: 'cached', analysis }))
  state.currentTrack.value = {
    ...state.currentTrack.value!,
    lyrics: 'keep lyrics',
    cover: 'cover://keep'
  }
  state.applyBpmAnalysisToTrack('different-id', state.currentTrack.value.filePath, analysis)
  assert.equal(state.currentTrack.value.lyrics, 'keep lyrics')
  assert.equal(state.currentTrack.value.cover, 'cover://keep')
  assert.equal(state.patches[0], state.currentTrack.value)
  state.applyBpmAnalysisToTrack('next', state.queue.value[1].filePath, analysis)
  state.clearBpmAnalysisFromPlaybackState()
  assert.equal(state.currentTrack.value.bpmAnalysis, undefined)
  assert.ok([...state.queue.value, ...state.originalQueue.value].every((item) => !item.bpmAnalysis))
  assert.deepEqual(state.writes.at(-1), ['clear'])
})

test('disabled analysis, existing analysis and remote URLs never schedule work', async () => {
  let calls = 0
  const state = fixture(async () => {
    calls++
    return { status: 'cached', analysis }
  })
  await state.requestBpmAnalysisForTrack({ ...track('done'), bpmAnalysis: analysis })
  await state.requestBpmAnalysisForTrack(track('remote', 'https://audio.invalid/song.flac'))
  state.disable()
  await state.requestBpmAnalysisForTrack(track('disabled'))
  assert.equal(calls, 0)
})

test('completion event and request result apply one library update, with content/version changes preserved', async () => {
  let finish!: (result: Awaited<ReturnType<typeof window.api.bpmAnalysis.request>>) => void
  const state = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const selected = state.currentTrack.value!
  const request = state.requestBpmAnalysisForTrack(selected)
  state.applyBpmAnalysisToTrack(selected.id, selected.filePath, analysis)
  const applied = state.currentTrack.value
  finish({ status: 'completed', analysis: { ...analysis } })
  await request
  assert.equal(state.currentTrack.value, applied)
  assert.equal(state.patches.length, 1)
  assert.equal(state.writes.length, 1)
  state.applyBpmAnalysisToTrack(selected.id, selected.filePath, {
    ...analysis,
    algorithmVersion: 2
  })
  state.applyBpmAnalysisToTrack(selected.id, selected.filePath, {
    ...analysis,
    algorithmVersion: 2,
    tempoMap: [{ startMs: 0, endMs: 1000, bpm: 122, confidence: 0.8 }]
  })
  assert.equal(state.writes.length, 3)
  state.clearBpmAnalysisFromPlaybackState()
  state.applyBpmAnalysisToTrack(selected.id, selected.filePath, analysis)
  assert.equal(state.patches.length, 4)
})

test('later cached results consult a reloaded library without replacing unchanged playback state', async () => {
  const state = fixture(async () => ({ status: 'cached', analysis: { ...analysis } }))
  const selected = state.currentTrack.value!
  await state.requestBpmAnalysisForTrack(selected)
  const applied = state.currentTrack.value
  // The fixture accepts library writes, representing a library reloaded from
  // a snapshot without BPM. Playback can already contain the same analysis.
  await state.requestBpmAnalysisForTrack(selected)
  assert.equal(state.writes.length, 2)
  assert.equal(state.currentTrack.value, applied)
  assert.equal(state.patches.length, 1)
})
