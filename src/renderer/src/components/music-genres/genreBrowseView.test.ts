import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenreBrowseView, GENRE_BROWSE_PAGE_SIZE } from './genreBrowseView.ts'
import type {
  GenreBrowseItem,
  GenreBrowseMember,
  GenreBrowseQuery,
  GenreBrowseToken,
  GenreMembersQuery
} from '../../../../shared/musicGenreBrowse.ts'
import type { GenreEvidenceQuery, GenreOverride } from '../../../../shared/musicGenres.ts'
import type {
  UnifiedPlaybackRequest,
  UnifiedPlaybackResult
} from '../../../../shared/musicUnifiedPlayback.ts'

const token: GenreBrowseToken = {
  genresRevision: 3,
  catalogRevision: 5,
  contentRevision: 7,
  metadataRevision: 2,
  asOf: 100,
  expiresAt: null,
  contextKey: 'one'
}
const summary = {
  items: [{ id: 'jazz', name: '爵士', nameEn: 'Jazz' }],
  total: 1,
  truncated: false
}
const entity: GenreBrowseItem = {
  id: 'release-one',
  kind: 'release',
  title: '专辑',
  artist: '艺人',
  identity: 'manual',
  sourceCount: 2,
  genres: summary,
  classification: 'from-tracks'
}
const member = (sourceId = 'local-one'): GenreBrowseMember => ({
  sourceId,
  provider: sourceId === 'local-one' ? 'local' : 'fixture',
  title: '歌曲',
  artist: '艺人',
  availability: 'indexed',
  sourceTarget: { kind: 'source', id: sourceId },
  collectionTarget: { kind: 'collection', id: 'precise-album-id' },
  sourceClassification: { genres: summary, origin: 'source' },
  collectionClassification: { genres: { items: [], total: 0, truncated: false }, origin: 'none' }
})
async function fixture(
  options: Partial<GenreBrowseToken> = {},
  unified?: (request: UnifiedPlaybackRequest, signal: AbortSignal) => Promise<UnifiedPlaybackResult>
) {
  const reads: GenreBrowseQuery[] = [],
    memberReads: GenreMembersQuery[] = [],
    evidenceReads: GenreEvidenceQuery[] = [],
    facetReads: any[] = [],
    writes: GenreOverride[] = [],
    plays: Array<[string, number]> = []
  let current = { ...token, ...options },
    conflict = false,
    playbackFails = false,
    changes = 0
  const view = createGenreBrowseView({
    tree: async (query) => ({
      revision: current.genresRevision,
      dictionaryVersion: 1,
      offset: query.offset ?? 0,
      total: 21,
      items: [
        {
          id: 'jazz',
          name: '爵士',
          nameEn: 'Jazz',
          parentId: null,
          dictionaryVersion: 1,
          userModified: false,
          ancestorIds: [],
          childCount: 1
        }
      ]
    }),
    browse: async (query) => {
      reads.push(query)
      if (conflict) throw new Error('SNAPSHOT_EXPIRED')
      return {
        token: { ...current },
        offset: query.offset ?? 0,
        total: 21,
        items: [entity],
        providers: ['local', 'fixture']
      }
    },
    members: async (query) => {
      memberReads.push(query)
      return {
        token: { ...current },
        offset: query.offset ?? 0,
        total: 21,
        entity,
        items: [member(), member('cloud-one')]
      }
    },
    evidence: async (query) => {
      evidenceReads.push(query)
      return {
        revision: current.genresRevision,
        offset: query.offset ?? 0,
        total: 21,
        selection: {
          target: query.target,
          revision: current.genresRevision,
          genreIds: ['jazz'],
          override: null,
          origin: 'source'
        },
        items: []
      }
    },
    facets: async (query) => {
      facetReads.push(query)
      return {
        token: { ...current },
        dimension: query.dimension,
        available: true,
        reason: null,
        offset: query.offset ?? 0,
        total: 21,
        items: [
          { value: query.offset ? '32' : '24', label: query.offset ? '32-bit' : '24-bit', count: 1 }
        ]
      }
    },
    override: async (query) => {
      writes.push(query)
      if (conflict) throw new Error('REVISION_CONFLICT')
      current = { ...current, genresRevision: current.genresRevision + 1 }
      return {
        target: query.target,
        revision: current.genresRevision,
        genreIds: query.genreIds ?? ['jazz'],
        override: query.genreIds,
        origin: query.genreIds === null ? 'source' : 'manual'
      }
    },
    changed: () => {
      changes++
    },
    playUnified: unified,
    play: async (sourceId, revision) => {
      plays.push([sourceId, revision])
      if (playbackFails) throw new Error('UNAVAILABLE')
    }
  })
  await view.refresh()
  return {
    view,
    reads,
    memberReads,
    evidenceReads,
    facetReads,
    writes,
    plays,
    changes: () => changes,
    conflict: (next: boolean) => {
      conflict = next
    },
    playbackFails: () => {
      playbackFails = true
    },
    changeContext: () => {
      current = { ...current, contextKey: 'two' }
    }
  }
}

