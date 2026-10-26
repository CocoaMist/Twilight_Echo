import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const httpServerSource = readFileSync(
  new URL('../../core/cast/httpServer.ts', import.meta.url),
  'utf8'
)
const remoteIpcSource = readFileSync(new URL('./remoteIpc.ts', import.meta.url), 'utf8')
const coreSessionSource = readFileSync(
  new URL('../../core/playback/session.ts', import.meta.url),
  'utf8'
)
const corePlayerStoreSource = readFileSync(
  new URL('../../renderer/src/stores/player/corePlayerStore.ts', import.meta.url),
  'utf8'
)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function castIpcFixture(holdNewLoad = false) {
  const events: string[] = []
  const stopEntered = deferred()
  const stopRelease = deferred()
  const loadEntered = deferred()
  const loadRelease = deferred()
  type Handler = (...args: unknown[]) => Promise<unknown>
  const handlers = new Map<string, Handler>()
  const devices = ['old', 'new'].map((usn) => ({
    usn,
    friendlyName: usn,
    avTransportUrl: usn,
    renderingControlUrl: usn
  }))
  class Server {
    async start() {}
    async stop() {}
    isMediaOnly() {
      return false
    }
    issueMediaUrl() {
      return 'http://media.invalid/token'
    }
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      ipcMain: { handle: (name: string, callback: Handler) => handlers.set(name, callback) }
    },
    'node:crypto': {},
    '../../core/cast/policy.ts': { isPrivateOrLoopbackHost: () => false },
    '../security/electronSecurity.ts': { assertTrustedIpcSender() {} },
    '../security/ipcValidation.ts': { normalizeIpcString: (value: string) => value },
    '../security/localPaths.ts': { resolveAuthorizedAudioFile: async (path: string) => path },
    '../security/remoteMediaGrants.ts': {},
    '../core/runtime.ts': {
      runtime: {
        appSettings: { remoteControlEnabled: true },
        mainWindow: { isDestroyed: () => false, webContents: { once() {}, send() {}, id: 1 } }
      }
    },
    '../../shared/remoteControl.ts': {},
    '../app/AfterglowModeService.ts': { isAfterglowModeActive: () => false },
    '../../shared/afterglowMode.ts': {},
    './httpServer.ts': { RemoteHttpServer: Server },
    './dlnaClient.ts': {
      discoverDlnaDevices: async () => devices,
      dlnaSetAvTransportUri: async (device: string) => {
        events.push(`load:${device}`)
        if (holdNewLoad && device === 'new') {
          loadEntered.resolve()
          await loadRelease.promise
        }
      },
      dlnaPlay: async (device: string) => {
        events.push(`play:${device}`)
      },
      dlnaPause: async (device: string) => {
        events.push(`pause:${device}`)
      },
      dlnaSeek: async (device: string, seconds: number) => {
        events.push(`seek:${device}:${seconds}`)
      },
      dlnaSetVolume: async () => {},
      dlnaStop: async (device: string) => {
        events.push(`stop:${device}:start`)
        stopEntered.resolve()
        await stopRelease.promise
        events.push(`stop:${device}:commit`)
      }
    },
    './chromecastClient.ts': { discoverChromecastDevices: async () => [] },
    './didl.ts': { buildDidlLiteMetadata: () => '' },
    '../app/settingsRuntime.ts': {}
  }
  const exports: { setupRemoteIpc?: () => void } = {}
  runInNewContext(
    ts.transpileModule(remoteIpcSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      console,
      process
    }
  )
  exports.setupRemoteIpc!()
  const call = <T = unknown>(name: string, payload?: unknown): Promise<T> =>
    handlers.get(`remote:${name}`)!({}, payload) as Promise<T>
  return { events, stopEntered, stopRelease, loadEntered, loadRelease, call }
}

