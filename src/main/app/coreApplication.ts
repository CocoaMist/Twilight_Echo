import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import {
  coreOperation,
  type CoreCommands,
  type CoreQueries,
  type CoreClientMessage,
  type CoreRequestEnvelope,
  type CoreSnapshot
} from '../../shared/coreProtocol.ts'
import type { CoreSupervisor } from '../coreProcess/supervisor.ts'
import {
  CORE_WINDOW_POLICIES,
  type CoreWindowBridge,
  type CoreWindowPolicy
} from '../coreProcess/windowBridge.ts'
import type { CoreSettingsBridge } from '../coreProcess/settingsBridge.ts'
import type { CoreSystemPlayerBridge } from '../coreProcess/systemPlayerBridge.ts'

type Operation = keyof CoreCommands | keyof CoreQueries
type Input<K extends Operation> = K extends keyof CoreCommands
  ? CoreCommands[K]
  : K extends keyof CoreQueries
    ? CoreQueries[K]['input']
    : never
type Output<K extends Operation> = K extends keyof CoreQueries ? CoreQueries[K]['output'] : unknown
export interface CoreApplicationOptions {
  supervisor: Pick<
    CoreSupervisor,
    | 'start'
    | 'shutdown'
    | 'retry'
    | 'getStatus'
    | 'connect'
    | 'disconnect'
    | 'request'
    | 'on'
    | 'off'
  >
  windows: Pick<CoreWindowBridge, 'register' | 'dispose'>
  settings: Pick<CoreSettingsBridge, 'flush'>
  system: Pick<CoreSystemPlayerBridge, 'update' | 'invalidate'>
}

/** One application-owned connection. Window replacement never changes Core ownership. */
export class CoreApplicationRuntime {
  private readonly clientId = `system:${randomUUID()}`
  private readonly options: CoreApplicationOptions
  private latest: CoreSnapshot | null = null
  constructor(options: CoreApplicationOptions) {
    this.options = options
    options.supervisor.on('client-message', this.message)
    options.supervisor.on('status', this.status)
    options.supervisor.connect({
      id: this.clientId,
      role: 'desktop',
      permissions: [...CORE_WINDOW_POLICIES.desktop.permissions, 'plugins:resources']
    })
  }
  start(): Promise<void> {
    return this.options.supervisor.start()
  }
  retry(): Promise<void> {
    return this.options.supervisor.retry()
  }
  snapshot(): CoreSnapshot | null {
    return this.latest
  }
  register(window: BrowserWindow, policy: CoreWindowPolicy = CORE_WINDOW_POLICIES.desktop): void {
    this.options.windows.register(window.webContents, policy)
  }
  request<K extends Operation>(
    name: K,
    payload: Input<K>,
    signal?: AbortSignal
  ): Promise<Output<K>> {
    const epoch = this.options.supervisor.getStatus().epoch
    if (!epoch)
      return Promise.reject(
        Object.assign(new Error('Music Core is not ready'), { code: 'NOT_READY' })
      )
    const operation = coreOperation(name)!
    return this.options.supervisor.request(
      this.clientId,
      {
        kind: operation.kind,
        name,
        payload,
        epoch,
        requestId: randomUUID()
      } as CoreRequestEnvelope,
      signal
    ) as Promise<Output<K>>
  }
  private readonly message = (id: string, message: CoreClientMessage): void => {
    if (id !== this.clientId || message.kind !== 'state') return
    this.latest = message.snapshot
    this.options.system.update(message.snapshot)
  }
  private readonly status = (status: { phase: string }): void => {
    if (status.phase === 'ready') return
    this.latest = null
    this.options.system.invalidate()
  }
  async flush(): Promise<void> {
    await this.options.settings.flush()
    await this.request('lifecycle.flush', {})
  }
  async shutdown(): Promise<void> {
    await this.options.settings.flush()
    await this.options.supervisor.shutdown()
    this.options.windows.dispose()
    this.options.supervisor.off('client-message', this.message)
    this.options.supervisor.off('status', this.status)
    this.options.supervisor.disconnect(this.clientId)
    this.latest = null
    this.options.system.invalidate()
  }
}

let installed: CoreApplicationRuntime | null = null
export const getCoreApplication = (): CoreApplicationRuntime | null => installed
export function installCoreApplication(application: CoreApplicationRuntime): void {
  installed = application
}
