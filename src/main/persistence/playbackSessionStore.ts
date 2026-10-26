import { app } from 'electron'
import {
  createPlaybackSessionStoreBundle,
  type PlaybackSessionStoreBundle
} from './playbackSessionRepository.ts'
import { reportPersistentDataRecovery } from '../ipc/persistenceReporting.ts'
export {
  MAX_PLAYBACK_SESSION_BYTES,
  MAX_PLAYBACK_QUEUE_BYTES
} from './playbackSessionRepository.ts'
export type { PlaybackSessionStoreBundle } from './playbackSessionRepository.ts'

let bundle: PlaybackSessionStoreBundle | null = null
export function getPlaybackSessionStoreBundle(): PlaybackSessionStoreBundle {
  return (bundle ??= createPlaybackSessionStoreBundle(
    app.getPath('userData'),
    reportPersistentDataRecovery
  ))
}
