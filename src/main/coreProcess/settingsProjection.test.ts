import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createDefaultSettings } from '../../core/settings/normalization.ts'
import type { CoreSettingsState } from '../../shared/coreSettings.ts'

test('main projects OS/window settings without a writer, audio calls or library watchers', () => {
  const events: string[] = []
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: () => events.push('background'),
    webContents: { isDestroyed: () => false, send: () => events.push('broadcast') }
  }
  const runtime = {
    appSettings: createDefaultSettings('win32'),
    launchSettings: {},
    mainWindow: window,
    trayPlayerWindow: window,
    desktopLyricsWindow: window,
    refreshTaskbarThumbarButtons: () => events.push('taskbar'),
    refreshWindowsSmtc: () => events.push('smtc')
  }
  const dependencies: Record<string, unknown> = {
    electron: { nativeTheme: {} },
    '../core/runtime.ts': { runtime },
    '../core/settings.ts': { createSettingsSnapshot: (settings: unknown) => settings },
    '../app/windowAppearance.ts': {
      syncWindowFrameAppearance: () => events.push('frame'),
      getWindowBackgroundColor: () => '#000'
    },
    '../integrations/discord.ts': { applyDiscordRpcSetting: () => events.push('discord') },
    '../integrations/miniPlayer.ts': {
      applyMiniPlayerMotionPreferenceFromApp: () => events.push('motion'),
      applyMiniPlayerSettingsFromApp: () => events.push('mini')
    },
    '../integrations/desktopLyrics.ts': { syncDesktopLyricsSettings: () => events.push('lyrics') },
    '../integrations/shortcutsTray.ts': {
      applyAutoLaunch: () => events.push('launch'),
      registerPlayerShortcuts: () => events.push('shortcuts'),
      syncTrayState: () => events.push('tray')
    }
  }
  const exports: { projectCoreSettings?: (state: CoreSettingsState) => void } = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./settingsProjection.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      structuredClone,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      }
    }
  )
  const settings = {
    ...runtime.appSettings,
    theme: 'dark' as const,
    launchAtLogin: true,
    discordRpcEnabled: !runtime.appSettings.discordRpcEnabled,
    smtcEnabled: !runtime.appSettings.smtcEnabled,
    globalShortcuts: !runtime.appSettings.globalShortcuts,
    libraryFolders: ['D:/Music'],
    watchLibrary: false,
    closeWindowBehavior: 'tray' as const,
    minimizeToTray: !runtime.appSettings.minimizeToTray,
    motionPreference: 'reduced' as const,
    taskbarThumbarButtonsEnabled: !runtime.appSettings.taskbarThumbarButtonsEnabled
  }
  exports.projectCoreSettings!({ revision: 1, settings })
  assert.equal(runtime.appSettings.theme, 'dark')
  assert.deepEqual(
    events.sort(),
    [
      'frame',
      'background',
      'launch',
      'discord',
      'smtc',
      'shortcuts',
      'tray',
      'lyrics',
      'motion',
      'taskbar',
      'broadcast',
      'broadcast'
    ].sort()
  )
  settings.libraryFolders.push('client mutation')
  assert.deepEqual(runtime.appSettings.libraryFolders, ['D:/Music'])
  events.length = 0
  exports.projectCoreSettings!({
    revision: 2,
    settings: { ...runtime.appSettings, softwareVolume: 0.2 }
  })
  assert.deepEqual(
    events,
    ['broadcast', 'broadcast'],
    'volume commits must not re-register shortcuts or restart integrations'
  )
})
