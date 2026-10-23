export * from '../../core/audio/audioDiagnostics.ts'
import {
  AudioDiagnosticRecorder as CoreRecorder,
  type AudioDiagnosticRecorderOptions
} from '../../core/audio/audioDiagnostics.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'

/** The legacy adapter keeps its shared logger while Core injects its own lifecycle. */
export class AudioDiagnosticRecorder extends CoreRecorder {
  constructor(options: AudioDiagnosticRecorderOptions) {
    super({
      ...options,
      writeDiagnostic: (event, details, level) => writeDiagnostic('audio', event, details, level)
    })
  }
}
