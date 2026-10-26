import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { normalizeMiniPlayerCommand } from '../../shared/miniPlayer.ts'

async function section(file: string, first: string, last?: string): Promise<string> {
  const source = await readFile(new URL(file, import.meta.url), 'utf8')
  const start = source.indexOf(first)
  assert.notEqual(start, -1)
  const end = last ? source.indexOf(last, start + first.length) : source.length
  assert.notEqual(end, -1)
  return stripTypeScriptTypes(source.slice(start, end).replaceAll('export function ', 'function '))
}

test('tray, shortcuts and SMTC dispatch directly to installed Core with no main window', async () => {
  const calls: unknown[] = []
  const core = {
    dispatch: (command: unknown) => calls.push(command),
    shortcut: (action: unknown) => calls.push(action)
  }
  const context = {
    runtime: { mainWindow: null },
    getCoreSystemPlayer: () => core,
    isAfterglowModeActive: () => {
      throw Error('Legacy owner reached')
    }
  }
  runInNewContext(
    await section(
      './shortcutsTray.ts',
      'export function sendPlayerShortcut',
      'export function handleGlobalShortcutAction'
    ),
    context
  )
  runInNewContext(
    await section(
      './shortcutsTray.ts',
      'function sendMiniPlayerCommand',
      'function formatTrayTrackTooltip'
    ),
    context
  )
  runInNewContext(
    await section(
      './trayPlayer.ts',
      'function forwardPlayerCommand',
      'function assertTrayPlayerSender'
    ),
    context
  )
  runInNewContext(await section('./windowsSmtc.ts', 'function sendPlayerCommand', '/**'), context)
  const actions = runInNewContext(
    '({sendPlayerShortcut,sendMiniPlayerCommand,forwardPlayerCommand,sendPlayerCommand})',
    context
  )
  actions.sendPlayerShortcut('next')
  actions.sendMiniPlayerCommand({ type: 'toggle-favorite' })
  actions.forwardPlayerCommand({ type: 'seek', value: 42 })
  actions.sendPlayerCommand({ type: 'pause' })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    'next',
    { type: 'toggle-favorite' },
    { type: 'seek', value: 42 },
    { type: 'pause' }
  ])
})

test('satellite command handlers keep sender gates while bypassing the missing main renderer', async () => {
  const calls: unknown[] = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const core = {
    dispatch: (command: unknown) => calls.push(command),
    shortcut: (action: unknown) => calls.push(action)
  }
  const accepted = (event: unknown) => event === 'trusted'
  const context = {
    runtime: { mainWindow: null, miniPlayerWindow: null },
    getCoreSystemPlayer: () => core,
    normalizeMiniPlayerCommand,
    shouldAcceptSenderWindow: accepted,
    shouldAcceptIpcEvent: accepted,
    isDynamicIslandSender: accepted,
    isDesktopLyricsSender: accepted,
    isMainSender: accepted,
    ipcMain: {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      handle() {}
    },
    ipcBound: false,
    resumeBound: true,
    screen: { on() {} },
    refreshForDisplayChange() {},
    console
  }
  runInNewContext(
    await section('./miniPlayer.ts', 'export function setupMiniPlayerIpc', 'function clampNumber'),
    context
  )
  runInNewContext(
    await section('./dynamicIsland.ts', 'export function setupDynamicIslandIpc'),
    context
  )
  runInNewContext(
    await section('./desktopLyrics.ts', 'export function setupDesktopLyricsIpc'),
    context
  )
  runInNewContext('setupMiniPlayerIpc();setupDynamicIslandIpc();setupDesktopLyricsIpc()', context)
  for (const name of ['miniPlayer:command', 'dynamicIsland:command']) {
    handlers.get(name)!('stranger', { type: 'next' })
    handlers.get(name)!('trusted', { type: 'invalid' })
    handlers.get(name)!('trusted', { type: 'next' })
  }
  handlers.get('desktopLyrics:transport')!('stranger', 'playPause')
  handlers.get('desktopLyrics:transport')!('trusted', 'playPause')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { type: 'next' },
    { type: 'next' },
    'playPause'
  ])
  // Legacy renderer broadcasts cannot replace the active Core's authoritative projections.
  for (const name of [
    'miniPlayer:publishState',
    'miniPlayer:publishLyrics',
    'desktopLyrics:publishSession',
    'desktopLyrics:publishClock'
  ])
    handlers.get(name)!('trusted', {})
  assert.equal('latestMiniPlayerState' in context.runtime, false)
  assert.equal('latestDesktopLyricsSession' in context.runtime, false)
})

test('Core state publisher fans out to helper windows and OS projections with no main renderer', async () => {
  const sent: string[] = []
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (name: string) => sent.push(name) }
  }
  const runtime = {
    mainWindow: null,
    miniPlayerWindow: window,
    trayPlayerWindow: window,
    refreshTrayMenu: () => sent.push('tray'),
    refreshTaskbarThumbarButtons: () => sent.push('thumbar'),
    refreshWindowsSmtc: () => sent.push('smtc')
  }
  const context = { runtime, publishDynamicIslandState: () => sent.push('island') }
  runInNewContext(
    await section(
      './miniPlayer.ts',
      'function sendMiniPlayerState',
      'function sendMiniPlayerSettings'
    ),
    context
  )
  runInNewContext('publishCoreMiniPlayerState({isPlaying:true})', context)
  assert.deepEqual(sent, [
    'island',
    'miniPlayer:state',
    'tray',
    'thumbar',
    'smtc',
    'trayPlayer:state'
  ])
  assert.equal(
    (runtime as typeof runtime & { latestMiniPlayerState: { isPlaying: boolean } })
      .latestMiniPlayerState.isPlaying,
    true
  )
})

test('Core Discord publication deduplicates identical activity and clears on pause', async () => {
  let output!: { state: (state: unknown) => void }
  const activity: unknown[] = []
  const context = {
    installCoreSystemPlayerBridge: (_transport: unknown, target: typeof output) => {
      output = target
    },
    publishCoreMiniPlayerState() {},
    publishCoreDesktopLyricsClock() {},
    updateDiscordActivity: (value: unknown) => activity.push(value),
    clearDiscordActivity: () => activity.push(null)
  }
  runInNewContext(
    await section('./coreSystemPlayer.ts', 'export function installCoreSystemPlayer'),
    context
  )
  runInNewContext('installCoreSystemPlayer({now:()=>100000})', context)
  const state = {
    track: { title: 'Song', artist: 'Artist', album: 'Album' },
    isPlaying: true,
    currentTime: 20
  }
  output.state(state)
  output.state(state)
  output.state({ ...state, isPlaying: false })
  output.state({ ...state, isPlaying: false })
  assert.deepEqual(JSON.parse(JSON.stringify(activity)), [
    { title: 'Song', artist: 'Artist', album: 'Album', playing: true, startTime: 80 },
    null
  ])
})
