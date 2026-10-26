import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type {
  CoreClientIdentity,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../shared/coreProtocol.ts'
import { CoreApplicationRuntime } from './coreApplication.ts'
import { CORE_WINDOW_POLICIES } from '../coreProcess/windowBridge.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function fixture() {
  const events: string[] = []
  const clients: CoreClientIdentity[] = []
  const requests: { clientId: string; request: CoreRequestEnvelope; signal?: AbortSignal }[] = []
  const registered: unknown[] = []
  const states: CoreSnapshot[] = []
  let status = { phase: 'starting', epoch: 'first' as string | null }
  let flushWork = Promise.resolve(),
    shutdownWork = Promise.resolve()
  const supervisor = Object.assign(new EventEmitter(), {
    start: async () => {
      events.push('start')
    },
    retry: async () => {
      events.push('retry')
    },
    shutdown: async () => {
      events.push('shutdown')
      await shutdownWork
    },
    connect: (identity: CoreClientIdentity) => clients.push(identity),
    disconnect: (id: string) => {
      events.push(`disconnect:${id}`)
    },
    getStatus: () => status,
    request: async (clientId: string, request: CoreRequestEnvelope, signal?: AbortSignal) => {
      events.push(request.name)
      requests.push({ clientId, request, signal })
      return { accepted: true }
    }
  })
  const application = new CoreApplicationRuntime({
    supervisor: supervisor as never,
    windows: {
      register: (contents, policy) => {
        registered.push({ contents, policy })
        return () => {}
      },
      dispose: () => {
        events.push('windows:dispose')
      }
    },
    settings: {
      flush: async () => {
        events.push('settings:flush')
        await flushWork
      }
    },
    system: {
      update: (state) => {
        states.push(state)
      },
      invalidate: () => {
        events.push('system:invalidate')
      }
    }
  })
  return {
    application,
    supervisor,
    clients,
    requests,
    registered,
    states,
    events,
    state(phase = 'ready', epoch = 'first') {
      const snapshot = { phase, epoch, sequence: states.length } as CoreSnapshot
      supervisor.emit('client-message', clients[0].id, { kind: 'state', snapshot })
      return snapshot
    },
    status(phase: string, epoch: string | null) {
      status = { phase, epoch }
      supervisor.emit('status', status)
    },
    holdSettings() {
      const gate = deferred()
      flushWork = gate.promise
      return gate.resolve
    },
    holdShutdown() {
      const gate = deferred()
      shutdownWork = gate.promise
      return gate.resolve
    }
  }
}

test('one application client is attached before ready and window replacement sends no playback commands', async () => {
  const f = fixture()
  assert.equal(f.clients.length, 1)
  assert.match(f.clients[0].id, /^system:/)
  assert.ok(f.clients[0].permissions.includes('migration:write'))
  await f.application.start()
  const migration = f.state('starting')
  assert.equal(f.application.snapshot(), migration)
  for (let replacement = 0; replacement < 3; replacement++) {
    f.application.register({ webContents: { id: replacement } } as never)
    f.application.register(
      { webContents: { id: `mini:${replacement}` } } as never,
      CORE_WINDOW_POLICIES.playback
    )
  }
  assert.equal(f.registered.length, 6)
  assert.equal(f.clients.length, 1)
  assert.deepEqual(f.requests, [])
  assert.equal(f.events.filter((name) => name === 'shutdown').length, 0)
  await f.application.shutdown()
})

test('Core epochs invalidate system state and each new command uses a fresh request ID without replay', async () => {
  const f = fixture()
  f.status('ready', 'first')
  f.state()
  const controller = new AbortController()
  await f.application.request('playback.control', { type: 'pause' }, controller.signal)
  assert.equal(f.requests[0].signal, controller.signal)
  assert.equal(f.requests[0].request.epoch, 'first')
  f.status('recovering', null)
  assert.equal(f.application.snapshot(), null)
  await assert.rejects(f.application.request('playback.control', { type: 'play' }), {
    code: 'NOT_READY'
  })
  assert.equal(f.requests.length, 1)
  f.status('ready', 'second')
  const restored = f.state('ready', 'second')
  await f.application.request('player.presentation', {})
  assert.equal(f.application.snapshot(), restored)
  assert.equal(f.requests[1].request.epoch, 'second')
  assert.notEqual(f.requests[0].request.requestId, f.requests[1].request.requestId)
  assert.equal(f.requests[1].request.kind, 'query')
  assert.equal(f.requests.filter(({ request }) => request.name === 'playback.control').length, 1)
  await f.application.shutdown()
})

test('flush drains satellite settings before checkpoint; shutdown retains connections until persistence ACK', async () => {
  const f = fixture()
  const releaseSettings = f.holdSettings()
  const checkpoint = f.application.flush()
  await turn()
  assert.deepEqual(f.events, ['settings:flush'])
  releaseSettings()
  await checkpoint
  assert.deepEqual(f.events, ['settings:flush', 'lifecycle.flush'])
  const releaseShutdown = f.holdShutdown()
  const quitting = f.application.shutdown()
  await turn()
  assert.deepEqual(f.events.slice(2), ['settings:flush', 'shutdown'])
  assert.equal(f.supervisor.listenerCount('client-message'), 1)
  releaseShutdown()
  await quitting
  assert.deepEqual(f.events.slice(4), [
    'windows:dispose',
    `disconnect:${f.clients[0].id}`,
    'system:invalidate'
  ])
  assert.equal(f.supervisor.listenerCount('client-message'), 0)
  assert.equal(f.supervisor.listenerCount('status'), 0)
})

test('a rejected final checkpoint leaves the supervised application attached for an explicit retry', async () => {
  const f = fixture()
  f.supervisor.shutdown = async () => {
    throw Error('database checkpoint failed')
  }
  await assert.rejects(f.application.shutdown(), /database checkpoint failed/)
  assert.equal(f.supervisor.listenerCount('client-message'), 1)
  assert.equal(f.events.includes('windows:dispose'), false)
  await f.application.retry()
  assert.equal(f.events.at(-1), 'retry')
})
