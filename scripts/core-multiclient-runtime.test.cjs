'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real Core serializes desktop, mini-player and paired HTTP edits and cancels a detached client',
  { timeout: 90_000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-multiclient-'))
    try {
      await mkdir(join(directory, 'renderer'))
      await writeFile(
        join(directory, 'renderer', 'index.html'),
        '<!doctype html><html><body><script src="./renderer.js"></script></body></html>'
      )
      const build = (contents, outfile, platform) =>
        buildSync({
          stdin: { contents, resolveDir: root },
          bundle: true,
          platform,
          format: platform === 'browser' ? 'iife' : 'cjs',
          external: ['electron'],
          define: {
            'import.meta.hot': 'undefined',
            'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'package.json')).href)
          },
          outfile
        })
      build(
        `const {contextBridge}=require('electron'); const {coreApi}=require('./src/preload/domains/coreApi.ts'); contextBridge.exposeInMainWorld('api',{core:coreApi})`,
        join(directory, 'preload.cjs'),
        'node'
      )
      build(
        `import {createCoreConnectionStore} from './src/renderer/src/stores/coreConnection.ts'; window.store=createCoreConnectionStore(window.api.core)`,
        join(directory, 'renderer', 'renderer.js'),
        'browser'
      )
      build(fixture, join(directory, 'runner.cjs'), 'node')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const execution = promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), root],
        {
          env,
          windowsHide: true,
          timeout: 80_000,
          maxBuffer: 3 * 1024 * 1024
        }
      )
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      await execution
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.deepEqual(result, {
        realCore: true,
        remoteInitiallyDisabled: true,
        unpairedRejected: true,
        editsSucceeded: 1,
        concurrentEditsRejected: 2,
        staleRevisionRejected: true,
        synchronizedClients: 3,
        undoPreservedOccurrences: true,
        cancelledPlatformRequests: 1,
        disconnectedWriteOutcome: 'OUTCOME_UNKNOWN',
        insertCommands: 1,
        reattachedWithoutReplay: true,
        zeroWindowRemote: true,
        unexpectedTransport: [],
        servicesAfterShutdown: 0
      })
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-multiclient-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain, ipcMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { CoreWindowBridge, CORE_WINDOW_POLICIES } = require('./src/main/coreProcess/windowBridge.ts')
const { isTrustedIpcSenderUrl } = require('./src/main/security/electronSecurity.ts')
const { CoreStateDatabase } = require('./src/main/library/coreStateDatabase.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile')
mkdirSync(profile)
app.setPath('userData', profile); app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const alive = new Set(), relays = [], commands = [], transport = [], windows = []
let supervisor, bridge, authorizationEntered = false, cancelledPlatformRequests = 0
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label) {
  for (let i = 0; i < 500; i++) {
    const value = await read()
    if (value) return value
    await wait(10)
  }
  throw Error('Timed out: ' + label)
}
const execute = (window, expression) => window.webContents.executeJavaScript(expression)
const command = (window, name, payload = {}) => execute(window,
  'window.store.command(' + JSON.stringify(name) + ',' + JSON.stringify(payload) + ')')
const query = (window, name, payload = {}) => execute(window,
  'window.store.query(' + JSON.stringify(name) + ',' + JSON.stringify(payload) + ')')
