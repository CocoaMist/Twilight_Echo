/**
 * Cast backend abstraction (DLNA / Chromecast).
 * Media URLs must already be LAN-reachable token URLs from RemoteHttpServer.
 */

export type CastProtocol = 'dlna' | 'chromecast'

export interface CastDevice {
  /** Stable id for IPC (DLNA USN or chromecast:<host>:<port>). */
  id: string
  protocol: CastProtocol
  friendlyName: string
  manufacturer: string
  modelName: string
  /** DLNA: description URL; Chromecast: cast host:port */
  location: string
  /** DLNA-only control endpoints (null for Chromecast). */
  avTransportUrl: string | null
  renderingControlUrl: string | null
  /** Chromecast host (IPv4). */
  host?: string
  port?: number
  lastSeenAt: number
}

export interface CastLoadRequest {
  deviceId: string
  mediaUrl: string
  title?: string
  artist?: string
  album?: string
  contentType?: string
  positionSeconds?: number
  autoplay?: boolean
}

export interface CastBackend {
  readonly protocol: CastProtocol
  discover(timeoutMs?: number): Promise<CastDevice[]>
  load(request: CastLoadRequest, device: CastDevice): Promise<void>
  play(device: CastDevice): Promise<void>
  pause(device: CastDevice): Promise<void>
  stop(device: CastDevice): Promise<void>
  seek(device: CastDevice, positionSeconds: number): Promise<void>
  setVolume(device: CastDevice, volume0to1: number): Promise<void>
}

export interface CastSample {
  state: 'stopped' | 'playing' | 'paused'
  position: number
  duration: number
  volume?: number
  buffering?: boolean
  ended?: boolean
}
