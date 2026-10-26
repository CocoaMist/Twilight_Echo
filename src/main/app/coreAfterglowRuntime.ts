import { app, globalShortcut, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { runtime } from '../core/runtime.ts'
import {
  AFTERGLOW_RESTORE_ACCELERATORS,
  type AfterglowTransportCommand
} from '../../shared/afterglowMode.ts'
import { getCoreApplication } from './coreApplication.ts'
import { CoreAfterglow } from './coreAfterglow.ts'
import {
  requestApplicationPersistence,
  createWindow,
  setMainWindowAfterglowUnloading
} from './window.ts'
import {
  createAfterglowAnchorWindow,
  getAfterglowAnchorHandle,
  destroyAfterglowAnchorWindow
} from './afterglowAnchorWindow.ts'
import { rebindWindowsSmtc } from '../integrations/windowsSmtc.ts'
import { destroyDesktopLyrics, showDesktopLyrics } from '../integrations/desktopLyrics.ts'
import { destroyDynamicIsland } from '../integrations/dynamicIsland.ts'
import { destroyTrayPlayerWindow } from '../integrations/trayPlayer.ts'
import { showMiniPlayer, destroyMiniPlayerWindow } from '../integrations/miniPlayer.ts'
import { saveWindowState } from './windowState.ts'

let service: CoreAfterglow | null = null
export function getCoreAfterglowMode(): CoreAfterglow | null {
  if (!getCoreApplication()) return null
  if (service) return service
  const owned = new Set<string>()
  let miniWasOpen = false,
    lyricsWereOpen = false
  service = new CoreAfterglow({
    ready: () => getCoreApplication()?.snapshot()?.phase === 'ready',
    persistView: requestApplicationPersistence,
    registerRestore(restore) {
      let selected: string | null = null
      for (const accelerator of AFTERGLOW_RESTORE_ACCELERATORS) {
        try {
          if (
            !globalShortcut.isRegistered(accelerator) &&
            globalShortcut.register(accelerator, restore)
          ) {
            owned.add(accelerator)
            selected = accelerator
            break
          }
        } catch (error) {
          console.warn('[core.afterglow] restore shortcut unavailable', accelerator, error)
        }
      }
      for (const [key, type] of [
        ['MediaPlayPause', 'toggle-play'],
        ['MediaPreviousTrack', 'previous'],
        ['MediaNextTrack', 'next'],
        ['MediaStop', 'stop']
      ] as const) {
        if (
          !globalShortcut.isRegistered(key) &&
          globalShortcut.register(key, () => {
            void getCoreApplication()!
              .request('playback.control', { type })
              .catch((error) => console.error('[core.media-key]', error))
          })
        )
          owned.add(key)
      }
      return selected
    },
    unregisterRestore() {
      for (const key of owned) globalShortcut.unregister(key)
      owned.clear()
    },
    unload(mode) {
      const window = runtime.mainWindow
      miniWasOpen = !!runtime.miniPlayerWindow && !runtime.miniPlayerWindow.isDestroyed()
      lyricsWereOpen = !!runtime.desktopLyricsWindow && !runtime.desktopLyricsWindow.isDestroyed()
      if (window && !window.isDestroyed()) {
        const bounds = window.getNormalBounds()
        saveWindowState(join(app.getPath('userData'), 'window-state.json'), {
          width: bounds.width,
          height: bounds.height,
          maximized: window.isMaximized()
        })
      }
      createAfterglowAnchorWindow({
        showInTaskbar: mode === 'minimize',
        onRestore: () => {
          void service!.restore()
        }
      })
      rebindWindowsSmtc(getAfterglowAnchorHandle())
      destroyDesktopLyrics()
      destroyDynamicIsland()
      destroyTrayPlayerWindow()
      destroyMiniPlayerWindow()
      if (window && !window.isDestroyed()) {
        setMainWindowAfterglowUnloading(true)
        window.destroy()
      }
    },
    async restoreWindow() {
      let window = runtime.mainWindow
      if (!window || window.isDestroyed()) {
        window = createWindow()
        try {
          await windowReady(window)
        } catch (error) {
          setMainWindowAfterglowUnloading(true)
          if (!window.isDestroyed()) window.destroy()
          createAfterglowAnchorWindow({
            showInTaskbar: false,
            onRestore: () => {
              void service!.restore()
            }
          })
          rebindWindowsSmtc(getAfterglowAnchorHandle())
          throw error
        }
      }
      if (runtime.forceQuit) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      destroyAfterglowAnchorWindow()
      if (lyricsWereOpen && runtime.appSettings.desktopLyrics.enabled) showDesktopLyrics()
      if (miniWasOpen) showMiniPlayer()
      miniWasOpen = lyricsWereOpen = false
    },
    changed: () => runtime.refreshTrayMenu?.(true)
  })
  return service
}

function windowReady(window: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      window.off('ready-to-show', ready)
      window.off('closed', closed)
    }
    const ready = () => {
      cleanup()
      resolve()
    }
    const closed = () => {
      cleanup()
      reject(Error('Window closed before becoming ready'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(Error('Window restore timed out'))
    }, 15_000)
    timer.unref()
    window.once('ready-to-show', ready)
    window.once('closed', closed)
  })
}

export async function dispatchCoreAfterglowTransport(
  command: AfterglowTransportCommand
): Promise<void> {
  const core = getCoreApplication()!
  const playback = core.snapshot()?.playback
  switch (command.type) {
    case 'play':
    case 'pause':
    case 'toggle-play':
    case 'stop':
    case 'next':
    case 'previous':
    case 'cycle-play-mode':
      await core.request('playback.control', command)
      return
    case 'seek':
      await core.request('playback.seek', { position: command.positionSeconds })
      return
    case 'seek-by':
      await core.request('playback.seek', {
        position: Math.max(0, (playback?.position ?? 0) + command.deltaSeconds)
      })
      return
    case 'set-volume':
      await core.request('playback.volume', { volume: command.volume })
      return
    case 'volume-step':
      await core.request('playback.volume', {
        volume: Math.min(
          1,
          Math.max(
            0,
            (core.snapshot()?.mute?.userVolume ?? playback?.volume ?? 0.7) + command.delta
          )
        )
      })
      return
    case 'toggle-mute':
      await core.request('playback.mute', {})
      return
    case 'set-playback-rate':
      await core.request('playback.rate', {
        rate: Math.min(2, Math.max(0.5, command.playbackRate))
      })
      return
    case 'rate-step':
      await core.request('playback.rate', {
        rate: Math.min(2, Math.max(0.5, (playback?.playbackRate ?? 1) + command.delta))
      })
      return
    case 'set-play-mode':
      await core.request('playback.mode', { mode: command.mode })
      return
  }
}