const snapshot = window => execute(window, 'JSON.parse(JSON.stringify(window.store.state.value))')
const queuePage = async window => {
  const { queue } = await snapshot(window)
  return query(window, 'queue.page', { id: queue.id, revision: queue.revision, offset: 0, limit: 200 })
}
async function open(policy, name) {
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false
  } })
  windows.push(window)
  bridge.register(window.webContents, policy)
  await window.loadFile(join(__dirname, 'renderer', 'index.html'), { query: { window: name } })
  await execute(window, 'window.store.attach()')
  return window
}
async function main() {
  await app.whenReady()
  const music = join(profile, 'music'); mkdirSync(music)
  const wave = Buffer.alloc(44 + 16000)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28)
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
  wave.write('data', 36); wave.writeUInt32LE(16000, 40)
  const tracks = ['one', 'two', 'three'].map(id => {
    const filePath = join(music, id + '.wav'); writeFileSync(filePath, wave)
    return { id, filePath, title: id, artist: 'Core multiclient', album: 'Finite clients', duration: 1, source: 'local' }
  })
  const slowFile = join(music, 'cancelled.wav'); writeFileSync(slowFile, wave)
  const allowed = new Set([...tracks.map(track => track.filePath), slowFile])
  writeFileSync(join(profile, 'music-library.json'), JSON.stringify({
    version: 2, revision: 0, folders: [], exclusions: [], tracks
  }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    watchLibrary: false, libraryFolders: [], onlineLyricsFallback: false,
    remoteControlEnabled: false, remoteControlPort: 0, audioProcessing: { loudnormEnabled: false }
  }))
  const state = new CoreStateDatabase(join(profile, 'core-state.sqlite'))
  state.begin('multiclient-profile', { version: 1, counts: emptyCoreStateCounts() })
  state.commit('multiclient-profile'); state.close()
  supervisor = new CoreSupervisor({
    configuration: {
      root: profile, libraryFilePath: join(profile, 'music-library.json'), coverCacheDir: join(profile, 'covers'),
      libraryStorage: 'sqlite', resumeMode: 'off', remoteStaticRoot: join(root, 'resources', 'remote')
    },
    entries: Object.fromEntries(Object.entries({
      core: 'musicCore', audio: 'audioEngineService', 'audio-test': 'audioEngineService',
      database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService'
    }).map(([kind, file]) => [kind, join(root, 'out/main', file + '.js')])),
    platform: {
      ...createDspCorePlatform(),
      'downloads.authorizedRoots': async ({ libraryFolders }) => ({ libraryRoots: libraryFolders, downloadRoot: null }),
      'paths.areAudioFilesAuthorized': async ({ paths }) => paths.map(path => allowed.has(path)),
      'paths.authorizeAudio': async ({ source }) => { assert.ok(allowed.has(source)); return source },
      'paths.authorizeAudioFile': async ({ path }, signal) => {
        assert.ok(allowed.has(path), path)
        if (path === slowFile) {
          authorizationEntered = true
          await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              cancelledPlatformRequests++
              reject(signal.reason)
            }, { once: true })
          })
        }
        return path
      },
      'artwork.normalizeCachedCover': async ({ handle }) => handle,
      'artwork.remotePreview': async () => null,
      'artwork.present': async () => ({ cover: null, coverSource: null })
    },
    fork(entry, args, serviceName) {
      const child = utilityProcess.fork(entry, args, { serviceName, stdio: 'pipe' })
      alive.add(child); child.once('exit', () => alive.delete(child))
      child.stdout?.on('data', data => process.stdout.write(data))
      child.stderr?.on('data', data => process.stderr.write(data))
      const send = child.postMessage.bind(child)
      child.postMessage = (message, ports = []) => {
        if (serviceName === 'twilight-core' && message.kind === 'core:request' && message.request.kind === 'command')
          commands.push(message.request.name)
        // Observe real audio RPCs without replacing either endpoint.
        if (serviceName === 'twilight-audio' && message.kind === 'core:attach-service') {
          const original = ports[0], { port1, port2 } = new MessageChannelMain()
          original.on('message', ({ data }) => {
            if (data.kind === 'request' && ['Play', 'Seek', 'LoadQueue'].includes(data.method)) transport.push(data.method)
            port1.postMessage(data)
          })
          port1.on('message', ({ data }) => original.postMessage(data))
          original.start(); port1.start(); relays.push(original, port1)
          return send(message, [port2])
        }
        return send(message, ports)
      }
      return child
    },
    channel: () => new MessageChannelMain()
  })
  supervisor.on('failure', error => console.error('[multiclient] Core failure', error))
  await supervisor.start()
  bridge = new CoreWindowBridge({ supervisor, ipc: ipcMain, trustedUrl: isTrustedIpcSenderUrl })
  const desktop = await open(CORE_WINDOW_POLICIES.desktop, 'main')
  const mini = await open(CORE_WINDOW_POLICIES.playback, 'mini')
  assert.equal((await snapshot(desktop)).migrationRequired, false)
  const initialRemote = await query(desktop, 'remote.status')
  assert.equal(initialRemote.enabled, false); assert.equal(initialRemote.running, false)
  const remote = await command(desktop, 'remote.setEnabled', { enabled: true })
  assert.equal(remote.running, true); assert.ok(remote.port > 0)
  const base = 'http://127.0.0.1:' + remote.port
  const unauthorized = await fetch(base + '/api/browse?view=queue&offset=0&limit=40')
  assert.equal(unauthorized.status, 401)
  const pair = await fetch(base + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: remote.pin }) })
  assert.equal(pair.status, 200)
  const { token } = await pair.json()
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
  const remoteState = async () => (await fetch(base + '/api/state', { headers })).json()
  const remoteQueue = async () => (await fetch(base + '/api/browse?view=queue&offset=0&limit=40', { headers })).json()
  const submission = await command(desktop, 'queue.submit', { kind: 'begin', selectedIndex: 0, play: false })
  await command(desktop, 'queue.submit', { kind: 'append', id: submission.id, sequence: 1, items: tracks.map(track => ({ kind: 'local', id: track.id })) })
  await command(desktop, 'queue.submit', { kind: 'commit', id: submission.id, sequence: 2 })
  const initial = await snapshot(desktop), queue = initial.queue
  const original = await queuePage(desktop)
  assert.equal(queue.total, 3)
  const occurrenceIds = original.items.map(item => item.queueEntryId)
  const currentOccurrence = queue.occurrenceId
  const converged = async expected => until(async () => {
    const [mainState, miniState, httpState] = await Promise.all([snapshot(desktop), snapshot(mini), remoteState()])
    return mainState.queue?.revision === expected.revision && miniState.queue?.revision === expected.revision &&
      httpState.queueRevision === expected.revision && mainState.queue.total === expected.total &&
      miniState.queue.total === expected.total && httpState.queueLength === expected.total
  }, 'desktop / mini / HTTP projections converge')
  await converged(queue)
  const edit = { id: queue.id, revision: queue.revision, edit: { kind: 'remove', entryIds: [occurrenceIds[1]] } }
  const windowEdit = window => execute(window, 'window.store.command("queue.edit",' + JSON.stringify(edit) + ').then(()=>"ok",error=>error.code)')
  const results = await Promise.all([
    windowEdit(desktop), windowEdit(mini),
    fetch(base + '/api/command', { method: 'POST', headers, body: JSON.stringify({ action: 'removeQueue', index: 1, revision: queue.revision }) }).then(async response => {
      if (response.status === 200) return 'ok'
      const body = await response.json()
      return response.status === 409 && body.error === 'queue_changed' ? 'STALE_REVISION' : 'HTTP:' + response.status + ':' + body.error
    })
  ])
  console.log('[multiclient] concurrent results', JSON.stringify(results))
  assert.equal(results.filter(result => result === 'ok').length, 1)
  assert.equal(results.filter(result => ['STALE_REVISION', 'CANCELLED'].includes(result)).length, 2)
  const changed = await until(async () => {
    const value = (await snapshot(desktop)).queue
    return value?.total === 2 ? value : null
  }, 'race result reaches desktop')
  assert.equal(changed.revision, queue.revision + 1)
  assert.equal(changed.total, 2); assert.equal(changed.occurrenceId, currentOccurrence)
  await converged(changed)
  assert.equal(await windowEdit(desktop), 'STALE_REVISION')
  await command(mini, 'queue.undo', { id: changed.id, revision: changed.revision })
  const restored = await until(async () => {
    const value = (await snapshot(desktop)).queue
    return value?.total === 3 && value.revision !== changed.revision ? value : null
  }, 'undo result reaches desktop')
  assert.equal(restored.revision, changed.revision + 1)
  await converged(restored)
  assert.equal(restored.occurrenceId, currentOccurrence)
  assert.deepEqual((await queuePage(desktop)).items.map(item => item.queueEntryId), occurrenceIds)
  assert.deepEqual((await remoteQueue()).items.map(item => item.id), occurrenceIds)

  const insert = { id: restored.id, revision: restored.revision, items: [{
    kind: 'local', id: 'temporary:cancelled', fallback: {
      filePath: slowFile, title: 'Cancelled', artist: 'Fixture', album: 'Fixture', duration: 1
    }
  }] }
  await execute(desktop, 'window.pendingWrite=window.store.command("queue.insert",' + JSON.stringify(insert) + ').then(()=>"committed",error=>error.code); true')
  await until(() => authorizationEntered, 'real Core reaches finite platform authorization')
  await execute(desktop, 'window.store.dispose(); true')
  const disconnectedWriteOutcome = await execute(desktop, 'window.pendingWrite')
  assert.equal(disconnectedWriteOutcome, 'OUTCOME_UNKNOWN')
  await until(() => cancelledPlatformRequests === 1, 'disconnect aborts Core platform work')
  const beforeReattach = commands.length, beforeTransport = transport.length
  const loaded = new Promise(resolve => desktop.webContents.once('did-finish-load', resolve))
  desktop.reload()
  await loaded
  await execute(desktop, 'window.store.attach()')
  const reattached = await snapshot(desktop)
  assert.equal(reattached.queue.revision, restored.revision)
  assert.equal(reattached.queue.occurrenceId, currentOccurrence)
  assert.deepEqual((await queuePage(desktop)).items.map(item => item.queueEntryId), occurrenceIds)
  assert.equal(commands.length, beforeReattach)
  assert.equal(transport.length, beforeTransport)
  assert.equal(commands.filter(name => name === 'queue.insert').length, 1)
  assert.notEqual(reattached.playback?.state, 'playing')
  desktop.destroy(); mini.destroy()
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  const headlessState = await remoteState(), headlessQueue = await remoteQueue()
  assert.equal(headlessState.queueRevision, restored.revision)
  assert.deepEqual(headlessQueue.items.map(item => item.id), occurrenceIds)
  assert.notEqual(headlessState.state, 'playing')
  bridge.dispose(); bridge = null
  await supervisor.shutdown()
  await until(() => alive.size === 0, 'all real utility processes exit')
  for (const port of relays) port.close()
  assert.deepEqual(transport, [])
  const result = {
    realCore: true, remoteInitiallyDisabled: true, unpairedRejected: true,
    editsSucceeded: 1, concurrentEditsRejected: 2, staleRevisionRejected: true, synchronizedClients: 3,
    undoPreservedOccurrences: true, cancelledPlatformRequests, disconnectedWriteOutcome,
    insertCommands: commands.filter(name => name === 'queue.insert').length,
    reattachedWithoutReplay: true, zeroWindowRemote: true,
    unexpectedTransport: transport, servicesAfterShutdown: alive.size
  }
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify(result))
  console.log('[multiclient]', JSON.stringify(result))
  app.exit(0)
}
main().catch(async error => {
  console.error(error)
  for (const window of windows) if (!window.isDestroyed()) window.destroy()
  bridge?.dispose()
  try { await supervisor?.shutdown() } catch (cause) { console.error(cause) }
  for (const child of alive) child.kill()
  for (const port of relays) port.close()
  app.exit(1)
})
`
