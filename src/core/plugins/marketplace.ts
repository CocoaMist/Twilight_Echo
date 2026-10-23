import { PluginIndexService, type PluginIndexServiceOptions } from './indexService.ts'
import type { TwilightPluginManager } from './manager.ts'

/** Market metadata and installs share the same manager as the running plugin hosts. */
export class CorePluginMarketplace {
  private readonly index: PluginIndexService
  private readonly plugins: Pick<TwilightPluginManager, 'list' | 'installFromPath'>
  constructor(
    options: PluginIndexServiceOptions,
    plugins: Pick<TwilightPluginManager, 'list' | 'installFromPath'>
  ) {
    this.index = new PluginIndexService(options)
    this.plugins = plugins
  }
  async list(refresh = false) {
    const [entries, installed] = await Promise.all([
      refresh ? this.index.refresh() : this.index.list(),
      this.plugins.list()
    ])
    return entries.map((entry) => ({
      ...entry,
      installState: this.index.describeInstallState(entry, installed),
      installedVersion: installed.find((plugin) => plugin.id === entry.id)?.version
    }))
  }
  status() {
    return this.index.getStatus()
  }
  async install(id: string) {
    const downloaded = await this.index.downloadPackage(id)
    try {
      return await this.plugins.installFromPath(downloaded.packagePath, {
        source: 'index',
        sourceLabel: downloaded.entry.sourceUrl,
        evidence: downloaded.evidence
      })
    } finally {
      await downloaded.cleanup()
    }
  }
}
