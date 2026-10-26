'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const test = require('node:test')

test(
  'production entry keeps native playback across zero windows and reconnects without replay',
  {
    timeout: 180_000
  },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-production-'))
    try {
      const runner = join(directory, 'runner.cjs')
      await writeFile(runner, fixture)
      const env = { ...process.env, TWILIGHT_DEV_USER_DATA_DIR: join(directory, 'profile') }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      for (const phase of ['first', 'cold']) {
        const run = promisify(execFile)(require('electron'), [runner, root, phase], {
          env,
          windowsHide: true,
          timeout: 85_000,
          maxBuffer: 4 * 1024 * 1024
        })
        run.child.stdout?.on('data', (data) => process.stdout.write(data))
        run.child.stderr?.on('data', (data) => process.stderr.write(data))
        await run
      }
      const result = JSON.parse(await readFile(join(directory, 'first.json'), 'utf8'))
      const cold = JSON.parse(await readFile(join(directory, 'cold.json'), 'utf8'))
      assert.equal(result.rebuilds, 2)
      assert.equal(result.coreProcesses, 1)
      assert.equal(result.zeroWindowPlayback, true)
      assert.equal(result.replayedTransport, 0)
      assert.equal(result.rendererCommandsOnRebuild, 0)
      assert.equal(result.migrationCommits, 1)
      assert.equal(cold.migrationCommits, 0)
      assert.equal(cold.state, 'paused')
      assert.equal(cold.occurrenceId, result.occurrenceId)
      assert.ok(Math.abs(cold.position - result.position) < 1)
      assert.deepEqual(cold.transportMethods, [])
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-production-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain, dialog } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const root = process.argv[2], phase = process.argv[3], profile = join(__dirname, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
// Only launch metadata is supplied by the harness; production owns every service and window.
app.getAppPath = () => root
app.disableHardwareAcceleration()
const music = join(profile, 'music')
mkdirSync(music, { recursive: true })
if (phase === 'first') {
  const dataSize = 8000 * 2 * 180, wave = Buffer.alloc(44 + dataSize)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28)
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
  wave.write('data', 36); wave.writeUInt32LE(dataSize, 40)
  writeFileSync(join(music, 'silence.wav'), wave)
  writeFileSync(join(profile, 'music-library.json'), JSON.stringify({
    version: 2, revision: 0, folders: [music], exclusions: [], tracks: [{
      id: 'production-silence', title: 'Production silence', artist: 'Core integration',
      album: 'Renderer lifecycle', duration: 180, filePath: join(music, 'silence.wav'), source: 'local'
    }]
  }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    onboardingCompleted: true, libraryFolders: [music], launchAtLogin: false,
    playbackResumeMode: 'trackAndPosition', onlineLyricsFallback: false,
    closeWindowBehavior: 'tray', autoCheckUpdate: false, smtcEnabled: false,
    audioProcessing: { loudnormEnabled: false }
  }))
}
const children = new Set(), transportMethods = [], commands = [], pending = new Map()
const failures = [], rendererErrors = [], relays = []
let core, epoch, snapshot, coreProcesses = 0, requestSerial = 0
const identity = { id: 'production-acceptance', role: 'desktop', permissions: [
  'playback:read', 'playback:write', 'library:read', 'library:write',
  'statistics:read', 'settings:read', 'migration:write'
] }
const fork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (entry, args, options) => {
  const child = fork(entry, args, options)
  children.add(child)
  child.once('exit', () => children.delete(child))
  const send = child.postMessage.bind(child)
  child.postMessage = (message, ports) => {
    if (options?.serviceName === 'twilight-core') {
      if (message.kind === 'core:initialize') epoch = message.configuration.epoch
      if (message.kind === 'core:request' && message.request.kind === 'command')
        commands.push({ clientId: message.clientId, name: message.request.name })
    }
    // A test-only tee records actual native RPCs; neither endpoint is simulated.
    if (options?.serviceName === 'twilight-audio' && message.kind === 'core:attach-service') {
      const original = ports[0], { port1, port2 } = new MessageChannelMain()
      original.on('message', ({ data }) => {
        if (data.kind === 'request' && ['Play', 'Seek', 'LoadQueue'].includes(data.method))
          transportMethods.push(data.method)
        port1.postMessage(data)
      })
      port1.on('message', ({ data }) => original.postMessage(data))
      original.start(); port1.start(); relays.push(original, port1)
      return send(message, [port2])
    }
    return send(message, ports)
  }
  if (options?.serviceName === 'twilight-core') {
    core = child; coreProcesses++
    child.on('message', message => {
      if (message.kind === 'core:initialized') child.postMessage({ kind: 'core:connect', identity })
      if (message.kind === 'core:fatal') failures.push(message.error)
      if (message.kind !== 'core:client-message' || message.clientId !== identity.id) return
      const item = message.message
      if (item.kind === 'state') snapshot = item.snapshot
      if (item.kind === 'response') {
        const job = pending.get(item.requestId)
        if (!job) return
        pending.delete(item.requestId); clearTimeout(job.timer)
        item.ok ? job.resolve(item.value) : job.reject(Object.assign(Error(item.error.message), item.error))
      }
    })
  }
  return child
}
dialog.showErrorBox = (title, content) => { console.error(title, content); app.exit(1) }
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _path, error) => failures.push(error.stack))
  contents.on('console-message', (_event, details) => {
    if (details.level === 'error') { rendererErrors.push(details.message); console.error('[renderer]', details.message) }
  })
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label) {
  for (let i = 0; i < 600; i++) {
    assert.deepEqual(failures, [], label)
    const value = await read()
    if (value) return value
    await pause(50)
  }
  throw Error('Timed out: ' + label + '\n' + rendererErrors.join('\n'))
}
function request(kind, name, payload = {}) {
  const requestId = 'acceptance-' + ++requestSerial
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Timed out: ' + name)) }, 15000)
    pending.set(requestId, { resolve, reject, timer })
    core.postMessage({ kind: 'core:request', clientId: identity.id, request: { kind, name, payload, requestId, epoch } })
  })
}
async function mountedWindow() {
  const win = await until(() => BrowserWindow.getAllWindows().find(item =>
    item.webContents.getURL().includes('index.html') && !item.webContents.getURL().includes('window=')), 'main window')
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript(
    "Boolean(document.getElementById('app')?.__vue_app__)"), 'production Vue mount')
  return win
}
async function main() {
  require(join(root, 'out', 'main', 'index.js'))
  await app.whenReady()
  let win = await mountedWindow()
  await until(() => snapshot?.phase === 'ready' && !snapshot.migrationRequired, 'Core ready after normal-window migration')
  assert.equal((await request('query', 'migration.status')).complete, true)
  if (phase === 'cold') {
    const state = await request('query', 'state.snapshot')
    writeFileSync(join(__dirname, 'cold.json'), JSON.stringify({
      state: state.playback.state, occurrenceId: state.queue.occurrenceId, position: state.playback.position,
      migrationCommits: commands.filter(row => row.name === 'migration.commit').length, transportMethods
    }))
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit(); return
  }
  const page = await request('query', 'library.tracks', { limit: 10 })
  assert.equal(page.total, 1)
  const staged = await request('command', 'queue.submit', { kind: 'begin', selectedIndex: 0, play: true })
  await request('command', 'queue.submit', { kind: 'append', id: staged.id, sequence: 1, items: [
    { kind: 'local', id: page.tracks[0].id }, { kind: 'local', id: page.tracks[0].id }
  ] })
  await request('command', 'queue.submit', { kind: 'commit', id: staged.id, sequence: 2 })
  await until(() => snapshot?.playback?.state === 'playing' && snapshot.playback.position > 0.2, 'native silence playback')
  const occurrenceId = snapshot.queue.occurrenceId, originalEpoch = snapshot.epoch
  const transportCount = transportMethods.length
  let rendererCommandsOnRebuild = 0
  for (let rebuild = 0; rebuild < 2; rebuild++) {
    const before = await request('query', 'state.snapshot')
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    await pause(rebuild === 0 ? 5500 : 500)
    const headless = await request('query', 'state.snapshot')
    assert.equal(headless.epoch, originalEpoch)
    assert.equal(headless.queue.occurrenceId, occurrenceId)
    assert.equal(headless.playback.state, 'playing')
    assert.ok(headless.playback.position > before.playback.position)
    assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 1)
    await request('query', 'statistics.summary')
    await request('query', 'player.lyrics')
    const commandCount = commands.length
    app.emit(rebuild === 0 ? 'activate' : 'second-instance')
    win = await mountedWindow()
    await pause(300)
    rendererCommandsOnRebuild += commands.slice(commandCount).filter(row =>
      row.name.startsWith('playback.') || row.name.startsWith('queue.')).length
    const reattached = await request('query', 'state.snapshot')
    assert.equal(reattached.epoch, originalEpoch)
    assert.equal(reattached.queue.occurrenceId, occurrenceId)
    assert.equal(reattached.playback.state, 'playing')
  }
  const replayedTransport = transportMethods.length - transportCount
  await request('command', 'playback.pause')
  const final = await request('query', 'state.snapshot')
  const statistics = await request('query', 'statistics.tracks', { limit: 10 })
  assert.equal(statistics.total, 1)
  assert.equal(statistics.items[0].plays, 1)
  win.show()
  await pause(500)
  writeFileSync(join(root, '.core-production-render.png'), (await win.webContents.capturePage()).toPNG())
  writeFileSync(join(__dirname, 'first.json'), JSON.stringify({
    rebuilds: 2, coreProcesses, zeroWindowPlayback: true, replayedTransport, rendererCommandsOnRebuild,
    migrationCommits: commands.filter(row => row.name === 'migration.commit').length,
    occurrenceId, position: final.playback.position
  }))
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.quit()
}
main().catch(error => {
  console.error(error.stack || error)
  app.exit(1)
})
`
