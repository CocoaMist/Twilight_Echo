import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreMusicExplorationService } from './explorationService.ts'
import type {
  MusicExplorationDatabaseApi,
  MusicExplorationState,
  MusicExplorationToken,
  MusicExplorationPage
} from '../../shared/musicExploration.ts'
import { coreOperation, isCoreRequest } from '../../shared/coreProtocol.ts'
const state = (): MusicExplorationState => ({
  revision: 1,
  catalogRevision: 2,
  contentRevision: 3,
  metadataRevision: 4
})
const token = (context: Record<string, string> = {}): MusicExplorationToken => ({
  ...state(),
  contextKey: JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))),
  asOf: 100,
  expiresAt: null
})
function fixture() {
  let context: Record<string, string> = { stream: 'account-1' },
    now = 101,
    changes = 0,
    release: ((value: MusicExplorationPage) => void) | null = null
  let seen: unknown,
    reply = token(context)
  const database = {
    explorationQuery: async (q: unknown, c: unknown) => {
      seen = { q, c }
      return { token: reply, items: [], total: 0, offset: 0 }
    },
    explorationDetail: async () => ({
      token: reply,
      entity: null,
      references: [],
      referencesTruncated: false,
      providerTruncated: false
    }),
    explorationLookup: async () => ({
      token: reply,
      entity: null,
      references: [],
      referencesTruncated: false,
      providerTruncated: false
    }),
    explorationRelations: async () => ({
      token: reply,
      items: [],
      offset: 0,
      total: 0,
      providerTruncated: false
    }),
    explorationParticipation: async () => ({
      token: reply,
      items: [],
      offset: 0,
      total: 0,
      providerTruncated: false
    }),
    explorationPerformanceSave: async () => ({
      token: reply,
      entity: null,
      references: [],
      referencesTruncated: false,
      providerTruncated: false
    }),
    explorationPerformanceDelete: async () => true,
    explorationState: async () => state()
  } as unknown as MusicExplorationDatabaseApi
  const service = new CoreMusicExplorationService({
    database,
    platformContexts: () => context,
    now: () => now,
    changed: () => {
      changes++
    }
  })
  return {
    service,
    database,
    setContext: (value: Record<string, string>) => {
      context = value
    },
    setNow: (value: number) => {
      now = value
    },
    setToken: (value: MusicExplorationToken) => {
      reply = value
    },
    get seen() {
      return seen
    },
    get changes() {
      return changes
    },
    defer() {
      database.explorationQuery = async () =>
        new Promise((resolve) => {
          release = resolve
        })
    },
    resolve() {
      release!({ token: reply, items: [], offset: 0, total: 0 })
    }
  }
}
test('exploration service injects actual account context and observes only four durable numeric revisions', async () => {
  const f = fixture()
  assert.equal(f.service.getRevision(), null)
  const page = await f.service.query({ scope: 'library', limit: 10 })
  assert.deepEqual(f.seen, {
    q: { scope: 'library', limit: 10 },
    c: { platformContexts: { stream: 'account-1' } }
  })
  assert.equal(f.service.getRevision(), 1)
  assert.equal(f.changes, 1)
  f.service.observe(page.token)
  assert.equal(f.changes, 1)
  f.setToken({ ...page.token, asOf: 102 })
  await f.service.query({})
  assert.equal(f.changes, 1)
  f.service.observe({ ...state(), revision: 3 })
  assert.equal(f.changes, 2)
  f.service.observe({ ...state(), revision: 2 })
  assert.equal(f.service.getRevision(), 3)
})
test('exploration service rejects account switch and newly observed durable changes while a read is in flight', async () => {
  const f = fixture()
  f.defer()
  const pending = f.service.query({})
  f.setContext({ stream: 'account-2' })
  f.resolve()
  await assert.rejects(pending, { code: 'STALE_REVISION' })
  const g = fixture()
  g.defer()
  const second = g.service.query({})
  g.service.observe({ ...state(), metadataRevision: 5 })
  g.resolve()
  await assert.rejects(second, { code: 'STALE_REVISION' })
})
test('exploration service rejects wrong context or expired reply and accepts first valid newer DB revision', async () => {
  const f = fixture()
  f.setToken(token({ stream: 'forged' }))
  await assert.rejects(f.service.query({}), { code: 'STALE_REVISION' })
  const g = fixture()
  g.setToken({ ...token({ stream: 'account-1' }), expiresAt: 105 })
  g.setNow(105)
  await assert.rejects(g.service.detail({ entityId: 'entity' }), { code: 'STALE_REVISION' })
  const h = fixture()
  h.setToken({ ...token({ stream: 'account-1' }), revision: 8 })
  await h.service.lookup({
    reference: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: 'exact' }
  })
  assert.equal(h.service.getRevision(), 8)
})
test('exploration performance writes are independent of provider authorization and update durable observation', async () => {
  const f = fixture()
  f.setToken({ ...token(), revision: 5 })
  await f.service.performanceSave({
    title: 'Concert',
    workId: 'work',
    recordingIds: ['recording'],
    revision: 1
  })
  assert.equal(f.service.getRevision(), 5)
  assert.equal(await f.service.performanceDelete({ id: 'performance', revision: 5 }), true)
})
test('Core exploration public contract has bounded read/write permissions and excludes ingest/history/context authority', () => {
  const request = (name: string, payload: unknown, kind = 'query') => ({
    name,
    payload,
    kind,
    requestId: 'request:1',
    epoch: 'core:1'
  })
  const reads = {
    'exploration.query': { scope: 'catalog', kinds: ['artist', 'work'], limit: 100 },
    'exploration.lookup': {
      reference: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: 'exact-id' }
    },
    'exploration.detail': { entityId: 'exact' },
    'exploration.relations': { entityId: 'exact', roles: ['composer'] },
    'exploration.participation': { entityId: 'exact', roles: ['composer'] }
  }
  for (const [name, payload] of Object.entries(reads)) {
    assert.equal(isCoreRequest(request(name, payload)), true, name)
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:read'
    )
    assert.equal(isCoreRequest(request(name, { ...payload, platformContexts: {} })), false)
    assert.equal(isCoreRequest(request(name, { ...payload, profileId: 'other' })), false)
  }
  for (const [name, payload] of Object.entries({
    'exploration.performance.save': {
      title: 'Concert',
      workId: 'w',
      recordingIds: ['r'],
      revision: 0
    },
    'exploration.performance.delete': { id: 'p', revision: 0 }
  })) {
    assert.equal(isCoreRequest(request(name, payload, 'command')), true, name)
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:write'
    )
  }
  assert.equal(isCoreRequest(request('exploration.query', { limit: 101 })), false)
  for (const name of [
    'exploration.ingest',
    'exploration.syncCredits',
    'exploration.backfillCredits',
    'exploration.state'
  ])
    assert.equal(isCoreRequest(request(name, {})), false)
  assert.equal(isCoreRequest(request('exploration.lookup', { name: 'Same Name' })), false)
})
