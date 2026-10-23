/** Electron parent/MessagePort adapters live outside the portable business Core. */
export interface ServiceMessagePort {
  postMessage(message: unknown): void
  on(
    event: 'message',
    listener: (event: { data: unknown; ports?: ServiceMessagePort[] }) => void
  ): unknown
  start?(): void
  close?(): void
}
export interface ServicePort<Incoming, Outgoing> {
  postMessage(message: Outgoing): void
  on(event: 'message', listener: (message: Incoming) => void): void
}

/**
 * The main-owned attachment is one-shot. In peer mode no business messages pass
 * through main; startup replies wait for the transferred port. Main retains only
 * a separate, narrow supervision lane (used to silence audio after Core failure).
 */
export function createServicePort<Incoming, Outgoing>(
  options: {
    parent?: ServiceMessagePort
    peerMode?: boolean
    node?: {
      send(message: unknown): void
      on(event: 'message', listener: (message: unknown) => void): void
    }
    supervise?: (message: unknown, reply: (message: unknown) => void) => void
  } = {}
): ServicePort<Incoming, Outgoing> {
  const parent =
    options.parent ?? (process as unknown as { parentPort?: ServiceMessagePort }).parentPort
  const node =
    options.node ??
    (process.send
      ? {
          send: (message: unknown) => process.send?.(message),
          on: (event: 'message', listener: (message: unknown) => void) =>
            process.on(event, listener)
        }
      : undefined)
  if (!parent && !node) throw new Error('Service requires an Electron parent port or Node IPC')
  const peerMode = options.peerMode ?? process.argv.includes('--twilight-core-service')
  let peer: ServiceMessagePort | undefined
  const startup: Outgoing[] = []
  const listeners: ((message: Incoming) => void)[] = []
  const dispatch = (message: unknown) => {
    for (const listener of listeners) listener(message as Incoming)
  }
  const parentPost = (message: unknown) =>
    parent ? parent.postMessage(message) : node!.send(message)
  if (parent)
    parent.on('message', (event) => {
      const message = event.data as { kind?: string } | null
      if (message?.kind === 'core:attach-service') {
        if (!peerMode || peer || event.ports?.length !== 1) return
        peer = event.ports[0]
        peer.on('message', (event) => dispatch(event.data))
        peer.start?.()
        for (const reply of startup.splice(0)) peer.postMessage(reply)
        return
      }
      if (message?.kind === 'supervisor:stop-audio') {
        options.supervise?.(message, parentPost)
        return
      }
      if (!peerMode) dispatch(event.data)
    })
  else node!.on('message', dispatch)
  return {
    postMessage(message) {
      if (peer) peer.postMessage(message)
      else if (!peerMode) parentPost(message)
      else {
        if (startup.length >= 8) throw new Error('Service startup reply buffer is full')
        startup.push(message)
      }
    },
    on(_, listener) {
      listeners.push(listener)
    }
  }
}
