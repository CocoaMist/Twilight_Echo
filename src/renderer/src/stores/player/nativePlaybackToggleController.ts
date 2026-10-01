import type { Ref } from 'vue'

interface NativePlaybackToggleOptions {
  isPlaying: Ref<boolean>
  togglePause: () => Promise<void>
  setPlaybackToggleIntent: (playing: boolean) => void
  clearPlaybackToggleIntent: () => void
  setAudioEngineError: (message: string) => void
}

export function createNativePlaybackToggleController(options: NativePlaybackToggleOptions) {
  let revision = 0

  async function togglePause(): Promise<void> {
    const request = ++revision
    const wasPlaying = options.isPlaying.value
    options.isPlaying.value = !wasPlaying
    options.setPlaybackToggleIntent(!wasPlaying)
    try {
      await options.togglePause()
      if (request === revision) options.setPlaybackToggleIntent(options.isPlaying.value)
    } catch (error) {
      if (request === revision) {
        options.clearPlaybackToggleIntent()
        options.isPlaying.value = wasPlaying
      }
      options.setAudioEngineError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  return { togglePause }
}