test('genre browser uses stable IDs with independent descendants/provider filters and bounded deduplicated pages', async () => {
  const f = await fixture(),
    view = f.view
  assert.equal(f.reads.length, 1)
  assert.deepEqual(f.reads[0], { kind: 'recording', offset: 0, limit: GENRE_BROWSE_PAGE_SIZE })
  assert.equal(view.state.value.selectedEntity, null)
  assert.equal(f.memberReads.length + f.plays.length, 0)
  await view.selectGenre({ id: 'jazz', name: '爵士' })
  await view.setFilters({ kind: 'release', source: 'local', includeDescendants: true })
  await view.page(20)
  assert.deepEqual(f.reads.at(-1), {
    kind: 'release',
    genreId: 'jazz',
    includeDescendants: true,
    source: 'local',
    offset: 20,
    limit: 20,
    token
  })
  assert.equal(view.state.value.page?.total, 21)
  assert.equal(f.plays.length, 0)
  view.dispose()
})

test('members and evidence use the same token and require explicit entity and exact target choices', async () => {
  const f = await fixture(),
    view = f.view
  await view.selectEntity(entity)
  assert.equal(f.plays.length, 0)
  await view.membersPage(20)
  assert.equal(f.memberReads.at(-1)?.token?.contextKey, 'one')
  await view.showEvidence(
    { ...member(), collectionTarget: { kind: 'collection', id: 'stale-other-album' } },
    true
  )
  assert.deepEqual(f.evidenceReads.at(-1), {
    target: { kind: 'collection', id: 'precise-album-id' },
    revision: 3,
    offset: 0,
    limit: 20
  })
  await view.evidencePage(20)
  assert.equal(f.evidenceReads.at(-1)?.offset, 20)
  await view.play(member('not-a-real-member'))
  assert.equal(f.plays.length, 0)
  await view.play(member('cloud-one'))
  assert.deepEqual(f.plays, [['cloud-one', 5]])
  view.dispose()
})

test('unified genre playback carries the entire frozen scope and keeps explicit playback separate', async () => {
  const requests: UnifiedPlaybackRequest[] = []
  const f = await fixture({}, async (request) => {
    requests.push(request)
    return {
      status: 'played',
      requestedSourceId: request.sourceId,
      sourceId: 'cloud-one',
      versionId: 'version',
      attempts: [
        {
          sourceId: 'cloud-one',
          provider: 'fixture',
          status: 'selected',
          code: null,
          message: null
        }
      ]
    }
  })
  await f.view.selectGenre({ id: 'jazz', name: '爵士' })
  await f.view.setFilters({ source: 'local', kind: 'release', includeDescendants: true })
  await f.view.chooseDimension('bitDepth')
  f.view.toggleFacet('24')
  await f.view.applyFacets()
  await f.view.selectEntity(entity)
  f.view.setProviderPreference('streaming')
  await f.view.playUnified(member())
  assert.deepEqual(requests[0], {
    sourceId: 'local-one',
    revision: 5,
    providerOrder: ['fixture'],
    scope: {
      entityId: entity.id,
      genreId: 'jazz',
      includeDescendants: true,
      source: 'local',
      filters: [{ dimension: 'bitDepth', values: ['24'] }],
      token
    }
  })
  assert.equal(f.view.state.value.unifiedResult?.sourceId, 'cloud-one')
  assert.equal(f.plays.length, 0)
  await f.view.play(member())
  assert.deepEqual(f.plays, [['local-one', 5]])
  assert.equal(f.view.state.value.unifiedResult, null)
  f.view.dispose()
})

