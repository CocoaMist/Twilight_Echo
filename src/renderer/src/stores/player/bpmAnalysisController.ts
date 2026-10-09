import type { Ref } from 'vue'
import type { Track } from '../../types/music'
import type { useMusicStore } from '../useMusicStore.ts'
import { hasAnalyzedBpm, isAnalyzableAudioPath } from '../../utils/playerTrackUtils.ts'
import { equalBpmAnalysis } from '../../utils/bpmAnalysisEquality.ts'

export function createBpmAnalysisController({
  currentTrack,
  queue,
  originalQueue,
  isEnabled,
  patchTrackInQueues,
  getMusicStore,
  getAnalysisApi
}: {
  currentTrack: Ref<Track | null>
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  isEnabled: () => boolean
  patchTrackInQueues: (track: Track) => void
  getMusicStore: () => Pick<
    ReturnType<typeof useMusicStore>,
    'applyBpmAnalysis' | 'clearBpmAnalysis'
  >
  getAnalysisApi: () => typeof window.api.bpmAnalysis | undefined
}) {
  const bpmAnalysisRequests = new Set<string>()
  const appliedResults = new Map<string, Track['bpmAnalysis']>()

  function applyBpmAnalysisToTrack(
    trackId: string,
    filePath: string,
    analysis: Track['bpmAnalysis']
  ): void {
    if (!analysis) return
    const target = currentTrack.value
    if (target && (target.id === trackId || target.filePath === filePath)) {
      if (!equalBpmAnalysis(target.bpmAnalysis, analysis)) {
        const updatedTrack = {
          ...target,
          bpmAnalysis: analysis
        }
        currentTrack.value = updatedTrack
        patchTrackInQueues(updatedTrack)
      }
    } else {
      for (const tracks of [queue, originalQueue]) {
        let updated: Track[] | null = null
        for (let index = 0; index < tracks.value.length; ++index) {
          const track = tracks.value[index]
          if (
            (track.id !== trackId && track.filePath !== filePath) ||
            equalBpmAnalysis(track.bpmAnalysis, analysis)
          )
            continue
          updated ??= tracks.value.slice()
          updated[index] = { ...track, bpmAnalysis: analysis }
        }
        if (updated) tracks.value = updated
      }
    }
    const key = `${trackId}\u0000${filePath}`
    // Coalesce the event and reply of one pending request. A later request
    // must consult the library again: it may have been reloaded or restored.
    const coalescing = bpmAnalysisRequests.has(key)
    if (!coalescing || !equalBpmAnalysis(appliedResults.get(key), analysis)) {
      if (getMusicStore().applyBpmAnalysis(trackId, filePath, analysis) && coalescing) {
        if (appliedResults.size >= 64) appliedResults.delete(appliedResults.keys().next().value!)
        appliedResults.set(key, analysis)
      }
    }
  }

  function clearBpmAnalysisFromPlaybackState(): void {
    appliedResults.clear()
    if (currentTrack.value?.bpmAnalysis) {
      const { bpmAnalysis: _bpmAnalysis, ...nextTrack } = currentTrack.value
      currentTrack.value = nextTrack
    }
    for (const tracks of [queue, originalQueue]) {
      tracks.value = tracks.value.map((track) => {
        if (!track.bpmAnalysis) return track
        const { bpmAnalysis: _bpmAnalysis, ...nextTrack } = track
        return nextTrack
      })
    }
    getMusicStore().clearBpmAnalysis()
  }

  async function requestBpmAnalysisForTrack(track: Track): Promise<void> {
    if (!isEnabled() || hasAnalyzedBpm(track) || !isAnalyzableAudioPath(track.filePath)) return
    const key = `${track.id}\u0000${track.filePath}`
    if (bpmAnalysisRequests.has(key)) return
    bpmAnalysisRequests.add(key)
    try {
      const result = await getAnalysisApi()?.request({
        trackId: track.id,
        filePath: track.filePath,
        referenceBpm: track.bpm
      })
      if (result?.status === 'cached' || result?.status === 'completed') {
        applyBpmAnalysisToTrack(track.id, track.filePath, result.analysis)
      }
    } catch {
      // BPM analysis is best-effort; playback and live visualization continue.
    } finally {
      bpmAnalysisRequests.delete(key)
      appliedResults.delete(key)
    }
  }
  return { applyBpmAnalysisToTrack, clearBpmAnalysisFromPlaybackState, requestBpmAnalysisForTrack }
}
