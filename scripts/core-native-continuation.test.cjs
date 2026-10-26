'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real zero-window Core naturally continues native mixed/CUE sources, refills recommendations and survives audio/Core loss silently',
  { timeout: 160_000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-native-continuation-'))
    try {
      const runner = join(directory, 'runner.cjs')
      buildSync({
        stdin: {
          contents: `const pluginSource = ${JSON.stringify(provider)};\n${fixture}`,
          resolveDir: root
        },
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        define: {
          'import.meta.url': JSON.stringify(
            require('node:url').pathToFileURL(join(root, 'package.json')).href
          )
        },
        banner: { js: `module.paths.unshift(${JSON.stringify(join(root, 'node_modules'))});` },
        outfile: runner
      })
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const execution = promisify(execFile)(require('electron'), [runner, root], {
        env,
        windowsHide: true,
        timeout: 145_000,
        maxBuffer: 4 * 1024 * 1024
      })
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      await execution
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.equal(result.windows, 0)
      assert.deepEqual(result.mixedIds, ['cue:first', 'cue:second', 'local', 'ncm:77'])
      assert.equal(result.mixedOccurrences, 4)
      assert.equal(result.expiredUrlOpened, false)
      assert.equal(result.forcedRefresh, true)
      assert.equal(result.fmObservedRefill, true)
      assert.equal(result.heartObservedRefill, true)
      assert.equal(result.pauseLateTransport, 0)
      assert.equal(result.stopLateTransport, 0)
      assert.equal(result.audioRecoveredPaused, true)
      assert.equal(result.audioRestartPlayCalls, 0)
      assert.equal(result.coreRecoveredPaused, true)
      assert.equal(result.coreRestartPlayCalls, 0)
      assert.equal(result.confirmedStopBeforeRestart, true)
      assert.equal(result.servicesAfterShutdown, 0)
      process.stdout.write('CORE_NATIVE_CONTINUATION_RESULT ' + JSON.stringify(result) + '\n')
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-native-continuation-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const provider = String.raw`
export async function activate({ settings, twilight }) {
  const origin = await settings.get('origin')
  const facts = { fmCalls: 0, heartCalls: 0, resolutions: [], slowStarted: [], slowCancelled: [] }
  const track = (id, title) => ({ id: 'ncm:' + id, source: 'ncm', ncmSongId: id, title, artist: 'Native continuation', album: 'Fixture', duration: 1.6 })
  await twilight.providers.register({
    id: 'ncm', name: 'Native continuation fixture',
    capabilities: ['playbackUrl', 'login', 'library', 'playlist'],
    async getProfile() { return JSON.parse(JSON.stringify(facts)) },
    async getPlaybackUrl(item, options, invocation) {
      facts.resolutions.push({ id: item.id, force: options.force === true })
      if (item.ncmSongId === 9001 || item.ncmSongId === 9002) {
        facts.slowStarted.push(item.ncmSongId)
        invocation.signal.addEventListener('abort', () => facts.slowCancelled.push(item.ncmSongId), { once: true })
        // Deliberately finish after cancellation: neither Core nor native may adopt this reply.
        await new Promise(resolve => setTimeout(resolve, 1200))
      }
      if (item.ncmSongId === 77 && !options.force)
        return { streamUrl: origin + '/expired.wav', providerSource: { expiresAt: Date.now() - 1000 } }
      return { streamUrl: origin + '/provider.wav?id=' + item.ncmSongId, providerSource: { expiresAt: Date.now() + 60000 } }
    },
    async fetchPersonalFm() {
      const batch = facts.fmCalls++
      return [1, 2, 3, 4].map(index => track(1000 + batch * 4 + index, 'FM ' + (batch * 4 + index)))
    },
    async fetchUserLibrary() { return { likedPlaylist: { id: 123 } } },
    async fetchLikedTracksPage() {
      return { tracks: [1, 2, 3, 4].map(index => track(2000 + index, 'Liked ' + index)), hasMore: false, nextOffset: 4 }
    },
    async fetchIntelligenceList(seed) {
      if (seed.playlistId !== 123 || seed.count !== 20) throw Error('Invalid heart context')
      const batch = facts.heartCalls++
      return [1, 2, 3, 4].map(index => track(3000 + batch * 4 + index, 'Heart ' + (batch * 4 + index)))
    }
  })
}
`

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { createPluginManagerPlatform } = require('./src/main/plugins/platform.ts')
const { protectJsonValue, unprotectJsonValue } = require('./src/main/security/secureStorage.ts')
const { remoteMediaGrants } = require('./src/main/security/remoteMediaGrants.ts')
const { createServer } = require('node:http')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile')
mkdirSync(profile)
app.setPath('userData', profile); app.disableHardwareAcceleration()
const children = [], alive = new Set(), relays = [], transport = [], nativeSamples = [], events = []
let supervisor, server, serial = 0, lastSnapshot, stageName = 'initializing'
const identity = { id: 'continuation:desktop', role: 'desktop', permissions: ['playback:read', 'playback:write', 'library:read', 'migration:write', 'settings:read', 'settings:write', 'plugins:read', 'providers:call'] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const record = (kind, value = {}) => { const row = { order: events.length, kind, ...value }; events.push(row); return row }
const stage = name => { stageName = name; console.log('[native-continuation]', name) }
const count = method => transport.filter(row => row.method === method).length
const transportCount = () => transport.filter(row => ['Play', 'LoadQueue', 'Seek'].includes(row.method)).length
const live = name => children.filter(row => row.name === name && alive.has(row.child)).at(-1)
function request(kind, name, payload = {}) {
  return supervisor.request(identity.id, { kind, name, payload, requestId: 'continuation:' + ++serial, epoch: supervisor.getStatus().epoch })
}
async function snapshot() {
  lastSnapshot = await request('query', 'state.snapshot')
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  return lastSnapshot
}
async function until(read, label, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await delay(40)
  }
  throw Error('Timed out in ' + stageName + ': ' + label + '\n' + JSON.stringify({ lastSnapshot, transport: transport.slice(-12), native: nativeSamples.slice(-5) }))
}
const providerFacts = () => request('command', 'providers.call', { providerId: 'ncm', method: 'getProfile', args: [] })
function wave(seconds) {
  const size = Math.round(48000 * 2 * seconds), bytes = Buffer.alloc(44 + size)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(size, 40)
  return bytes
}
async function submit(items) {
  const staged = await request('command', 'queue.submit', { kind: 'begin', selectedIndex: 0, play: true })
  await request('command', 'queue.submit', { kind: 'append', id: staged.id, sequence: 1, items })
  return request('command', 'queue.submit', { kind: 'commit', id: staged.id, sequence: 2 })
}
async function main() {
  await app.whenReady()
  const music = join(profile, 'music'), library = join(profile, 'music-library.json')
  mkdirSync(music)
  const cue = join(music, 'disc.wav'), local = join(music, 'local.wav'), long = join(music, 'long.wav')
  writeFileSync(cue, wave(4)); writeFileSync(local, wave(1.6)); writeFileSync(long, wave(30))
  const tracks = [
    { id: 'cue:first', title: 'CUE first', source: 'local', filePath: cue, duration: 1.6, cueRange: { startSeconds: 0, endSeconds: 1.6 } },
    { id: 'cue:second', title: 'CUE second', source: 'local', filePath: cue, duration: 1.6, cueRange: { startSeconds: 1.6, endSeconds: 3.2 } },
    { id: 'local', title: 'Local', source: 'local', filePath: local, duration: 1.6 },
    { id: 'long', title: 'Long silence', source: 'local', filePath: long, duration: 30 }
  ]
  writeFileSync(library, JSON.stringify({ version: 2, revision: 0, folders: [], exclusions: [], tracks }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    onboardingCompleted: true, autoAnalyzeBpm: false, onlineLyricsFallback: false,
    autoCheckUpdate: false, playbackResumeMode: 'trackAndPosition', streamingAudioCache: 'off',
    audioProcessing: { gapless: true, crossfadeSeconds: 0, volumeNormalization: 'off', fftEnabled: false }
  }))
  const httpRequests = [], bytes = wave(1.6)
  server = createServer((req, res) => {
    httpRequests.push(req.url)
    if (req.url.startsWith('/expired.wav')) { res.writeHead(403); res.end('expired'); return }
    assert.ok(req.url.startsWith('/provider.wav'), req.url)
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
    if (start >= bytes.length) { res.writeHead(416, { 'content-range': 'bytes */' + bytes.length }); res.end(); return }
    res.writeHead(match ? 206 : 200, { 'content-type': 'audio/wav', 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(match ? { 'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {}) })
    res.end(bytes.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const pluginId = 'com.twilightecho.provider.ncm', pkg = join(profile, 'plugins', pluginId, '1.0.0'), data = join(profile, 'plugin-data', pluginId)
  mkdirSync(pkg, { recursive: true }); mkdirSync(data, { recursive: true })
  writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ id: pluginId, name: 'Native continuation provider', description: 'Loopback silence only', author: 'Fixture', license: 'MIT', version: '1.0.0', main: 'index.mjs', type: ['provider'], apiVersion: 4, engines: { twilightEcho: '*' }, permissions: ['settings', 'network', 'library:read'] }))
  writeFileSync(join(pkg, 'index.mjs'), pluginSource)
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ origin }))
  writeFileSync(join(profile, 'plugin-state.json'), JSON.stringify({ [pluginId]: { enabled: true, activeVersion: '1.0.0', source: 'directory', installedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }))
  const pluginPlatform = createPluginManagerPlatform({ userData: profile, launchHost() { throw Error('Host launches belong to Core') } })
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path
  const authorized = new Set([cue, local, long].map(canonical))
  const authorize = async ({ source }) => {
    assert.ok(authorized.has(canonical(source)) || source.startsWith(origin + '/provider.wav'), source)
    return source
  }
  supervisor = new CoreSupervisor({
    configuration: { root: profile, libraryFilePath: library, coverCacheDir: join(profile, 'covers'), libraryStorage: 'sqlite', resumeMode: 'trackAndPosition', streamingAudioCache: 'off', onlineLyricsFallback: false, audioConfig: { exclusiveMode: false, volume: 0, audioProcessing: { gapless: true, crossfadeSeconds: 0, fftEnabled: false } }, plugins: { appVersion: '1.0.0', hostIdleTimeoutMs: 0, proxy: { proxyMode: 'off', proxyHost: '', proxyPort: 0, proxyAllowDirectFallback: false } } },
    entries: Object.fromEntries(Object.entries({ core: 'musicCore', audio: 'audioEngineService', 'audio-test': 'audioEngineService', database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService', plugin: 'pluginHost' }).map(([key, name]) => [key, join(root, 'out', 'main', name + '.js')])),
    readyTimeoutMs: 30000, requestTimeoutMs: 15000, stopTimeoutMs: 5000,
    platform: {
      ...createDspCorePlatform(),
      'settings.authorizePaths': async paths => paths,
      'downloads.authorizedRoots': async () => ({ libraryRoots: [music], downloadRoot: null }),
      'paths.prepareAudio': authorize,
      'paths.authorizeAudio': authorize,
      'paths.authorizeLibraryDirectory': async ({ path }) => { assert.equal(path, music); return path },
      'paths.authorizeAudioFile': async ({ path }) => { assert.ok(authorized.has(canonical(path))); return path },
      'paths.areAudioFilesAuthorized': async ({ paths }) => paths.map(path => authorized.has(canonical(path))),
      'media.resolveAudio': async ({ handle }) => remoteMediaGrants.resolve(handle, 'audio'),
      'media.protectProviderResult': async ({ value, method }) => pluginPlatform.protectProviderResult(value, method),
      'credentials.protect': async ({ value, scope }) => protectJsonValue(value, scope),
      'credentials.unprotect': async ({ value, scope }) => unprotectJsonValue(value, scope),
      'artwork.present': async () => ({ cover: null, coverSource: null }),
      'artwork.remotePreview': async () => null,
      'artwork.normalizeCachedCover': async () => null,
      'overlay.hide': async () => {}
    },
    fork(entry, args, name) {
      const child = utilityProcess.fork(entry, args, { serviceName: name, stdio: 'pipe', env: { ...process.env, TWILIGHT_PLUGIN_PROXY_MODE: 'off' } })
      const owner = { child, name, instance: children.length }; children.push(owner); alive.add(child); record('fork', { name })
      child.once('exit', code => { alive.delete(child); record('exit', { name, code }) })
      child.stdout?.on('data', value => process.stdout.write(value)); child.stderr?.on('data', value => process.stderr.write(value))
      const send = child.postMessage.bind(child)
      child.postMessage = (message, ports) => {
        if (name === 'twilight-audio' && message.kind === 'supervisor:stop-audio') record('stop requested')
        if (name === 'twilight-audio' && message.kind === 'core:attach-service') {
          const original = ports[0], { port1, port2 } = new MessageChannelMain(), methods = new Map()
          original.on('message', ({ data: value }) => {
            if (value.kind === 'request') {
              methods.set(value.requestId, value.method)
              if (['Play', 'Seek', 'LoadQueue', 'RebindQueue', 'Pause', 'Stop'].includes(value.method)) transport.push({ method: value.method, args: value.args, instance: owner.instance, at: Date.now() })
            }
            port1.postMessage(value)
          })
          port1.on('message', ({ data: value }) => {
            if (value.kind === 'response') {
              const method = methods.get(value.requestId); methods.delete(value.requestId)
              if (method === 'GetPlaybackInfo' && value.ok) {
                const info = typeof value.value === 'string' ? JSON.parse(value.value) : value.value
                nativeSamples.push({ state: info.state, source: info.source, position: info.position, queueIndex: info.queueIndex, instance: owner.instance })
              }
            }
            original.postMessage(value)
          })
          original.start(); port1.start(); relays.push(original, port1)
          return send(message, [port2])
        }
        return send(message, ports)
      }
      child.on('message', message => {
        if (name === 'twilight-audio' && message.kind === 'supervisor:audio-stopped') record('stop confirmed', { stopped: message.stopped })
      })
      return child
    },
    channel: () => new MessageChannelMain()
  })
  supervisor.on('failure', error => console.error('[native-continuation] expected recovery or failure:', error.message))
  supervisor.connect(identity)
  const initialized = once(supervisor, 'initialized'), starting = supervisor.start(); void starting.catch(() => {})
  await initialized
  await request('command', 'migration.begin', { id: 'empty-fixture', manifest: { version: 1, counts: emptyCoreStateCounts() } })
  await request('command', 'migration.commit', { id: 'empty-fixture' }); await starting
  assert.deepEqual((await request('query', 'providers.list')).map(item => item.id), ['ncm'])

  stage('natural mixed-source and CUE continuation')
  await submit([{ kind: 'local', id: 'cue:first' }, { kind: 'local', id: 'cue:second' }, { kind: 'local', id: 'local' }, { kind: 'provider', track: { id: 'ncm:77', source: 'ncm', ncmSongId: 77, title: 'Expiring loopback', artist: 'Native continuation', album: '', duration: 1.6 } }])
  const mixed = [], occurrenceIds = new Set()
  await until(async () => {
    const state = await snapshot()
    if (state.playback?.state === 'playing' && state.playback.nativePlaybackActive && state.track && mixed.at(-1)?.id !== state.track.id) {
      mixed.push({ id: state.track.id, occurrenceId: state.queue.occurrenceId, cueRange: state.track.cueRange })
      occurrenceIds.add(state.queue.occurrenceId)
      console.log('[native-continuation] actual track', JSON.stringify(mixed.at(-1)))
    }
    return mixed.length === 4 && state.playback.position > 0.1
  }, 'four actual playing occurrences')
  assert.deepEqual(mixed.map(item => item.id), ['cue:first', 'cue:second', 'local', 'ncm:77'])
  assert.deepEqual(mixed.slice(0, 2).map(item => ({ start: item.cueRange.startSeconds, end: item.cueRange.endSeconds })), [{ start: 0, end: 1.6 }, { start: 1.6, end: 3.2 }])
  const sourceFacts = await providerFacts()
  assert.ok(sourceFacts.resolutions.some(item => item.id === 'ncm:77' && !item.force))
  assert.ok(sourceFacts.resolutions.some(item => item.id === 'ncm:77' && item.force))
  assert.ok(httpRequests.some(path => path.includes('id=77')))
  assert.equal(httpRequests.some(path => path.startsWith('/expired.wav')), false)
  await request('command', 'playback.stop')

  stage('FM automatic refill after actual native advancement')
  await request('command', 'personalized.start', { providerId: 'ncm', key: 'fm', play: true })
  const fmStart = await until(async () => { const state = await snapshot(); return state.playback.state === 'playing' && state.playback.nativePlaybackActive && state.queue?.index === 0 && state.personalized && state }, 'FM playing first seed')
  assert.equal((await providerFacts()).fmCalls, 1)
  assert.equal(fmStart.queue.total, 4)
  await until(async () => {
    const state = await snapshot(), facts = await providerFacts()
    return state.playback.state === 'playing' && state.playback.nativePlaybackActive && state.queue.id === fmStart.queue.id && state.queue.index >= 1 && state.queue.occurrenceId !== fmStart.queue.occurrenceId && state.queue.total >= 8 && facts.fmCalls >= 2
  }, 'native FM advance causes observation-owned append')
  await request('command', 'playback.stop')

  stage('heart automatic refill after actual native advancement')
  await request('command', 'liked.play', { play: true })
  await until(async () => (await snapshot()).playback.state === 'playing', 'liked seed playing')
  await request('command', 'playback.mode', { mode: 'heart' })
  const heartStart = await snapshot()
  assert.equal(heartStart.heart.active, true)
  assert.equal(heartStart.queue.total, 5)
  assert.equal((await providerFacts()).heartCalls, 1)
  await until(async () => {
    const state = await snapshot(), facts = await providerFacts()
    return state.playback.state === 'playing' && state.playback.nativePlaybackActive && state.queue.id === heartStart.queue.id && state.queue.index >= 2 && state.queue.occurrenceId !== heartStart.queue.occurrenceId && state.queue.total >= 9 && facts.heartCalls >= 2
  }, 'native heart advance causes observation-owned append')
  await request('command', 'playback.stop')
  await request('command', 'playback.mode', { mode: 'sequential' })

  const lateCounts = {}
  for (const [action, id] of [['pause', 9001], ['stop', 9002]]) {
    stage('slow source preparation interrupted by ' + action)
    const prepared = submit([{ kind: 'provider', track: { id: 'ncm:' + id, ncmSongId: id, source: 'ncm', title: 'Slow ' + action, artist: '', album: '', duration: 1.6 } }]).then(() => ({ completed: true }), error => ({ error: error.message }))
    await until(async () => (await providerFacts()).slowStarted.includes(id), 'provider preparation began')
    const begin = Date.now()
    await request('command', 'playback.' + action)
    assert.ok(Date.now() - begin < 1000, action + ' waited for slow source resolution')
    const baseline = transportCount()
    await prepared
    await delay(1400)
    const state = await snapshot()
    assert.notEqual(state.playback.state, 'playing')
    assert.equal(transportCount() - baseline, 0, 'late preparation caused native transport after ' + action)
    assert.ok((await providerFacts()).slowCancelled.includes(id))
    lateCounts[action] = transportCount() - baseline
  }

  stage('actual native audio utility loss preserves occurrence and requires explicit resume')
  await submit([{ kind: 'local', id: 'long' }, { kind: 'local', id: 'local' }])
  const beforeAudioLoss = await until(async () => { const state = await snapshot(); return state.playback.state === 'playing' && state.playback.position > 0.15 && state }, 'long silence playing')
  const originalAudio = live('twilight-audio'), playsBeforeAudioLoss = count('Play')
  const audioExit = once(originalAudio.child, 'exit'); originalAudio.child.kill(); await audioExit
  const replacementAudio = await until(() => { const item = live('twilight-audio'); return item && item !== originalAudio && item }, 'replacement audio utility')
  await until(() => transport.some(item => item.instance === replacementAudio.instance && item.method === 'LoadQueue') && nativeSamples.some(item => item.instance === replacementAudio.instance && item.state === 'stopped'), 'replacement native engine stopped with restored queue')
  assert.equal((await snapshot()).queue.occurrenceId, beforeAudioLoss.queue.occurrenceId)
  assert.notEqual(lastSnapshot.playback.state, 'playing')
  await request('command', 'queue.refresh')
  const audioRecovered = await snapshot()
  assert.equal(audioRecovered.playback.state, 'paused')
  assert.equal(audioRecovered.queue.occurrenceId, beforeAudioLoss.queue.occurrenceId)
  const audioRestartPlayCalls = count('Play') - playsBeforeAudioLoss
  assert.equal(audioRestartPlayCalls, 0)

  stage('actual Core loss confirms native stop before rebuilding paused')
  await request('command', 'playback.play')
  const beforeCoreLoss = await until(async () => { const state = await snapshot(); return state.playback.state === 'playing' && state.playback.position > 0.15 && state }, 'explicitly resumed native silence')
  await request('command', 'lifecycle.flush')
  const epoch = supervisor.getStatus().epoch, playsBeforeCoreLoss = count('Play'), eventStart = events.length
  const recovered = new Promise((resolve, reject) => {
    const listener = status => {
      if (status.phase === 'failed') { supervisor.off('status', listener); reject(Error('Core automatic recovery failed')) }
      if (status.phase === 'ready' && status.epoch !== epoch) { supervisor.off('status', listener); resolve() }
    }
    supervisor.on('status', listener)
  })
  live('twilight-core').child.kill(); await recovered
  const coreRecovered = await snapshot(), recoveryEvents = events.slice(eventStart)
  const stop = recoveryEvents.find(item => item.kind === 'stop confirmed' && item.stopped === true)
  const restart = recoveryEvents.find(item => item.kind === 'fork' && item.name === 'twilight-core')
  assert.ok(stop && restart && stop.order < restart.order, JSON.stringify(recoveryEvents))
  assert.equal(coreRecovered.playback.state, 'paused')
  assert.equal(coreRecovered.queue.occurrenceId, beforeCoreLoss.queue.occurrenceId)
  await delay(500)
  assert.equal(count('Play') - playsBeforeCoreLoss, 0)
  const windows = BrowserWindow.getAllWindows().length
  await supervisor.shutdown()
  assert.equal(alive.size, 0)
  for (const port of relays) port.close()
  await new Promise(resolve => server.close(resolve))
  const result = { windows, mixedIds: mixed.map(item => item.id), mixedOccurrences: occurrenceIds.size, expiredUrlOpened: false, forcedRefresh: true, fmObservedRefill: true, heartObservedRefill: true, pauseLateTransport: lateCounts.pause, stopLateTransport: lateCounts.stop, audioRecoveredPaused: true, audioRestartPlayCalls, coreRecoveredPaused: true, coreRestartPlayCalls: count('Play') - playsBeforeCoreLoss, confirmedStopBeforeRestart: true, servicesAfterShutdown: alive.size }
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify(result))
  app.quit()
}
main().catch(async error => {
  console.error('[native-continuation] FAILED', stageName, error.stack || error)
  console.error(JSON.stringify({ lastSnapshot, transport: transport.slice(-12), native: nativeSamples.slice(-8), events: events.slice(-15) }))
  await supervisor?.shutdown().catch(failure => console.error('[native-continuation] cleanup', failure))
  for (const child of alive) child.kill()
  for (const port of relays) port.close()
  server?.closeAllConnections(); server?.close()
  app.exit(1)
})
`
