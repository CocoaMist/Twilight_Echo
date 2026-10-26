import type { AppSettings, SettingsSnapshot } from '../../shared/appSettings.ts'
import type { CoreSettingsEdit, CoreSettingsState } from '../../shared/coreSettings.ts'
import type { CoreSettingsBackupImport } from '../../shared/coreSettingsBackup.ts'
import type { CoreThemeOperations } from '../../shared/coreThemes.ts'

export interface CoreSettingsAdapterOperations extends CoreThemeOperations {
  'settings.state': { input: Record<string, never>; output: CoreSettingsState }
  'settings.edit': { input: CoreSettingsEdit; output: CoreSettingsState }
  'settings.backup': { input: Record<string, never>; output: string }
  'settings.restore': { input: CoreSettingsBackupImport; output: CoreSettingsState }
  'cache.info': { input: Record<string, never>; output: { sizeBytes: number } }
  'cache.clear': { input: Record<string, never>; output: unknown }
}
export interface CoreSettingsTransport {
  request<K extends keyof CoreSettingsAdapterOperations>(
    name: K,
    payload: CoreSettingsAdapterOperations[K]['input']
  ): Promise<CoreSettingsAdapterOperations[K]['output']>
  project(state: CoreSettingsState): void
  snapshot(): SettingsSnapshot
}

export class CoreSettingsBridge {
  private pending: Promise<unknown> = Promise.resolve()
  readonly transport: CoreSettingsTransport
  constructor(transport: CoreSettingsTransport) {
    this.transport = transport
  }
  request<K extends keyof CoreSettingsAdapterOperations>(
    name: K,
    payload: CoreSettingsAdapterOperations[K]['input']
  ) {
    return this.transport.request(name, payload)
  }
  async get(): Promise<SettingsSnapshot> {
    this.transport.project(await this.request('settings.state', {}))
    return this.transport.snapshot()
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.pending.then(action)
    this.pending = work.catch(() => {})
    return work
  }
  update(
    patch: Partial<AppSettings> | ((settings: AppSettings) => Partial<AppSettings>)
  ): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      const current = await this.request('settings.state', {})
      const value = typeof patch === 'function' ? patch(current.settings) : patch
      const state = await this.request('settings.edit', {
        revision: current.revision,
        patch: value
      })
      this.transport.project(state)
      return this.transport.snapshot()
    })
  }
  restore(json: string): Promise<SettingsSnapshot> {
    return this.enqueue(async () => {
      const current = await this.request('settings.state', {})
      const state = await this.request('settings.restore', { revision: current.revision, json })
      this.transport.project(state)
      return this.transport.snapshot()
    })
  }
  async flush(): Promise<void> {
    await this.pending
  }
}

let installed: CoreSettingsBridge | null = null
/** Explicit production cutover only; no environment flag or fallback when Core is unavailable. */
export function installCoreSettingsBridge(transport: CoreSettingsTransport): CoreSettingsBridge {
  installed = new CoreSettingsBridge(transport)
  return installed
}
export function getCoreSettingsBridge(): CoreSettingsBridge | null {
  return installed
}
export function assertLegacySettingsWriter(): void {
  if (installed) throw new Error('Settings are owned by Music Core')
}
