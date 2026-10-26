import type { MusicPreferencesDatabaseApi, MusicPreferencesSet, MusicPreferencesTargetsQuery, MusicPreferencesHistoryQuery } from '../../shared/musicPreferences.ts'

interface Options { database: MusicPreferencesDatabaseApi; now(): number; changed(): void | Promise<void> }
/** Local preferences never call a platform's account like/unlike endpoint. */
export class CoreMusicPreferencesService {
  private readonly options: Options
  private revision: number | null = null
  private refreshed: Promise<void> = Promise.resolve()
  constructor(options: Options) { this.options = options }
  getRevision() { return this.revision }
  observe(revision: number) { if (this.revision !== revision) { this.revision = revision; this.refreshed = Promise.resolve(this.options.changed()); void this.refreshed.catch(() => undefined) } }
  async detail(entityId: string) { const value = await this.options.database.preferencesDetail(entityId); this.observe(value.token.preferencesRevision); await this.refreshed; return value }
  async set(request: MusicPreferencesSet) { const value = await this.options.database.preferencesSet(request, this.options.now()); this.observe(value.token.preferencesRevision); await this.refreshed; return value }
  targets(query: MusicPreferencesTargetsQuery) { return this.options.database.preferencesTargets(query) }
  history(query: MusicPreferencesHistoryQuery) { return this.options.database.preferencesHistory(query) }
}
