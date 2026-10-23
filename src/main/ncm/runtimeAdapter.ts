import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from 'undici'
import { NcmApiService, NCM_API_HOST } from '../../core/providers/ncmApi.ts'

/** Node/package adapter shared by the legacy main entry and the utility Core. */
export function createNcmApiRuntime(): NcmApiService {
  const agent = new Agent({
    connections: 8,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000
  })
  return new NcmApiService({
    startServer: async () => {
      const tokenPath = join(tmpdir(), 'anonymous_token')
      if (!existsSync(tokenPath)) writeFileSync(tokenPath, '', 'utf8')
      const { serveNcmApi } = await import('@neteasecloudmusicapienhanced/api/server.js')
      const api = await serveNcmApi({
        // The package treats numeric zero as absent; a string requests an OS-assigned port.
        port: '0' as unknown as number,
        host: NCM_API_HOST,
        checkVersion: false
      })
      if (!api.server) throw new Error('NetEase API server did not return a listener')
      return api.server
    },
    fetch: (url, init) => fetch(url, { ...init, dispatcher: agent } as RequestInit),
    closeTransport: () => agent.close()
  })
}
