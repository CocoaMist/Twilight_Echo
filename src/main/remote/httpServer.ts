import { app } from 'electron'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import {
  RemoteHttpServer as PortableRemoteHttpServer,
  type RemoteHttpServerOptions as PortableOptions
} from '../../core/cast/httpServer.ts'
export * from '../../core/cast/httpServer.ts'
export type RemoteHttpServerOptions = Partial<Pick<PortableOptions, 'staticRoot' | 'addresses'>> &
  Omit<PortableOptions, 'staticRoot' | 'addresses'>

/** Preserve the existing platform defaults until the production Core cutover. */
export class RemoteHttpServer extends PortableRemoteHttpServer {
  constructor(options: RemoteHttpServerOptions = {}) {
    super({
      ...options,
      staticRoot:
        options.staticRoot ??
        (app.isPackaged
          ? join(process.resourcesPath, 'remote')
          : join(app.getAppPath(), 'resources', 'remote')),
      addresses:
        options.addresses ??
        (() =>
          Object.values(networkInterfaces()).flatMap((entries) =>
            (entries ?? [])
              .filter((entry) => !entry.internal && ['IPv4', '4'].includes(String(entry.family)))
              .map((entry) => entry.address)
          ))
    })
  }
}
