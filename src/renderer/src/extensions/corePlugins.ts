import { watch } from 'vue'
import { useCoreConnection } from '../stores/coreConnection.ts'
import type {
  TwilightPluginIndexEntry,
  TwilightPluginInstallResult
} from '../../../shared/pluginTypes.ts'

/** UI adapter only. Plugin hosts, installs and the market cache belong to Core. */
export const corePlugins = {
  list: () => useCoreConnection().query('plugins.list', {}),
  listIndex: () => useCoreConnection().query('plugins.index.list', {}),
  refreshIndex: () =>
    useCoreConnection().command('plugins.index.refresh', {}) as Promise<TwilightPluginIndexEntry[]>,
  getIndexStatus: () => useCoreConnection().query('plugins.index.status', {}),
  enable: (id: string) => useCoreConnection().command('plugins.enable', { id }),
  disable: (id: string) => useCoreConnection().command('plugins.disable', { id }),
  uninstall: (id: string, options?: { removeData?: boolean }) =>
    useCoreConnection().command('plugins.uninstall', { id, ...options }),
  chooseAndInstall: (kind: 'package' | 'directory') =>
    useCoreConnection().command('plugins.install', {
      kind
    }) as Promise<TwilightPluginInstallResult | null>,
  installFromIndex: (id: string) =>
    useCoreConnection().command('plugins.index.install', {
      id
    }) as Promise<TwilightPluginInstallResult | null>,
  openLog: (id: string) => useCoreConnection().command('plugins.showLog', { id }),
  onChanged: (listener: () => void) => {
    const core = useCoreConnection()
    return watch(() => [core.state.value?.epoch, core.state.value?.pluginsRevision], listener)
  }
}

export const executeCoreExtension = (command: string, args: unknown[] = []) =>
  useCoreConnection().command('extensions.execute', { command, args })
