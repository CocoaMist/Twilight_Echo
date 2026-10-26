import type { EventEmitter } from 'node:events'
import type {
  TwilightMediaProviderMethod,
  TwilightPluginInstallEvidence,
  TwilightPluginManifest
} from './types.ts'

/** The manager owns plugin state; main only starts the registered host and shows UI. */
export interface PluginHostProcess extends EventEmitter {
  postMessage(message: unknown): void
  kill(): unknown
  terminate?(): Promise<void>
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
}

export interface PluginManagerPlatform {
  userData: string
  launchHost(pluginId: string): PluginHostProcess
  prepareDisable?(id: string): Promise<void>
  chooseInstallSource(kind: 'package' | 'directory'): Promise<string | null>
  confirmInstall(
    manifest: TwilightPluginManifest,
    evidence: TwilightPluginInstallEvidence
  ): Promise<boolean>
  showLog(path: string): Promise<void> | void
  notifyStateIssue(type: 'warning' | 'error', detail: string): Promise<void>
  log(
    pluginId: string,
    level: string,
    message: string
  ): {
    timestamp: string
    eventId: string
    text: string
  }
  protectProviderResult(
    value: unknown,
    method: TwilightMediaProviderMethod
  ): Promise<unknown> | unknown
}
