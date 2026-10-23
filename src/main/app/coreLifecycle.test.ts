import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('the production entry starts the independent Core owner', async () => {
  const entry = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
  assert.match(entry, /import \{ startCoreApp \} from '\.\/app\/lifecycle'/)
  assert.match(entry, /\bstartCoreApp\(\)/)
  assert.doesNotMatch(entry, /\bstartApp\(\)/)
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function fixture() {
  const source = await readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8')
  const events: string[] = []
  const startup = deferred(),
    navigation = deferred(),
    checkpoint = deferred()
  let installed = false,
    quitAllowed = false
  const core = {
    start: () => {
      events.push('core:start')
      return startup.promise
    },
    shutdown: async () => {
      events.push('core:shutdown')
      await checkpoint.promise
      events.push('core:saved')
    }
  }
  const runtime = {
    appSettings: { hardwareAcceleration: true, libraryFolders: [], closeToTray: false },
    launchSettings: {},
    mainWindow: null as any,
    miniPlayerWindow: null,
    forceQuit: false,
    closingAfterPlaybackSessionSave: false
  }
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    requestSingleInstanceLock: () => true,
    getPath: () => 'temporary-test-profile',
    commandLine: { appendSwitch() {} },
    isReady: () => true,
    whenReady: async () => {},
    quit: () => {
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true
        }
      }
      app.emit('before-quit', event)
      if (!event.prevented) {
        events.push('app:quit')
        quitAllowed = true
      }
    }
  })
  const context: Record<string, any> = {
    runtime,
    app,
    process: { platform: 'win32', env: {} },
    electronApp: { setAppUserModelId() {} },
    WINDOWS_APP_USER_MODEL_ID: 'test',
    readAppSettings: () => runtime.appSettings,
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    warmWindowsAcrylicBackdropAvailability: async () => {},
    ensureWindowsShellIdentity: () => ({ ok: true }),
    initializeLocalPathGrants: async () => {},
    createCoreApplication: () => {
      installed = true
      return core
    },
    getCoreApplication: () => (installed ? core : null),
    createMainWindowAndScheduleDeferredStartup: () => {
      events.push('window:create')
    },
    createWindow: () => {
      events.push('window:recreate')
      runtime.mainWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        show() {},
        focus() {}
      }
      return runtime.mainWindow
    },
    isAfterglowModeActive: () => false,
    BrowserWindow: { getAllWindows: () => [{ auxiliary: true }] },
    requestRendererPlaybackSessionSave: async () => {
      events.push('navigation:save')
      await navigation.promise
    },
    dialog: {
      showErrorBox: (_title: string, error: string) => {
        throw Error(error)
      }
    },
    console,
    setTimeout,
    // The shell adapter creates no music owners. These calls register platform IPC only.
    installElectronSecurity() {},
    installExperienceProtocol() {},
    createRemoteMediaRequestHandler: () => () => {},
    mediaCoverCache: {},
    optimizer: { watchWindowShortcuts() {} }
  }
  for (const name of [
    'setupCoreShellIpc',
    'setupThemeIpc',
    'setupDesktopLyricsIpc',
    'setupMiniPlayerIpc',
    'setupDynamicIslandIpc',
    'setupTrayPlayerIpc',
    'setupWindowsSmtcIpc',
    'initializeTelemetry',
    'destroyDesktopLyrics',
    'destroyDynamicIsland',
    'destroyTrayPlayerWindow',
    'destroyMiniPlayerWindow',
    'shutdownAfterglowMode',
    'stopAppUpdateChecks',
    'destroyWindowsSmtc',
    'unregisterPlayerShortcuts',
    'destroyTray',
    'destroyTelemetry'
  ])
    context[name] = () => {
      events.push(name)
    }
  runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf('function startDesktopApp'),
        source.indexOf('async function initializeDatabaseLibrary')
      )
    ),
    context
  )
  context.startDesktopApp('core')
  await turn()
  return {
    app,
    runtime,
    events,
    startup,
    navigation,
    checkpoint,
    get quitAllowed() {
      return quitAllowed
    }
  }
}

