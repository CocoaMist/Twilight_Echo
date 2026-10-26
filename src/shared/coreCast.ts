/** Device endpoints and media tokens are private Core transport data. */
export interface CoreCastDevice {
  id: string
  protocol: 'dlna' | 'chromecast'
  name: string
  manufacturer: string
  model: string
}

export interface CoreCastState {
  revision: number
  target: CoreCastDevice | null
  phase: 'idle' | 'selected' | 'loading' | 'ready' | 'failed'
  error: string | null
}

export interface CoreCastStart {
  revision: number
  deviceId: string
  queue: { id: string; revision: number; occurrenceId: string }
}

/** Private output-stop lease. Never accepted by the public Core command API. */
export type CoreCastSafetyTarget =
  | { deviceId: string; protocol: 'dlna'; controlUrl: string }
  | {
      deviceId: string
      protocol: 'chromecast'
      host: string
      port: number
      receiverSessionId: string
    }
