import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { CoreServiceKind } from '../../shared/coreProtocol.ts'
import type { CoreChildMessage, CoreParentMessage } from '../../shared/coreProcessProtocol.ts'
import type { ServiceMessagePort } from '../services/servicePort.ts'

/** Existing service clients retain their own timeouts, scheduling and crash rules. */
export class CoreServiceLease extends EventEmitter {
  private port: ServiceMessagePort | null = null
  private pending: unknown[] = []
  private closed = false
  private readonly exitBarrier: Promise<void>
  private exited!: () => void
  private terminating = false
  readonly id: string
  private readonly closeLease: () => void
  constructor(id: string, closeLease: () => void) {
    super()
    this.id = id
    this.closeLease = closeLease
    this.exitBarrier = new Promise((resolve) => {
      this.exited = resolve
    })
  }
  postMessage(message: unknown): void {
    if (this.closed) throw new Error('Core service lease is closed; write outcome may be unknown')
    if (this.port) this.port.postMessage(message)
    else {
      if (this.pending.length >= 128) throw new Error('Core service connection queue is full')
      this.pending.push(message)
    }
  }
  attach(port: ServiceMessagePort): void {
    if (this.closed || this.port) {
      port.close?.()
      return
    }
    this.port = port
    port.on('message', (event) => {
      if (!this.closed) this.emit('message', event.data)
    })
    port.start?.()
    // Only unsent requests are buffered. Sent writes are never replayed.
    for (const request of this.pending.splice(0)) port.postMessage(request)
  }
  fail(code: number | null, error?: string): void {
    if (this.closed) return
    this.closed = true
    this.pending = []
    this.port?.close?.()
    this.port = null
    // Existing clients all listen for exit. Avoid EventEmitter's unhandled error semantics.
    if (error && this.listenerCount('error')) this.emit('error', new Error(error))
    this.emit('exit', code)
  }
  kill(): void {
    if (this.closed) return
    this.terminating = true
    this.closeLease()
    this.fail(null)
  }
  /** Resource cleanup must wait for the real process, not a closed port. */
  terminate(): Promise<void> {
    if (!this.terminating) {
      this.terminating = true
      this.closeLease()
      this.fail(null)
    }
    return this.exitBarrier
  }
  confirmExit(code: number | null, error?: string): void {
    this.fail(code, error)
    this.exited()
  }
}

export class CoreServiceLauncher {
  private readonly leases = new Map<string, CoreServiceLease>()
  private readonly epoch: string
  private readonly send: (message: CoreChildMessage) => void
  constructor(epoch: string, send: (message: CoreChildMessage) => void) {
    this.epoch = epoch
    this.send = send
  }
  launch(service: CoreServiceKind): CoreServiceLease {
    const id = randomUUID()
    const lease = new CoreServiceLease(id, () => {
      this.send({ kind: 'core:service-close', epoch: this.epoch, leaseId: id })
    })
    this.leases.set(id, lease)
    this.send({ kind: 'core:service-open', epoch: this.epoch, leaseId: id, service })
    return lease
  }
  handle(message: CoreParentMessage, ports: ServiceMessagePort[] = []): void {
    if (message.kind === 'core:service-connected') {
      const lease = this.leases.get(message.leaseId)
      if (lease && ports.length === 1) lease.attach(ports[0])
      else {
        for (const port of ports) port.close?.()
        lease?.fail(null, 'Missing service MessagePort')
      }
    } else if (message.kind === 'core:service-exit' || message.kind === 'core:service-error') {
      const lease = this.leases.get(message.leaseId)
      if (message.kind === 'core:service-exit') {
        this.leases.delete(message.leaseId)
        lease?.confirmExit(message.code, message.error)
      } else lease?.fail(null, message.error)
    }
  }
  destroy(): void {
    for (const lease of [...this.leases.values()]) lease.kill()
    this.leases.clear()
  }
}
