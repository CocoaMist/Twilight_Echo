import { runtime } from '../core/runtime'
import type { AppSettings, SettingsSnapshot } from '../core/types'
import { createSettingsSnapshot, normalizeAppSettings, writeAppSettings } from '../core/settings'
import {
  type AudioProcessingSettings,
  type AudioOutputState,
  type OutputConfig,
  type PlaybackInfo,
  type DspSceneState
} from '../audioEngineManager'
import { buildEffectiveAudioProcessingSettings } from './audioProcessingEffective'
import { processingSettingsPatch } from '../../core/audio/settings.ts'
import { derivePlaybackEvents } from '../plugins/events'
import type { DeviceProfileCommit } from './deviceProfiles.ts'

export function persistDeviceProfileCommit(commit: DeviceProfileCommit): void {
  const { processing, ...patch } = commit
  const next = normalizeAppSettings({
    ...runtime.appSettings,
    ...patch,
    audioProcessing: {
      ...runtime.appSettings.audioProcessing,
      ...processing,
      dsdToPcm: processing.dsdOutputMode === 'pcm'
    }
  })
  writeAppSettings(next)
  runtime.appSettings = next
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(next, runtime.launchSettings)
  )
}

export function persistAudioOutputState(state: AudioOutputState): SettingsSnapshot {
  runtime.appSettings = normalizeAppSettings({
    ...runtime.appSettings,
    audioOutput: state.output,
    audioDevice: state.device,
    audioExclusiveMode: state.exclusiveMode
  })
  writeAppSettings(runtime.appSettings)
  const snapshot = createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  runtime.mainWindow?.webContents.send('settings:changed', snapshot)
  return snapshot
}

export function persistAudioOutputConfig(config: OutputConfig): SettingsSnapshot {
  runtime.appSettings = normalizeAppSettings({
    ...runtime.appSettings,
    audioOutputConfig: config
  })
  writeAppSettings(runtime.appSettings)
  const snapshot = createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  runtime.mainWindow?.webContents.send('settings:changed', snapshot)
  return snapshot
}

export function broadcastPlayerLifecycleEvents(info: PlaybackInfo): void {
  const previous = runtime.lastPluginPlaybackInfo
  runtime.lastPluginPlaybackInfo = info
  for (const event of derivePlaybackEvents(previous, info)) {
    const payload = event.name === 'player:progress' ? event.payload : info
    void runtime.pluginManager?.broadcastEvent(event.name, payload)
  }
}

export function persistAudioProcessingState(processing: AudioProcessingSettings): SettingsSnapshot {
  runtime.appSettings = normalizeAppSettings({
    ...runtime.appSettings,
    ...processingSettingsPatch(runtime.appSettings, processing)
  })
  writeAppSettings(runtime.appSettings)
  const snapshot = createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  runtime.mainWindow?.webContents.send('settings:changed', snapshot)
  return snapshot
}

export function persistDspSceneState(
  state: Pick<DspSceneState, 'scenes' | 'pinnedSceneId'>
): SettingsSnapshot {
  runtime.appSettings = normalizeAppSettings({
    ...runtime.appSettings,
    dspScenes: state.scenes,
    dspPinnedSceneId: state.pinnedSceneId
  })
  writeAppSettings(runtime.appSettings)
  const snapshot = createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  runtime.mainWindow?.webContents.send('settings:changed', snapshot)
  return snapshot
}

export function getEffectiveAudioProcessing(
  settings: AppSettings = runtime.appSettings
): AudioProcessingSettings {
  return buildEffectiveAudioProcessingSettings(
    settings.audioProcessing,
    settings.headphoneCompensation
  )
}

export async function applyEffectiveAudioProcessingToEngine(): Promise<AudioProcessingSettings | null> {
  if (!runtime.audioEngineManager) return null
  return await runtime.audioEngineManager.setAudioProcessing(getEffectiveAudioProcessing())
}

export async function persistAndApplyAudioProcessingState(
  processing: AudioProcessingSettings
): Promise<SettingsSnapshot> {
  try {
    if (runtime.audioEngineManager) {
      await runtime.audioEngineManager.setAudioProcessing(
        buildEffectiveAudioProcessingSettings(processing, runtime.appSettings.headphoneCompensation)
      )
    }
  } catch (err) {
    console.warn('应用合成 DSP 设置到音频引擎失败，未保存用户设置：', err)
    throw err
  }
  return persistAudioProcessingState(processing)
}
