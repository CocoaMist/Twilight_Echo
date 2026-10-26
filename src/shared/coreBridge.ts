import type {
  CoreClientMessage,
  CoreFailure,
  CorePhase,
  CoreRequestEnvelope,
  CoreSnapshot
} from './coreProtocol.ts'

export const CORE_WINDOW_IPC = {
  connect: 'core-window:connect',
  request: 'core-window:request',
  cancel: 'core-window:cancel',
  disconnect: 'core-window:disconnect',
  message: 'core-window:message',
  status: 'core-window:status'
} as const

export type CoreBridgeReply<T> = { ok: true; value: T } | { ok: false; error: CoreFailure }
export interface CoreBridgeConnected {
  connectionId: string
  snapshot: CoreSnapshot
}
export interface CoreBridgeMessage {
  connectionId: string
  message: CoreClientMessage
}
export interface CoreBridgeStatus {
  connectionId: string
  phase: CorePhase
  epoch: string | null
}

/** Only finite Core DTOs cross preload; identity and permissions stay in main. */
export interface CoreBridgeApi {
  connect(connectionId?: string): Promise<CoreBridgeReply<CoreBridgeConnected>>
  request(connectionId: string, request: CoreRequestEnvelope): Promise<CoreBridgeReply<unknown>>
  cancel(connectionId: string, requestId: string): Promise<CoreBridgeReply<void>>
  disconnect(connectionId: string): Promise<CoreBridgeReply<void>>
  onMessage(listener: (event: CoreBridgeMessage) => void): () => void
  onStatus(listener: (event: CoreBridgeStatus) => void): () => void
}
