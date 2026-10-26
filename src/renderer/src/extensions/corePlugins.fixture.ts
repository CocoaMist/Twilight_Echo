import { useCoreConnection } from '../stores/coreConnection.ts'
import type { CoreBridgeApi, CoreBridgeMessage } from '../../../shared/coreBridge.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'

/** Reuses appearance fixtures' scenario data through the real Core projection adapter. */
export function installCorePluginFixture() {
  const plugins = window.api.plugins
  const extensions = window.api.extensions
  const listeners = new Set<(message: CoreBridgeMessage) => void>()
  let snapshot = {
    protocolVersion: 1,
    epoch: 'appearance-plugins',
    sequence: 0,
    phase: 'ready',
    pluginsRevision: 0
  } as CoreSnapshot
  const api: CoreBridgeApi = {
    connect: async () => ({ ok: true, value: { connectionId: 'appearance', snapshot } }),
    request: async (_id, request) => {
      let value: unknown
      switch (request.name) {
        case 'plugins.list':
          value = (await plugins.list?.()) ?? []
          break
        case 'plugins.index.list':
          value = (await plugins.listIndex?.()) ?? []
          break
        case 'plugins.index.refresh':
          value = (await plugins.refreshIndex?.()) ?? []
          break
        case 'plugins.index.status':
          value = (await plugins.getIndexStatus?.()) ?? {}
          break
        case 'plugins.index.install':
          value = await plugins.installFromIndex(request.payload.id)
          break
        case 'plugins.enable':
          value = await plugins.enable(request.payload.id)
          break
        case 'plugins.disable':
          value = await plugins.disable(request.payload.id)
          break
        case 'plugins.uninstall':
          value = await plugins.uninstall(request.payload.id)
          break
        case 'extensions.list':
          value = (await extensions?.list?.()) ?? []
          break
        case 'extensions.experiences':
          value = (await extensions?.experiences?.()) ?? []
          break
        default:
          throw new Error(`Unexpected appearance fixture Core operation: ${request.name}`)
      }
      return { ok: true, value }
    },
    cancel: async () => ({ ok: true, value: undefined }),
    disconnect: async () => ({ ok: true, value: undefined }),
    onMessage: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onStatus: () => () => {}
  }
  window.api.core = api
  plugins.onChanged?.(() => {
    snapshot = {
      ...snapshot,
      sequence: snapshot.sequence + 1,
      pluginsRevision: (snapshot.pluginsRevision ?? 0) + 1
    }
    for (const listener of listeners)
      listener({
        connectionId: 'appearance',
        message: { kind: 'state', epoch: snapshot.epoch, sequence: snapshot.sequence, snapshot }
      })
  })
  return useCoreConnection().attach()
}
