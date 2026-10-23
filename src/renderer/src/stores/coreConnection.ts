import { readonly, shallowReadonly, shallowRef } from 'vue'
import type {
  CoreBridgeApi,
  CoreBridgeReply,
  CoreBridgeMessage,
  CoreBridgeStatus
} from '../../../shared/coreBridge.ts'
import type {
  CoreClientMessage,
  CoreCommandName,
  CoreCommands,
  CoreQueries,
  CoreQueryName,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../../shared/coreProtocol.ts'
import { CoreProjection, type CoreConnection } from './coreProjection.ts'

function unwrap<T>(reply: CoreBridgeReply<T>): T {
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
  return reply.value
}

/** A document owns only a connection. Reattachment never repeats a business command. */
export class CoreWindowConnection implements CoreConnection {
  private readonly api: CoreBridgeApi
  private id: string | null = null
  private connecting: Promise<CoreSnapshot> | null = null
  private disposed = false
  private readonly listeners = new Set<(message: CoreClientMessage) => void>()
  private queued: CoreBridgeMessage | null = null
  private queuedStatus: CoreBridgeStatus | null = null
  private readonly disposeMessage: () => void
  private readonly disposeStatus: () => void
  private readonly changedStatus: (status: CoreBridgeStatus) => void
  constructor(api: CoreBridgeApi, changedStatus: (status: CoreBridgeStatus) => void = () => {}) {
    this.api = api
    this.changedStatus = changedStatus
    this.disposeMessage = api.onMessage((event) => {
      if (this.disposed) return
      if (this.connecting && event.message.kind === 'state') {
        this.queued = event
        return
      }
      this.receive(event)
    })
    this.disposeStatus = api.onStatus((event) => {
      if (this.connecting) {
        this.queuedStatus = event
        return
      }
      if (!this.disposed && event.connectionId === this.id) this.changedStatus(event)
    })
  }
  private receive(event: CoreBridgeMessage): void {
    if (event.connectionId !== this.id) return
    for (const listener of this.listeners) listener(event.message)
  }
  connect(): Promise<CoreSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Core connection was disposed'))
    if (this.connecting) return this.connecting
    const work = this.api
      .connect(this.id ?? undefined)
      .then((reply) => {
        const connected = unwrap(reply)
        if (this.disposed) {
          void this.api.disconnect(connected.connectionId).catch(() => {})
          throw new Error('Core connection was disposed')
        }
        this.id = connected.connectionId
        this.changedStatus({
          connectionId: this.id,
          phase: connected.snapshot.phase,
          epoch: connected.snapshot.epoch
        })
        return connected.snapshot
      })
      .finally(() => {
        if (this.connecting !== work) return
        this.connecting = null
        const queued = this.queued
        const queuedStatus = this.queuedStatus
        this.queued = null
        this.queuedStatus = null
        if (queued && !this.disposed) this.receive(queued)
        if (queuedStatus && !this.disposed && queuedStatus.connectionId === this.id)
          this.changedStatus(queuedStatus)
      })
    this.connecting = work
    return work
  }
  async request(request: CoreRequestEnvelope, signal?: AbortSignal): Promise<unknown> {
    const id = this.id
    if (!id || this.disposed) throw new Error('Core connection is not attached')
    if (signal?.aborted)
      throw Object.assign(new Error('Core request was cancelled'), { code: 'CANCELLED' })
    const cancel = () => {
      void this.api.cancel(id, request.requestId).catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      return unwrap(await this.api.request(id, request))
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  subscribe(listener: (message: CoreClientMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeMessage()
    this.disposeStatus()
    this.listeners.clear()
    this.queued = null
    this.queuedStatus = null
    if (this.id) void this.api.disconnect(this.id).catch(() => {})
    this.id = null
  }
}

export function createCoreConnectionStore(api: CoreBridgeApi) {
  const state = shallowRef<CoreSnapshot | null>(null)
  const failure = shallowRef<Error | null>(null)
  const status = shallowRef<CoreBridgeStatus | null>(null)
  const connection = new CoreWindowConnection(api, (value) => {
    status.value = value
  })
  const projection = new CoreProjection(
    connection,
    (value) => {
      state.value = value
      failure.value = null
    },
    undefined,
    (error) => {
      failure.value = error
    }
  )
  return {
    state: shallowReadonly(state),
    failure: readonly(failure),
    status: readonly(status),
    attach: () => projection.attach(),
    refresh: () => projection.refresh(),
    subscribe: (listener: (message: CoreClientMessage) => void) => connection.subscribe(listener),
    command: <K extends CoreCommandName>(name: K, payload: CoreCommands[K], signal?: AbortSignal) =>
      projection.command(name, payload, signal),
    query: <K extends CoreQueryName>(
      name: K,
      payload: CoreQueries[K]['input'],
      signal?: AbortSignal
    ) => projection.query(name, payload, signal),
    dispose: () => {
      projection.dispose()
      connection.dispose()
      state.value = null
    }
  }
}

let singleton: ReturnType<typeof createCoreConnectionStore> | null = null
/** Staged consumer entry point: merely importing this module does not attach or start Core. */
export function useCoreConnection() {
  return (singleton ??= createCoreConnectionStore(window.api.core))
}
export function disposeCoreConnection(): void {
  singleton?.dispose()
  singleton = null
}
if (import.meta.hot) import.meta.hot.dispose(disposeCoreConnection)
