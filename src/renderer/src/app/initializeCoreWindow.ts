import type { createCoreConnectionStore } from '../stores/coreConnection.ts'
import type { CoreMigrationStatus } from '../../../shared/coreState.ts'
import { migrateBrowserMusicData, openBrowserMusicMigrationSource } from './browserCoreMigration.ts'

/** The normal window performs the legacy import once, then only attaches views. */
export async function initializeCoreWindow(core: ReturnType<typeof createCoreConnectionStore>) {
  const snapshot = await core.attach()
  if (snapshot.migrationRequired) {
    await migrateBrowserMusicData({
      api: {
        coreStateStatus: () => core.query('migration.status', {}),
        coreMigrationBegin: async (id, manifest) =>
          await core.command('migration.begin', { id, manifest }) as CoreMigrationStatus,
        coreMigrationStage: async (id, batch, domain, rows) =>
          await core.command('migration.stage', { id, batch, domain, rows }) as CoreMigrationStatus,
        coreMigrationCommit: async (id) =>
          await core.command('migration.commit', { id }) as CoreMigrationStatus
      },
      storage: localStorage,
      freezeBusinessWrites() {
        // Core rejects business mutations until atomic publication; this window has no legacy writers.
      },
      source: () => openBrowserMusicMigrationSource(localStorage, indexedDB),
      newId: () => crypto.randomUUID()
    })
  }
  return core.refresh()
}
