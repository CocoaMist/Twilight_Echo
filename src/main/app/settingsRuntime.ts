import { app, nativeTheme } from 'electron'
import { runtime } from '../core/runtime'
import type { AppSettings, SettingsSnapshot } from '../core/types'
import { createSettingsSnapshot, normalizeAppSettings, writeAppSettings } from '../core/settings'
import type { AudioOutputState } from '../../shared/audioEngineTypes.ts'
import { applyEffectiveAudioProcessingToEngine } from '../audio/state.ts'
import { getWindowBackgroundColor } from './windowAppearance.ts'
import { ensureMusicCacheDirectories } from '../cache/ncmCache'
import { applyDiscordRpcSetting } from '../integrations/discord'
import {
  applyMiniPlayerMotionPreferenceFromApp,
  applyMiniPlayerSettingsFromApp
} from '../integrations/miniPlayer'
import { syncDesktopLyricsSettings } from '../integrations/desktopLyrics'
import { applyRuntimeSettings } from '../integrations/shortcutsTray'
import { applyLibraryWatchers } from '../library/watcher'

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<SettingsSnapshot> {
  const nextSettings = normalizeAppSettings({ ...runtime.appSettings, ...patch })
  if (Object.prototype.hasOwnProperty.call(patch, 'audioExclusiveAutoRelease')) {
    await runtime.audioEngineManager?.setExclusiveAutoRelease(
      nextSettings.audioExclusiveAutoRelease
    )
  }
  const previousCachePath = runtime.appSettings.musicCachePath
  const shouldUpdateAudioProcessing = Object.prototype.hasOwnProperty.call(patch, 'audioProcessing')
  const shouldUpdateHeadphoneCompensation = Object.prototype.hasOwnProperty.call(
    patch,
    'headphoneCompensation'
  )
  const shouldUpdateAudioOutputConfig = Object.prototype.hasOwnProperty.call(
    patch,
    'audioOutputConfig'
  )
  const shouldUpdateAudioOutput = Object.prototype.hasOwnProperty.call(patch, 'audioOutput')
  const shouldUpdateAudioDevice = Object.prototype.hasOwnProperty.call(patch, 'audioDevice')
  const shouldUpdateExclusiveMode = Object.prototype.hasOwnProperty.call(
    patch,
    'audioExclusiveMode'
  )
  const shouldUpdateWindowBackground =
    Object.prototype.hasOwnProperty.call(patch, 'theme') ||
    Object.prototype.hasOwnProperty.call(patch, 'appBackground')
  runtime.appSettings = nextSettings
  if (shouldUpdateWindowBackground && !runtime.appSettings.windowTransparency) {
    runtime.mainWindow?.setBackgroundColor(
      getWindowBackgroundColor(runtime.appSettings, nativeTheme.shouldUseDarkColors)
    )
  }

  if (
    runtime.audioEngineManager &&
    (shouldUpdateAudioOutput || shouldUpdateAudioDevice || shouldUpdateExclusiveMode)
  ) {
    let audioState: AudioOutputState
    if (shouldUpdateAudioOutput) {
      audioState = await runtime.audioEngineManager.setAudioOutput(
        runtime.appSettings.audioOutput,
        runtime.appSettings.audioDevice
      )
    } else if (shouldUpdateAudioDevice) {
      audioState = await runtime.audioEngineManager.setAudioDevice(runtime.appSettings.audioDevice)
    } else {
      audioState = await runtime.audioEngineManager.getAudioOutputState()
    }

    if (shouldUpdateExclusiveMode && audioState.exclusiveAvailable) {
      audioState = await runtime.audioEngineManager.setExclusiveMode(
        runtime.appSettings.audioExclusiveMode
      )
    }

    runtime.appSettings = normalizeAppSettings({
      ...runtime.appSettings,
      audioOutput: audioState.output,
      audioDevice: audioState.device,
      audioExclusiveMode: audioState.exclusiveMode
    })
  }

  writeAppSettings(runtime.appSettings)

  if (
    runtime.appSettings.musicCachePath &&
    runtime.appSettings.musicCachePath !== previousCachePath
  ) {
    try {
      ensureMusicCacheDirectories(runtime.appSettings.musicCachePath)
    } catch (err) {
      console.warn('创建缓存目录失败：', err)
    }
  }

  if (
    (shouldUpdateAudioProcessing || shouldUpdateHeadphoneCompensation) &&
    runtime.audioEngineManager
  ) {
    try {
      await applyEffectiveAudioProcessingToEngine()
    } catch (err) {
      console.warn('应用合成 DSP 设置到音频引擎失败，已保留设置：', err)
    }
  }

  if (shouldUpdateAudioOutputConfig) {
    await runtime.audioEngineManager?.setOutputConfig(runtime.appSettings.audioOutputConfig)
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'discordRpcEnabled')) {
    applyDiscordRpcSetting(runtime.appSettings.discordRpcEnabled)
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'taskbarThumbarButtonsEnabled')) {
    runtime.refreshTaskbarThumbarButtons?.()
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'smtcEnabled')) {
    runtime.refreshWindowsSmtc?.()
  }

  if (
    Object.prototype.hasOwnProperty.call(patch, 'remoteControlEnabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'remoteControlPort')
  ) {
    try {
      const { syncRemoteControlWithSettings } = await import('../remote/remoteIpc.ts')
      await syncRemoteControlWithSettings()
    } catch (err) {
      console.warn('[remote] failed to sync remote control with settings:', err)
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(patch, 'libraryFolders') ||
    Object.prototype.hasOwnProperty.call(patch, 'watchLibrary')
  ) {
    applyLibraryWatchers(runtime.appSettings.libraryFolders, runtime.appSettings.watchLibrary)
  }

  // Keep already-open lyric controls in sync with the application motion tier.
  if (
    (Object.prototype.hasOwnProperty.call(patch, 'desktopLyrics') ||
      Object.prototype.hasOwnProperty.call(patch, 'lyricsAppearance') ||
      Object.prototype.hasOwnProperty.call(patch, 'motionPreference')) &&
    runtime.desktopLyricsWindow &&
    !runtime.desktopLyricsWindow.isDestroyed()
  ) {
    syncDesktopLyricsSettings()
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'miniPlayer')) {
    applyMiniPlayerSettingsFromApp(runtime.appSettings.miniPlayer)
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'motionPreference')) {
    applyMiniPlayerMotionPreferenceFromApp(runtime.appSettings.motionPreference)
  }

  applyRuntimeSettings()
  const snapshot = createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  runtime.mainWindow?.webContents.send('settings:changed', snapshot)
  const trayWindow = runtime.trayPlayerWindow
  if (trayWindow && !trayWindow.isDestroyed() && !trayWindow.webContents.isDestroyed()) {
    trayWindow.webContents.send('settings:changed', snapshot)
  }
  return snapshot
}

export function relaunchApplication(): void {
  runtime.forceQuit = true
  app.relaunch({
    args: process.argv.slice(1)
  })
  app.quit()
}