test('late unified playback replies cannot repopulate an invalidated genre scope', async () => {
  let finish!: (value: UnifiedPlaybackResult) => void
  let signal!: AbortSignal
  const f = await fixture({}, (_request, current) => {
    signal = current
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  await f.view.selectEntity(entity)
  const playing = f.view.playUnified(member())
  f.view.invalidate()
  assert.equal(signal.aborted, true)
  finish({
    status: 'unavailable',
    requestedSourceId: 'local-one',
    sourceId: null,
    versionId: null,
    attempts: []
  })
  await playing
  assert.equal(f.view.state.value.unifiedResult, null)
  assert.equal(f.view.state.value.playingId, null)
  assert.equal(f.view.state.value.blocked, true)
  f.view.dispose()
})

test('exact-source playback failure does not automatically play another source', async () => {
  const f = await fixture()
  await f.view.selectEntity(entity)
  f.playbackFails()
  await f.view.play(member())
  assert.deepEqual(f.plays, [['local-one', 5]])
  assert.match(f.view.state.value.playError, /UNAVAILABLE/)
  f.view.dispose()
})

test('source-specific manual multi-value, explicit empty, and reset preserve their distinct contracts', async () => {
  const f = await fixture(),
    view = f.view
  await view.selectEntity(entity)
  await view.showEvidence(member())
  view.addGenre({ id: 'rock', name: '摇滚' })
  await view.saveOverride()
  assert.deepEqual(f.writes[0], {
    target: { kind: 'source', id: 'local-one' },
    revision: 3,
    genreIds: ['jazz', 'rock']
  })
  await view.clearOverride()
  assert.deepEqual(f.writes[1].genreIds, [])
  await view.resetOverride()
  assert.equal(f.writes[2].genreIds, null)
  assert.equal(f.changes(), 3)
  assert.equal(view.state.value.evidenceTarget?.id, 'local-one')
  view.dispose()
})

test('snapshot/context conflicts retain selection and draft, block actions, and require explicit reread', async () => {
  const f = await fixture(),
    view = f.view
  await view.selectGenre({ id: 'jazz', name: '爵士' })
  await view.selectEntity(entity)
  await view.showEvidence(member())
  view.addGenre({ id: 'rock', name: '摇滚' })
  f.conflict(true)
  await view.saveOverride()
  assert.equal(view.ready.value, false)
  assert.equal(view.state.value.selectedGenre?.id, 'jazz')
  assert.equal(view.state.value.selectedEntity?.id, entity.id)
  assert.deepEqual(view.state.value.draftGenreIds, ['jazz', 'rock'])
  await view.play(member())
  assert.equal(f.plays.length, 0)
  f.conflict(false)
  await view.refresh()
  assert.equal(view.ready.value, true)
  assert.deepEqual(view.state.value.draftGenreIds, ['jazz', 'rock'])
  f.changeContext()
  await view.page(20)
  assert.equal(view.state.value.blocked, true)
  assert.match(view.state.value.error, /分类或音乐库已变化/)
  view.dispose()
})

test('late old-scope responses cannot refill the new browser state', async () => {
  let resolve: (value: any) => void = () => {}
  let calls = 0
  const view = createGenreBrowseView({
    tree: async () => ({ revision: 3, dictionaryVersion: 1, offset: 0, total: 0, items: [] }),
    browse: async () =>
      ++calls === 1
        ? new Promise((done) => {
            resolve = done
          })
        : { token, offset: 0, total: 0, items: [], providers: [] },
    members: async () => {
      throw new Error('not called')
    },
    evidence: async () => {
      throw new Error('not called')
    },
    facets: async () => {
      throw new Error('not called')
    },
    override: async () => {
      throw new Error('not called')
    },
    changed() {},
    play: async () => {}
  })
  view.setScope('old')
  view.setScope('new')
  await new Promise((done) => setImmediate(done))
  resolve({
    token: { ...token, contextKey: 'old' },
    offset: 0,
    total: 1,
    items: [entity],
    providers: ['old']
  })
  await new Promise((done) => setImmediate(done))
  assert.equal(view.state.value.page?.total, 0)
  assert.equal(view.state.value.token?.contextKey, 'one')
  view.dispose()
})

test('facet multi-selection survives paging and applies the complete set to list and member queries', async () => {
  const f = await fixture(),
    view = f.view
  await view.chooseDimension('bitDepth')
  view.toggleFacet('24')
  await view.facetsPage(20)
  view.toggleFacet('32')
  assert.deepEqual(view.state.value.facetDraft, ['24', '32'])
  await view.applyFacets()
  assert.deepEqual(f.reads.at(-1)?.filters, [{ dimension: 'bitDepth', values: ['24', '32'] }])
  assert.deepEqual(f.facetReads.at(-1).filters, [{ dimension: 'bitDepth', values: ['24', '32'] }])
  await view.selectEntity(entity)
  assert.deepEqual(f.memberReads.at(-1)?.filters, [{ dimension: 'bitDepth', values: ['24', '32'] }])
  await view.removeFilter('bitDepth')
  assert.equal(f.reads.at(-1)?.filters, undefined)
  assert.deepEqual(view.state.value.facetDraft, [])
  view.dispose()
})

test('facts expiring while the browser is idle hide results and counts but preserve selections and manual drafts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const f = await fixture({ asOf: 1000, expiresAt: 1010 }),
    view = f.view
  await view.chooseDimension('bitDepth')
  view.toggleFacet('24')
  await view.selectEntity(entity)
  await view.showEvidence(member())
  view.addGenre({ id: 'rock', name: '摇滚' })
  const reads = f.reads.length
  t.mock.timers.tick(11)
  assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.facets, null)
  assert.equal(view.state.value.members, null)
  assert.equal(view.state.value.evidence, null)
  assert.equal(view.state.value.selectedEntity?.id, entity.id)
  assert.deepEqual(view.state.value.facetDraft, ['24'])
  assert.deepEqual(view.state.value.draftGenreIds, ['jazz', 'rock'])
  assert.equal(f.reads.length, reads)
  view.dispose()
})
