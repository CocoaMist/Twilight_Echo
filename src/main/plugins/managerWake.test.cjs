const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const ts = require('typescript')

async function fixture(t, { appVersion = '1.2.4', engineRange = '*', providerId = 'demo' } = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'twilight-plugin-wake-'))
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export function activate() {}\n')
  const importSource = (name) => import(pathToFileURL(path.join(__dirname, name)).href)
  const [manifest, routing, queue, rpc, idle, media] = await Promise.all([
    importSource('manifest.ts'),
    importSource('providerRouting.ts'),
    importSource('operationQueue.ts'),
    importSource('rpcCoordinator.ts'),
    importSource('hostIdle.ts'),
    importSource('../security/remoteMediaGrants.ts')
  ])
  const children = []
  let notify
  const activationStarted = new Promise((resolve) => {
    notify = resolve
  })
  class Child extends EventEmitter {
    messages = []
    postMessage(message) {
      this.messages.push(message)
      if (message.kind === 'activate') notify()
      if (message.kind === 'provider-call')
        queueMicrotask(() =>
          this.emit('message', {
            kind: 'provider-result',
            requestId: message.requestId,
            ok: true,
            value: message.args[0]
          })
        )
      if (message.kind === 'deactivate')
        queueMicrotask(() =>
          this.emit('message', {
            kind: 'deactivated',
            requestId: message.requestId
          })
        )
    }
    kill() {
      this.emit('exit', 0)
    }
  }
  const dependencies = {
    electron: {
      app: { getPath: () => directory },
      dialog: {},
      shell: {},
      utilityProcess: {
        fork: () => {
          const child = new Child()
          children.push(child)
          return child
        }
      }
    },
    './manifest': manifest,
    './providerRouting': routing,
    './operationQueue.ts': queue,
    './rpcCoordinator.ts': rpc,
    './hostIdle.ts': idle,
    './qishuiAuthBridge.ts': {
      QISHUI_PLUGIN_ID: 'com.twilightecho.provider.qishui',
      QishuiAuthBridge: class {}
    },
    './packageSecurity.ts': { resolvePluginFile: (file) => file },
    '../security/remoteMediaGrants.ts': media
  }
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'manager.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    require: (id) => {
      if (id in dependencies) return dependencies[id]
      if (id.startsWith('.')) return {}
      return require(id)
    },
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    console
  })
  const manager = new exports.TwilightPluginManager({
    appVersion,
    hostEntry: 'unused',
    hostIdleTimeoutMs: 300000,
    getPlaybackInfo: () => ({}),
    applyNativeDspPluginChain: () => {},
    player: {}
  })
  manager.appendLog = () => {}
  manager.queueContributionsSave = () => {}
  manager.queueStateSave = () => {}
  const descriptor = {
    id: 'com.example.demo',
    name: 'Demo',
    version: '1.0.0',
    enabled: true,
    status: 'enabled',
    main: 'index.mjs',
    engines: { twilightEcho: engineRange },
    type: ['provider'],
    permissions: ['network'],
    apiVersion: 3,
    paths: {
      versionRoot: directory,
      dataDir: directory,
      logPath: path.join(directory, 'plugin.log')
    }
  }
  manager.findDescriptor = async () => descriptor
  const provider = {
    id: providerId,
    name: 'Demo',
    capabilities: ['search', 'playbackUrl'],
    supportedMethods: ['searchSongs', 'getPlaybackUrl']
  }
  const info = fs.statSync(path.join(directory, 'index.mjs'))
  manager.contributionsCache[descriptor.id] = {
    version: descriptor.version,
    mainSignature: `${info.size}:${Math.floor(info.mtimeMs)}`,
    providers: [provider],
    ui: [],
    subscriptions: ['app:ready']
  }
  assert.equal(manager.hibernateFromCache(descriptor), true)
  t.after(async () => {
    manager.hostIdle.destroy()
    await manager.stopPlugin(descriptor.id)
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('twilight-plugin-wake-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const register = () => {
    children[0].emit('message', {
      kind: 'api-call',
      requestId: 'register',
      namespace: 'providers',
      method: 'register',
      args: [provider]
    })
    children[0].emit('message', { kind: 'api-event-subscribe', eventName: 'app:ready' })
  }
  const activate = () => children[0].emit('message', { kind: 'activated', pluginId: descriptor.id })
  return { manager, descriptor, children, activationStarted, register, activate }
}

for (const directory of ['ncm-provider', 'theme-workshop']) {
  test(`preview host validates and activates the ${directory} engine range`, async (t) => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../../resources/plugins', directory, 'plugin.json'),
        'utf8'
      )
    )
    const f = await fixture(t, {
      appVersion: '1.3.0-perview',
      engineRange: manifest.engines.twilightEcho
    })
    assert.equal(
      f.manager.validateRuntimeDescriptor(manifest, f.descriptor.paths.versionRoot),
      null
    )
    const starting = f.manager.startPlugin(f.descriptor)
    await Promise.race([f.activationStarted, starting])
    assert.equal(f.children.length, 1)
    f.activate()
    await starting
    assert.equal(f.manager.state[f.descriptor.id].enabled, true)
  })
}

