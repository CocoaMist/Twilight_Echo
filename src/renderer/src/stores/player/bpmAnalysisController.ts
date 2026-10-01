import type { Ref } from 'vue'
import type { Track } from '../../types/music'
import type { useMusicStore } from '../useMusicStore.ts'
import { hasAnalyzedBpm, isAnalyzableAudioPath } from '../../utils/playerTrackUtils.ts'

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

  function applyBpmAnalysisToTrack(
    trackId: string,
    filePath: string,
    analysis: Track['bpmAnalysis']
  ): void {
    if (!analysis) return
    const target = currentTrack.value
    if (target && (target.id === trackId || target.filePath === filePath)) {
      const updatedTrack = {
        ...target,
        bpmAnalysis: analysis
      }
      currentTrack.value = updatedTrack
      patchTrackInQueues(updatedTrack)
    } else {
      for (const tracks of [queue, originalQueue]) {
        tracks.value = tracks.value.map((track) =>
          track.id === trackId || track.filePath === filePath
            ? { ...track, bpmAnalysis: analysis }
            : track
        )
      }
    }
    getMusicStore().applyBpmAnalysis(trackId, filePath, analysis)
  }

  function clearBpmAnalysisFromPlaybackState(): void {
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
    }
  }
  return { applyBpmAnalysisToTrack, clearBpmAnalysisFromPlaybackState, requestBpmAnalysisForTrack }
}
