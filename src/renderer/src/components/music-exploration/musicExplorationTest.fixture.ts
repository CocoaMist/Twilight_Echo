import type { MusicExplorationApi } from './musicExplorationView.ts'
import type { MusicExplorationItem, MusicExplorationRelationItem, MusicExplorationToken, MusicExplorationReference, MusicExplorationPerformanceSave, MusicExplorationPerformanceDelete } from '../../../../shared/musicExploration.ts'

export const explorationItem = (id: string, kind: MusicExplorationItem['kind'] = 'recording', title = id): MusicExplorationItem => ({ id, kind, title, artist: 'Artist', inLibrary: true, sourceCount: 1 })
export const explorationEdge = (from: MusicExplorationItem, to: MusicExplorationItem, order = 0, origin: 'manual' | 'provider' = 'provider'): MusicExplorationRelationItem => ({
  entity: to, relation: { id: `${from.id}:${to.id}:${order}`, kind: from.kind === 'work' ? to.kind === 'performance' ? 'work_performance' : 'work_recording' : from.kind === 'performance' ? 'performance_recording' : 'credit',
    from, to, order, origin, attribution: { provider: 'mb', externalId: 'relation', url: 'https://musicbrainz.org', license: 'CC0', licenseUrl: '', attribution: 'MusicBrainz', revision: '1', retrievedAt: 100 },
    ...(from.kind === 'artist' ? { credit: { personRef: { provider: 'mb', kind: 'artist' as const, idType: 'mbid', value: from.id }, targetRef: { provider: 'mb', kind: 'recording' as const, idType: 'mbid', value: to.id }, name: from.title,
      role: 'composer' as const, rawRole: 'composer', relationTypeId: 'composer', direction: 'backward' as const, order, joinphrase: ' & ', attributes: [{ name: 'instrument', value: 'piano' }], begin: '', end: '', attribution: { provider: 'mb', externalId: 'relation', url: '', license: 'CC0', licenseUrl: '', attribution: 'MusicBrainz', revision: '1', retrievedAt: 100 } } } : {}) }
})
export function explorationFixture() {
  let token: MusicExplorationToken = { revision: 1, catalogRevision: 1, contentRevision: 1, metadataRevision: 1, contextKey: '[]', asOf: Date.now(), expiresAt: null }
  const work = explorationItem('work', 'work', 'Symphony'), person = explorationItem('person', 'artist', 'Same Name'), other = explorationItem('other-person', 'artist', 'Same Name')
  const entities = new Map<string, MusicExplorationItem>([work, person, other, ...Array.from({ length: 14 }, (_, i) => explorationItem(`recording-${i + 1}`, 'recording', `Movement ${i + 1}`))].map(item => [item.id, item]))
  const edges: MusicExplorationRelationItem[] = [explorationEdge(work, entities.get('recording-1')!), ...Array.from({ length: 14 }, (_, i) => explorationEdge(person, entities.get(`recording-${i + 1}`)!, i))]
  const calls: Array<{ name: string; query: any; signal?: AbortSignal }> = [], writes: Array<{ name: string; query: MusicExplorationPerformanceSave | MusicExplorationPerformanceDelete }> = []
  let failure: Error | null = null, mixed = false
  const fence = (expected: MusicExplorationToken | undefined) => { if (expected && JSON.stringify(expected) !== JSON.stringify(token)) throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' }) }
  const relationPage = (query: Parameters<MusicExplorationApi['relations']>[0], signal: AbortSignal) => {
    fence(query.token); signal.throwIfAborted()
    let selected = edges.flatMap(item => {
      const match = query.direction === 'outgoing' ? item.relation.from.id === query.entityId : query.direction === 'incoming' ? item.relation.to.id === query.entityId : [item.relation.from.id, item.relation.to.id].includes(query.entityId)
      if (!match || (query.roles?.length && (!item.relation.credit || !query.roles.includes(item.relation.credit.role))) || (query.relations?.length && !query.relations.includes(item.relation.kind))) return []
      const entity = item.relation.to.id === query.entityId ? entities.get(item.relation.from.id)! : item.entity
      return [{ ...item, entity }]
    })
    if (query.scope !== 'catalog') selected = selected.filter(item => item.entity.inLibrary)
    const offset = query.offset ?? 0
    return { token: mixed ? { ...token, revision: token.revision + 1 } : token, offset, total: selected.length, items: selected.slice(offset, offset + (query.limit ?? 12)), providerTruncated: false }
  }
  const detail = (id: string) => ({ token, entity: entities.get(id) ?? null, references: [] as MusicExplorationReference[], referencesTruncated: false, providerTruncated: false })
  const api: MusicExplorationApi = {
    async detail(query, signal) { calls.push({ name: 'detail', query, signal }); fence(query.token); signal.throwIfAborted(); return detail(query.entityId) },
    async lookup(query, signal) { calls.push({ name: 'lookup', query, signal }); fence(query.token); signal.throwIfAborted(); return detail(query.reference.value) },
    async query(query, signal) { calls.push({ name: 'query', query, signal }); fence(query.token); signal.throwIfAborted(); const selected = [...entities.values()].filter(item => (!query.kinds || query.kinds.includes(item.kind)) && (query.scope === 'catalog' || item.inLibrary) && item.title.includes(query.search ?? '')); const offset = query.offset ?? 0; return { token, offset, total: selected.length, items: selected.slice(offset, offset + (query.limit ?? 12)) } },
    async relations(query, signal) { calls.push({ name: 'relations', query, signal }); return relationPage(query, signal) },
    async participation(query, signal) { calls.push({ name: 'participation', query, signal }); return relationPage({ ...query, direction: 'outgoing', relations: ['credit'] }, signal) },
    async save(query) {
      writes.push({ name: 'save', query: structuredClone(query) }); if (failure) throw failure
      const id = query.id ?? 'new-performance'; const performance = explorationItem(id, 'performance', query.title)
      entities.set(id, performance)
      const remove = edges.filter(item => item.relation.from.id === id || item.relation.to.id === id)
      for (const item of remove) edges.splice(edges.indexOf(item), 1)
      edges.push(explorationEdge(entities.get(query.workId)!, performance, 0, 'manual'), ...query.recordingIds.map((recording, i) => explorationEdge(performance, entities.get(recording)!, i, 'manual')))
      token = { ...token, revision: token.revision + 1, catalogRevision: token.catalogRevision + 1 }; return detail(id)
    },
    async delete(query) { writes.push({ name: 'delete', query: structuredClone(query) }); if (failure) throw failure; const remove = edges.filter(item => item.relation.from.id === query.id || item.relation.to.id === query.id); for (const item of remove) edges.splice(edges.indexOf(item), 1); token = { ...token, revision: token.revision + 1 }; return true }
  }
  return { api, calls, writes, entities, edges, token: () => token, detail,
    fail: (error = new Error('lost reply')) => { failure = error }, mixTokens: () => { mixed = true },
    bump: () => { token = { ...token, revision: token.revision + 1 } } }
}
