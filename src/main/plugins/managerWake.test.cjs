const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const ts = require('typescript')

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'twilight-plugin-wake-'))
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export function activate() {}\n')
  const importSource = (name) => import(pathToFileURL(path.join(__dirname, name)).href)
  const [manifest, routing, queue, rpc, idle] = await Promise.all([
    importSource('manifest.ts'),
    importSource('providerRouting.ts'),
    importSource('operationQueue.ts'),
    importSource('rpcCoordinator.ts'),
    importSource('hostIdle.ts')
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
    '../security/remoteMediaGrants.ts': { protectProviderMedia: (value) => value }
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
    appVersion: '1.2.4',
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
    engines: { twilightEcho: '*' },
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
    id: 'demo',
    name: 'Demo',
    capabilities: ['search'],
    supportedMethods: ['searchSongs']
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