test('Core starts before a normal migration window without awaiting renderer-supplied migration', async () => {
  const f = await fixture()
  assert.ok(f.events.indexOf('core:start') < f.events.indexOf('window:create'))
  assert.ok(f.events.includes('setupCoreShellIpc'))
  assert.equal(f.events.includes('core:shutdown'), false)
  f.app.emit('window-all-closed')
  assert.equal(f.quitAllowed, false)
  assert.equal(f.events.includes('core:shutdown'), false)
})

test('second instance and activate rebuild the missing main window even when auxiliary windows remain', async () => {
  const f = await fixture()
  f.app.emit('second-instance')
  assert.equal(f.events.filter((value) => value === 'window:recreate').length, 1)
  f.runtime.mainWindow = null
  f.app.emit('activate')
  assert.equal(f.events.filter((value) => value === 'window:recreate').length, 2)
  assert.equal(
    f.events.some((value) => /^(playback:|seek:|queue:|core:shutdown)/.test(value)),
    false
  )
})

test('explicit quit destroys satellite windows, saves navigation and waits for final Core ACK once', async () => {
  const f = await fixture()
  f.app.quit()
  f.app.quit()
  await turn()
  assert.equal(f.quitAllowed, false)
  assert.equal(f.events.filter((value) => value === 'navigation:save').length, 1)
  assert.equal(f.events.includes('core:shutdown'), false)
  assert.ok(f.events.indexOf('destroyMiniPlayerWindow') < f.events.indexOf('navigation:save'))
  f.navigation.resolve()
  await turn()
  assert.equal(f.events.filter((value) => value === 'core:shutdown').length, 1)
  assert.equal(f.quitAllowed, false)
  f.checkpoint.resolve()
  await turn()
  assert.equal(f.quitAllowed, true)
  assert.equal(f.runtime.closingAfterPlaybackSessionSave, true)
  assert.ok(f.events.indexOf('core:saved') < f.events.indexOf('app:quit'))
  f.app.emit('will-quit')
  assert.ok(f.events.includes('destroyTelemetry'))
})

test('window close preferences still distinguish tray/mini hiding from explicit application quit', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const win = Object.assign(new EventEmitter(), {
    getNormalBounds: () => ({ width: 900, height: 600 }),
    isMaximized: () => false,
    hide: () => {
      hidden++
    }
  })
  let quit = 0,
    hidden = 0,
    mini = 0
  const runtime = {
    mainWindow: win,
    forceQuit: false,
    appSettings: { closeWindowBehavior: 'quit' }
  }
  const context = {
    runtime,
    console,
    windowStatePath: 'test-window-state',
    saveWindowState() {},
    getCoreApplication: () => ({}),
    app: {
      quit: () => {
        quit++
      }
    },
    showMiniPlayer: () => {
      mini++
    }
  }
  runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf("  runtime.mainWindow.on('close'"),
        source.indexOf("  runtime.mainWindow.on('closed'")
      )
    ),
    context
  )
  let prevented = 0
  const event = {
    preventDefault: () => {
      prevented++
    }
  }
  win.emit('close', event)
  assert.equal(quit, 1)
  runtime.appSettings.closeWindowBehavior = 'miniPlayer'
  win.emit('close', event)
  assert.equal(mini, 1)
  assert.equal(quit, 1)
  assert.equal(hidden, 0)
  assert.equal(prevented, 2)
})

test('unexpected main renderer destruction preserves Core and rebinds SMTC to a renderer-free anchor', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const win = new EventEmitter()
  const events: string[] = []
  const runtime = { mainWindow: win as EventEmitter | null, forceQuit: false }
  runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf("  runtime.mainWindow.on('closed'"),
        source.indexOf('  if (!getCoreApplication()) installAudioDeviceHotplugWatcher')
      )
    ),
    {
      runtime,
      afterglowUnloading: false,
      getCoreApplication: () => ({}),
      destroyTaskbarThumbarButtons: () => events.push('thumbar:destroy'),
      createAfterglowAnchorWindow: () => events.push('anchor:create'),
      getAfterglowAnchorHandle: () => Buffer.alloc(8),
      rebindWindowsSmtc: () => events.push('smtc:rebind'),
      destroyWindowsSmtc: () => events.push('smtc:destroy')
    }
  )
  win.emit('closed')
  assert.equal(runtime.mainWindow, null)
  assert.deepEqual(events, ['thumbar:destroy', 'anchor:create', 'smtc:rebind'])
})
