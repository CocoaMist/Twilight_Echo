import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createServicePort, type ServiceMessagePort } from './servicePort.ts'
import { CoreServiceLauncher } from '../coreProcess/serviceLauncher.ts'
import type { CoreChildMessage } from '../../shared/coreProcessProtocol.ts'

class Port extends EventEmitter implements ServiceMessagePort {
  sent: unknown[] = []
  started = false
  closed = false
  postMessage(message: unknown) {
    this.sent.push(message)
  }
  start() {
    this.started = true
  }
  close() {
    this.closed = true
  }
}
test('peer-mode service startup uses the transferred MessagePort; main is not a business relay', () => {
  const parent = new Port(),
    peer = new Port()
  const received: unknown[] = [],
    supervised: unknown[] = []
  const service = createServicePort({
    parent,
    peerMode: true,
    supervise: (message, reply) => {
      supervised.push(message)
      reply({ stopped: true })
    }
  })
  service.on('message', (message) => received.push(message))
  service.postMessage({ kind: 'ready' })
  assert.deepEqual(parent.sent, [])
  parent.emit('message', { data: { kind: 'core:attach-service' }, ports: [peer] })
  assert.equal(peer.started, true)
  assert.deepEqual(peer.sent, [{ kind: 'ready' }])
  parent.emit('message', { data: { kind: 'request', method: 'Play' } })
  assert.deepEqual(received, [])
  peer.emit('message', { data: { kind: 'request', method: 'GetPlaybackInfo' } })
  assert.equal(received.length, 1)
  parent.emit('message', { data: { kind: 'supervisor:stop-audio', requestId: 's' } })
  assert.equal(supervised.length, 1)
  assert.deepEqual(parent.sent, [{ stopped: true }])
  const replacement = new Port()
  parent.emit('message', { data: { kind: 'core:attach-service' }, ports: [replacement] })
  service.postMessage({ kind: 'response' })
  assert.equal(replacement.sent.length, 0)
  assert.equal(peer.sent.length, 2)
})
test('existing main/Node service callers retain the original direct protocol', () => {
  const parent = new Port(),
    incoming: unknown[] = []
  const service = createServicePort({ parent, peerMode: false })
  service.on('message', (message) => incoming.push(message))
  service.postMessage({ kind: 'ready' })
  parent.emit('message', { data: { kind: 'request' } })
  assert.deepEqual(parent.sent, [{ kind: 'ready' }])
  assert.deepEqual(incoming, [{ kind: 'request' }])
})
test('lease connection buffers only unsent messages; detach never replays a sent write', () => {
  const sent: CoreChildMessage[] = [],
    replies: unknown[] = []
  const launcher = new CoreServiceLauncher('epoch', (message) => sent.push(message))
  const lease = launcher.launch('database')
  lease.on('message', (message) => replies.push(message))
  const request = { kind: 'call', requestId: 'write', method: 'patchTracks', args: [] }
  lease.postMessage(request)
  const port = new Port()
  launcher.handle({ kind: 'core:service-connected', leaseId: lease.id }, [port])
  assert.deepEqual(port.sent, [request])
  port.emit('message', { data: { kind: 'response', requestId: 'write', ok: true } })
  assert.equal(replies.length, 1)
  launcher.handle({ kind: 'core:service-exit', leaseId: lease.id, code: 1 })
  const other = new Port()
  launcher.handle({ kind: 'core:service-connected', leaseId: lease.id }, [other])
  assert.equal(other.closed, true)
  assert.equal(other.sent.length, 0)
  assert.throws(() => lease.postMessage(request), /closed/)
  launcher.destroy()
})