test('preview host rejects a plugin requiring the corresponding stable release', async (t) => {
  const f = await fixture(t, { appVersion: '1.3.0-perview', engineRange: '>=1.3.0' })
  assert.match(
    f.manager.validateRuntimeDescriptor(f.descriptor, f.descriptor.paths.versionRoot),
    /插件要求 Twilight Echo >=1\.3\.0/
  )
  await assert.rejects(f.manager.startPlugin(f.descriptor), /插件要求 Twilight Echo >=1\.3\.0/)
  assert.equal(f.children.length, 0)
})

test('concurrent provider calls preserve cached routes and await one activation', async (t) => {
  const f = await fixture(t)
  const first = f.manager.callProvider('demo', 'searchSongs', ['first'])
  await f.activationStarted
  const visibleDuringWake = f.manager.listProviders().map((provider) => provider.id)
  const second = f.manager.callProvider('demo', 'searchSongs', ['second']).then(
    (value) => ({ value }),
    (error) => ({ error: error.message })
  )
  f.register()
  const third = f.manager.callProvider('demo', 'searchSongs', ['third'])
  await new Promise(setImmediate)
  const prematureCalls = f.children[0].messages.filter(
    (message) => message.kind === 'provider-call'
  )
  f.activate()
  assert.equal(await first, 'first')
  assert.deepEqual(await second, { value: 'second' })
  assert.equal(await third, 'third')
  assert.deepEqual(visibleDuringWake, ['demo'])
  assert.equal(prematureCalls.length, 0)
  assert.equal(f.children.length, 1)
  assert.equal(f.manager.isHibernated(f.descriptor.id), false)
})

test('cached startup subscribers receive app:ready once, after activation', async (t) => {
  const f = await fixture(t)
  const first = f.manager.callProvider('demo', 'searchSongs', ['wake'])
  await f.activationStarted
  f.register()
  const broadcasting = f.manager.broadcastEvent('app:ready', { version: '1.2.4' })
  await new Promise(setImmediate)
  const prematureEvents = f.children[0].messages.filter((message) => message.kind === 'event')
  f.activate()
  await first
  await broadcasting
  await new Promise(setImmediate)
  assert.equal(prematureEvents.length, 0)
  assert.deepEqual(
    f.children[0].messages
      .filter((message) => message.kind === 'event')
      .map((message) => message.name),
    ['app:ready']
  )
})

test('app:ready wakes a cached subscriber, while shutdown events keep it asleep', async (t) => {
  const f = await fixture(t)
  await f.manager.broadcastEvent('app:before-quit', {})
  assert.equal(f.children.length, 0)
  f.manager.shuttingDown = true
  await f.manager.broadcastEvent('app:ready', {})
  assert.equal(f.children.length, 0)
  f.manager.shuttingDown = false
  const broadcasting = f.manager.broadcastEvent('app:ready', {})
  await new Promise(setImmediate)
  assert.equal(f.children.length, 1)
  await f.activationStarted
  f.register()
  f.activate()
  await broadcasting
  await new Promise(setImmediate)
  assert.equal(f.children[0].messages.filter((message) => message.kind === 'event').length, 1)
})