test('main transport preserves cast ownership when stopCast overlaps a new castToDevice', async () => {
  const state = castIpcFixture()
  await state.call('discoverDlna')
  await state.call('castToDevice', { usn: 'old', filePath: 'D:/Music/one.flac' })
  const stopped = state.call('stopCast')
  await state.stopEntered.promise
  const cast = state.call('castToDevice', { usn: 'new', filePath: 'D:/Music/one.flac' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  state.stopRelease.resolve()
  await Promise.all([stopped, cast])
  assert.ok(state.events.indexOf('stop:old:commit') < state.events.indexOf('load:new'))
  assert.equal((await state.call<{ usn: string } | null>('getCastTarget'))?.usn, 'new')
  await state.call('controlCast', { pause: true, seek: 12 })
  assert.deepEqual(state.events.slice(-2), ['seek:new:12', 'pause:new'])
})

test('cast pause and seek wait for the pending target change', async () => {
  const state = castIpcFixture(true)
  await state.call('discoverDlna')
  await state.call('castToDevice', { usn: 'old', filePath: 'D:/Music/one.flac' })
  const cast = state.call('castToDevice', { usn: 'new', filePath: 'D:/Music/two.flac' })
  await state.loadEntered.promise
  const controls = state.call('controlCast', { pause: true, seek: 25 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  state.loadRelease.resolve()
  await Promise.all([cast, controls])
  assert.deepEqual(state.events.slice(-2), ['seek:new:25', 'pause:new'])
  assert.equal((await state.call<{ usn: string } | null>('getCastTarget'))?.usn, 'new')
})

test('a rejected cast releases the main transport queue for the next request', async () => {
  const state = castIpcFixture()
  await state.call('discoverDlna')
  const rejected = state.call('castToDevice', { usn: 'missing', filePath: 'D:/Music/one.flac' })
  const next = state.call('castToDevice', { usn: 'new', filePath: 'D:/Music/two.flac' })
  await assert.rejects(rejected, /Cast device not found/)
  await next
  assert.equal((await state.call<{ usn: string } | null>('getCastTarget'))?.usn, 'new')
})

test('remote HTTP server supports mediaOnly bind without full remote surface', () => {
  assert.match(httpServerSource, /mode\?: RemoteServerMode/)
  assert.match(httpServerSource, /mode === 'mediaOnly'/)
  assert.match(httpServerSource, /media_only/)
  // mediaOnly must not advertise PIN / remote URLs as "enabled".
  assert.match(httpServerSource, /enabled: this\.enabled && !mediaOnly/)
  assert.match(
    httpServerSource,
    /pin: this\.enabled && !mediaOnly \? this\.auth\.getPin\(\) : null/
  )
  // mediaOnly request path only serves /media/ tokens.
  assert.match(
    httpServerSource,
    /if \(this\.mode === 'mediaOnly'\) \{[\s\S]*\/media\/[\s\S]*media_only/
  )
  // Mode switches keep media grants (no stop/clear on applyMode).
  assert.match(httpServerSource, /applyMode\(desiredMode\)/)
  assert.match(httpServerSource, /applyMode\(desiredMode: RemoteServerMode\)/)
  assert.match(httpServerSource, /keep cast media grants|Keep cast media grants/i)
})

test('cast binds media-only when remote control is off and tears it down on stopCast', () => {
  assert.match(remoteIpcSource, /ensureCastMediaServer/)
  assert.match(remoteIpcSource, /remoteEnabled[\s\S]*mode: 'full'[\s\S]*mode: 'mediaOnly'/)
  assert.match(remoteIpcSource, /await ensureCastMediaServer\(\)/)
  assert.match(
    remoteIpcSource,
    /remote:stopCast[\s\S]*isMediaOnly\(\)[\s\S]*remoteControlEnabled !== true[\s\S]*server\.stop\(\)/
  )
  // Disabling remote keeps mediaOnly only while a cast session is active.
  assert.match(
    remoteIpcSource,
    /if \(activeCastUsn\) \{\s*await server\.start\(preferredPort, \{ mode: 'mediaOnly' \}\)/
  )
  // Failed cast releases orphan mediaOnly binds.
  assert.match(remoteIpcSource, /releaseOrphanMediaOnlyServer/)
  assert.match(remoteIpcSource, /if \(!castSucceeded\)[\s\S]*releaseOrphanMediaOnlyServer/)
  // Bare cast upstreams cannot target private/loopback hosts.
  assert.match(remoteIpcSource, /isPrivateOrLoopbackHost/)
  assert.match(remoteIpcSource, /Cast media URL host is not authorized/)
})

test('player queue skip re-casts while a cast session is active', () => {
  assert.match(corePlayerStoreSource, /castToDevice[\s\S]*command\('cast\.start'/)
  assert.match(corePlayerStoreSource, /next: \(\) => command\('playback\.next'/)
  assert.match(corePlayerStoreSource, /prev: \(\) => command\('playback\.previous'/)
  assert.match(coreSessionSource, /async navigate\(direction: 1 \| -1/)
  assert.match(coreSessionSource, /if \(!this\.options\.cast\?\.active\(\)\) \{[\s\S]*engine\.loadQueue/)
  assert.match(
    coreSessionSource,
    /if \(this\.options\.cast\?\.active\(\)\) \{[\s\S]*this\.options\.cast\.load\([\s\S]*this\.acceptCast\(sample, resolved\.source\)/
  )
})

test('remote HTTP server exposes only authenticated bounded browse and explicit command failures', () => {
  assert.match(httpServerSource, /url\.pathname === '\/api\/browse'/)
  assert.match(httpServerSource, /parseRemoteBrowseRequest\(url\.searchParams\)/)
  assert.match(httpServerSource, /browse_handler_missing/)
  assert.match(httpServerSource, /error instanceof RemoteCommandError/)
  assert.match(httpServerSource, /this\.sendJson\(res, error\.status/)
  assert.match(remoteIpcSource, /RENDERER_REQUEST_TIMEOUT_MS = 5_000/)
  assert.match(remoteIpcSource, /message === 'queue_changed' \? 409 : 503/)
})

test('remote HTTP server no longer uses CORS wildcard and caps SSE clients', () => {
  // S2: CORS 只回显同源/回环 Origin，不再无条件 `*`。
  assert.match(httpServerSource, /teCorsOrigin/)
  assert.match(httpServerSource, /resolveAllowedOrigin\(/)
  assert.doesNotMatch(httpServerSource, /'access-control-allow-origin': '\*'/)
  // S3: SSE 长连接上限。
  assert.match(httpServerSource, /sseMaxClients/)
  assert.match(httpServerSource, /too_many_event_connections/)
})
