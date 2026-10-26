import type { AppSettings } from '../../shared/appSettings.ts'
import type { CoreOutputEngine } from '../audio/outputService.ts'
import type { CoreDspService } from '../audio/dspService.ts'
import { effectiveAutoMixMode } from '../../shared/twilightAutoMix.ts'

export interface CoreSettingsImportEffects {
  prepare(next: AppSettings, signal: AbortSignal): Promise<AppSettings>
  apply(previous: AppSettings, next: AppSettings): Promise<Partial<AppSettings>>
  rollback(previous: AppSettings): Promise<void>
}

/** Called inside the existing output configuration lane, never the transport lane. */
export function createSettingsImportEffects(
  audio: Pick<
    CoreOutputEngine,
    | 'getAudioOutputState'
    | 'setAudioOutput'
    | 'setExclusiveMode'
    | 'setExclusiveAutoRelease'
    | 'setOutputConfig'
    | 'stop'
  > & { setAutoMixMode(mode: AppSettings['autoMixMode']): Promise<boolean> },
  dsp: Pick<CoreDspService, 'prepareSettingsRestore' | 'restoreSettings'>
): CoreSettingsImportEffects {
  return {
    prepare: (next, signal) => dsp.prepareSettingsRestore(next, signal),
    async apply(previous, next) {
      if (
        next.autoMixMode !== previous.autoMixMode &&
        !(await audio.setAutoMixMode(effectiveAutoMixMode(next.autoMixMode)))
      )
        throw new Error('音频引擎未能应用 AutoMix 模式')
      if (next.audioExclusiveAutoRelease !== previous.audioExclusiveAutoRelease)
        await audio.setExclusiveAutoRelease(next.audioExclusiveAutoRelease)
      let state = await audio.getAudioOutputState()
      if (next.audioOutput !== state.output || next.audioDevice !== state.device)
        state = await audio.setAudioOutput(next.audioOutput, next.audioDevice)
      if (state.exclusiveAvailable && next.audioExclusiveMode !== state.exclusiveMode)
        state = await audio.setExclusiveMode(next.audioExclusiveMode)
      if (JSON.stringify(next.audioOutputConfig) !== JSON.stringify(previous.audioOutputConfig))
        await audio.setOutputConfig(next.audioOutputConfig)
      const processing = await dsp.restoreSettings(next)
      return {
        ...processing,
        audioOutput: state.output,
        audioDevice: state.device,
        audioExclusiveMode: state.exclusiveMode
      }
    },
    async rollback(previous) {
      try {
        if (!(await audio.setAutoMixMode(effectiveAutoMixMode(previous.autoMixMode))))
          throw new Error('AutoMix rollback failed')
        await audio.setExclusiveAutoRelease(previous.audioExclusiveAutoRelease)
      } catch {
        await audio.stop()
      }
    }
  }
}