test('failed activation rejects concurrent callers and removes cached routes', async (t) => {
  const f = await fixture(t)
  const first = f.manager
    .callProvider('demo', 'searchSongs', ['first'])
    .catch((error) => error.message)
  await f.activationStarted
  const second = f.manager
    .callProvider('demo', 'searchSongs', ['second'])
    .catch((error) => error.message)
  f.children[0].emit('message', { kind: 'host-error', message: 'activation failed' })
  assert.match(await first, /activation failed/)
  assert.match(await second, /activation failed/)
  assert.deepEqual(
    f.manager.listProviders().map((provider) => provider.id),
    []
  )
})

test('local playback proxies survive the five-minute idle boundary without player subscriptions', async (t) => {
  for (const url of [
    'http://127.0.0.1:32100/stream/current',
    'http://127.0.0.2:32100/stream/current',
    'http://localhost:32100/stream/current',
    'http://[::1]:32100/stream/current',
    'https://LOCALHOST.:32100/stream/current'
  ]) {
    await t.test(url, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const f = await fixture(t, { providerId: 'bili' })
      const playback = f.manager.callProvider('bili', 'getPlaybackUrl', [url])
      await f.activationStarted
      f.register()
      f.activate()
      assert.match(await playback, /^twilight-media:\/\/audio\//)
      assert.equal(f.manager.rpcCalls.getPendingCount(f.descriptor.id), 0)

      t.mock.timers.tick(299999)
      await new Promise(setImmediate)
      assert.equal(f.manager.running.has(f.descriptor.id), true)
      t.mock.timers.tick(1)
      await new Promise(setImmediate)
      assert.equal(
        f.manager.running.has(f.descriptor.id),
        true,
        'the stream host must survive 5:00'
      )
      assert.equal(f.manager.isHibernated(f.descriptor.id), false)

      // A paused track or a prepared queue URL has no RPCs or subscribed events
      // either, but still needs the same proxy when it resumes or starts.
      t.mock.timers.tick(6 * 300000)
      await new Promise(setImmediate)
      await f.manager.hibernatePlugin(f.descriptor.id)
      assert.equal(f.manager.running.has(f.descriptor.id), true)
      assert.equal(
        f.children[0].messages.some((message) => message.kind === 'deactivate'),
        false
      )

      // Explicit stop/disable must still shut down a resident media proxy.
      await f.manager.stopPlugin(f.descriptor.id)
      assert.equal(f.manager.running.has(f.descriptor.id), false)
      assert.equal(
        f.children[0].messages.some((message) => message.kind === 'deactivate'),
        true
      )

      const restarting = f.manager.startPlugin(f.descriptor)
      await new Promise(setImmediate)
      f.children[1].emit('message', { kind: 'activated', pluginId: f.descriptor.id })
      await restarting
      assert.equal(
        f.manager.canHibernatePlugin(f.descriptor.id),
        true,
        'residency belongs to one host instance'
      )
    })
  }
})

test('CDN playback URLs and non-playback loopback results still allow idle hibernation', async (t) => {
  for (const [method, value] of [
    ['getPlaybackUrl', 'https://audio.example.com/song.m4a'],
    ['getPlaybackUrl', 'https://localhost.example.com/song.m4a'],
    ['getPlaybackUrl', 'D:\\Music\\cached.flac'],
    ['getPlaybackUrl', null],
    ['searchSongs', 'http://127.0.0.1:32100/image/cover']
  ]) {
    await t.test(`${method}: ${value}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const f = await fixture(t)
      const call = f.manager.callProvider('demo', method, [value])
      await f.activationStarted
      f.register()
      f.activate()
      await call

      t.mock.timers.tick(299999)
      await new Promise(setImmediate)
      assert.equal(f.manager.running.has(f.descriptor.id), true)
      t.mock.timers.tick(1)
      await new Promise(setImmediate)
      assert.equal(f.manager.running.has(f.descriptor.id), false)
      assert.equal(f.manager.isHibernated(f.descriptor.id), true)
      assert.equal(
        f.children[0].messages.some((message) => message.kind === 'deactivate'),
        true
      )
    })
  }
})
