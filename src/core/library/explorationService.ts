import type {
  MusicExplorationDatabaseApi, MusicExplorationState, MusicExplorationToken,
  MusicExplorationQuery, MusicExplorationDetailQuery, MusicExplorationRelationsQuery,
  MusicExplorationParticipationQuery, MusicExplorationPerformanceSave, MusicExplorationPerformanceDelete
} from '../../shared/musicExploration.ts'

interface Options {
  database: MusicExplorationDatabaseApi
  platformContexts(): Record<string, string>
  now(): number
  changed(): void
}
const stateKeys = ['revision', 'catalogRevision', 'contentRevision', 'metadataRevision'] as const
const key = (contexts: Record<string, string>) => JSON.stringify(Object.entries(contexts)
  .filter(([, value]) => !!value).sort(([a], [b]) => a.localeCompare(b)))
const stale = () => Object.assign(new Error('人物作品或资料权限已变化，请刷新后重试'), { code: 'STALE_REVISION' })

/** The database owns exact identities; Core supplies the actual account context. */
export class CoreMusicExplorationService {
  private current: MusicExplorationState | null = null
  private readonly options: Options
  constructor(options: Options) { this.options = options }
  getRevision() { return this.current?.revision ?? null }
  getCatalogRevision() { return this.current?.catalogRevision ?? null }
  observe(state: MusicExplorationState) {
    if (this.current && stateKeys.every(k => this.current![k] >= state[k])) return
    this.current = Object.fromEntries(stateKeys.map(k => [k, Math.max(state[k], this.current?.[k] ?? 0)])) as unknown as MusicExplorationState
    this.options.changed()
  }
  private async read<T extends { token: MusicExplorationToken }>(action: (context: { platformContexts: Record<string, string> }) => Promise<T>): Promise<T> {
    const contexts = { ...this.options.platformContexts() }
    const result = await action({ platformContexts: contexts })
    if (key(contexts) !== key(this.options.platformContexts()) || result.token.contextKey !== key(contexts) ||
      (result.token.expiresAt !== null && this.options.now() >= result.token.expiresAt) ||
      (this.current && stateKeys.some(k => result.token[k] < this.current![k]))) throw stale()
    this.observe(result.token)
    return result
  }
  query(query: MusicExplorationQuery) { return this.read(c => this.options.database.explorationQuery(query, c)) }
  lookup(query: import('../../shared/musicExploration.ts').MusicExplorationLookupQuery) { return this.read(c => this.options.database.explorationLookup(query, c)) }
  detail(query: MusicExplorationDetailQuery) { return this.read(c => this.options.database.explorationDetail(query, c)) }
  relations(query: MusicExplorationRelationsQuery) { return this.read(c => this.options.database.explorationRelations(query, c)) }
  participation(query: MusicExplorationParticipationQuery) { return this.read(c => this.options.database.explorationParticipation(query, c)) }
  async performanceSave(request: MusicExplorationPerformanceSave) {
    const result = await this.options.database.explorationPerformanceSave(request)
    this.observe(result.token)
    return result
  }
  async performanceDelete(request: MusicExplorationPerformanceDelete) {
    const result = await this.options.database.explorationPerformanceDelete(request)
    this.observe(await this.options.database.explorationState())
    return result
  }
}
