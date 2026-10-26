import type { AppSettings } from '../../shared/appSettings.ts'
import type { AudioEngineConfig } from '../../shared/audioEngineTypes.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import type { DeviceProfileCommit } from './deviceProfiles.ts'
import type { AudioOutputCommit } from './audioEngineTypes.ts'
import { buildEffectiveAudioProcessingSettings } from './audioProcessingEffective.ts'
import { normalizeAudioProcessingSettings, normalizeOutputConfig } from './audioEngineHelpers.ts'
import {
  normalizeDspScenes,
  createLegacyDspGraph,
  extractStereoImageFromGraph
} from '../../shared/dspGraph.ts'
import type { AudioProcessingSettings } from '../../shared/audioEngineTypes.ts'

export function processingSettingsPatch(
  settings: AppSettings,
  processing: AudioProcessingSettings
): Partial<AppSettings> {
  const effective = buildEffectiveAudioProcessingSettings(
    processing,
    settings.headphoneCompensation
  )
  return {
    audioProcessing: processing,
    dspScenes: normalizeDspScenes(settings.dspScenes, effective).map((scene) =>
      scene.id === 'default'
        ? {
            ...scene,
            graph: createLegacyDspGraph({
              ...effective,
              outputStage: scene.graph.outputStage,
              stereoImage: extractStereoImageFromGraph(scene.graph)
            })
          }
        : scene
    )
  }
}

export function coreAudioConfiguration(settings: AppSettings): AudioEngineConfig {
  return {
    audioOutput: settings.audioOutput,
    audioDevice: settings.audioDevice,
    exclusiveMode: settings.audioExclusiveMode,
    exclusiveAutoRelease: settings.audioExclusiveAutoRelease,
    audioOutputConfig: settings.audioOutputConfig,
    audioProcessing: buildEffectiveAudioProcessingSettings(
      settings.audioProcessing,
      settings.headphoneCompensation
    ),
    dspScenes: settings.dspScenes,
    dspPinnedSceneId: settings.dspPinnedSceneId,
    audioDeviceProfiles: settings.audioDeviceProfiles,
    volume: settings.softwareVolume
  }
}

/** Startup-only compatibility inputs. Persisted settings always win on subsequent launches. */
export function initialAudioSettings(config?: AudioEngineConfig): Partial<AppSettings> {
  if (!config) return {}
  const fields: Partial<AppSettings> = {}
  if (config.audioOutput !== undefined) fields.audioOutput = config.audioOutput
  if (config.audioDevice !== undefined) fields.audioDevice = config.audioDevice
  if (config.exclusiveMode !== undefined) fields.audioExclusiveMode = config.exclusiveMode
  if (config.exclusiveAutoRelease !== undefined)
    fields.audioExclusiveAutoRelease = config.exclusiveAutoRelease
  if (config.audioOutputConfig !== undefined)
    fields.audioOutputConfig = normalizeOutputConfig(config.audioOutputConfig)
  if (config.audioProcessing !== undefined) {
    fields.audioProcessing = normalizeAudioProcessingSettings(config.audioProcessing)
    if (config.dspScenes === undefined)
      fields.dspScenes = normalizeDspScenes(undefined, fields.audioProcessing)
  }
  if (config.dspScenes !== undefined) fields.dspScenes = config.dspScenes
  if (config.dspPinnedSceneId !== undefined) fields.dspPinnedSceneId = config.dspPinnedSceneId
  if (config.audioDeviceProfiles !== undefined)
    fields.audioDeviceProfiles = config.audioDeviceProfiles
  if (config.volume !== undefined) fields.softwareVolume = config.volume
  return fields
}

export function createCoreAudioPersistence(repository: CoreSettingsRepository) {
  return {
    output: (commit: AudioOutputCommit): void => {
      repository.update(commit)
    },
    profile: (commit: DeviceProfileCommit): void => {
      const { processing, ...patch } = commit
      repository.update({
        ...patch,
        audioProcessing: {
          ...repository.read().audioProcessing,
          ...processing,
          dsdToPcm: processing.dsdOutputMode === 'pcm'
        }
      })
    }
  }
}
