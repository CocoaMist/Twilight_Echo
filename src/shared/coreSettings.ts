import type { AppSettings } from './appSettings.ts'

/** These settings are committed by the existing playback/output/DSP commands. */
export const CORE_SPECIALIZED_SETTINGS = [
  'playMode',
  'softwareVolume',
  'audioOutput',
  'audioDevice',
  'audioExclusiveMode',
  'audioExclusiveAutoRelease',
  'audioOutputConfig',
  'audioDeviceProfiles',
  'audioProcessing',
  'audioEqAutoPreamp',
  'headphoneCompensation',
  'dspScenes',
  'dspPinnedSceneId'
] as const satisfies readonly (keyof AppSettings)[]

export type CoreSettingsPatch = Partial<
  Omit<AppSettings, (typeof CORE_SPECIALIZED_SETTINGS)[number]>
>
export interface CoreSettingsEdit {
  revision: number
  patch: CoreSettingsPatch
}
export interface CoreSettingsState {
  revision: number
  settings: AppSettings
}
export type CoreSettingsPaths = Partial<
  Pick<AppSettings, 'libraryFolders' | 'downloadFolder' | 'musicCachePath'>
>
