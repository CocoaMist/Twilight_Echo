import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreGenresService } from './genresService.ts'
import { coreOperation, isCoreRequest } from '../../shared/coreProtocol.ts'
import type { GenreDatabaseApi } from '../../shared/musicGenres.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('classification browse injects current private platform context without starting maintenance', async () => {
  const calls: unknown[] = []
  let account = 'account:one', advances = 0
  const service = new CoreGenresService({
    database: {
      genresAdvance: async () => { advances++; return { revision: 1, processed: 0, pending: false } },
      genresBrowse: async (...args) => { calls.push(args); return { items: [], token: { metadataRevision: 2 } } },
      genresMembers: async (...args) => { calls.push(args); return { items: [], token: { metadataRevision: 2 } } },
      genresFacets: async (...args) => { calls.push(args); return { items: [], token: { metadataRevision: 2 } } }
    } as unknown as GenreDatabaseApi & import('../../shared/musicGenreBrowse.ts').GenreBrowseDatabaseApi,
    platformContexts: () => ({ ncm: account }), separators: () => ';', changed() {}, failed(error) { throw error }
  })
  await service.browse({ kind: 'recording', source: 'local' })
  account = 'account:two'
  await service.members({ entityId: 'entity:one' })
  await service.facets({ kind: 'release', dimension: 'region' })
  assert.deepEqual(calls, [
    [{ kind: 'recording', source: 'local' }, { platformContexts: { ncm: 'account:one' } }],
    [{ entityId: 'entity:one' }, { platformContexts: { ncm: 'account:two' } }],
    [{ kind: 'release', dimension: 'region' }, { platformContexts: { ncm: 'account:two' } }]
  ])
  assert.equal(advances, 0)
  assert.equal(service.getMetadataRevision(), 2)
  await service.shutdown()
})

test('classification maintenance is bounded, observes current separators and yields between batches', async () => {
  const calls: Array<[number | undefined, string | undefined]> = []
  let separators = ';',
    yields = 0,
    changed = 0
  const service = new CoreGenresService({
    database: {
      genresAdvance: async (limit, value) => {
        calls.push([limit, value])
        return { revision: calls.length, processed: 200, pending: calls.length < 3 }
      }
    } as GenreDatabaseApi,
    separators: () => separators,
    yield: async () => {
      yields++
      separators = '/'
    },
    changed: () => {
      changed++
    },
    failed: (error) => {
      throw error
    }
  })
  service.activate()
  for (let i = 0; i < 10 && calls.length < 3; i++) await tick()
  await service.shutdown()
  assert.deepEqual(calls, [
    [200, ';'],
    [200, '/'],
    [200, '/']
  ])
  assert.equal(yields, 2)
  assert.equal(service.getRevision(), 3)
  assert.equal(changed, 3)
})

test('classification reads do not authorize maintenance and writes publish repository revisions', async () => {
  let advances = 0,
    changed = 0
  const tree = { revision: 4, total: 0, items: [], offset: 0, dictionaryVersion: 1 }
  const service = new CoreGenresService({
    database: {
      genresTree: async () => tree,
      genresAdvance: async () => {
        advances++
        return { revision: 5, processed: 0, pending: false }
      },
      genresEdit: async () => ({ revision: 5, genreId: 'new' })
    } as unknown as GenreDatabaseApi,
    separators: () => ',',
    changed: () => {
      changed++
    },
    failed: (error) => {
      throw error
    }
  })
  assert.deepEqual(await service.tree({}), tree)
  assert.equal(advances, 0)
  await service.edit({ action: 'create', revision: 4, name: '实验', nameEn: 'Experimental' })
  assert.equal(service.getRevision(), 5)
  assert.equal(changed, 1)
  service.observe(5)
  assert.equal(changed, 1)
  await service.shutdown()
})

test('failed maintenance waits for new invalidation; shutdown joins the active batch without draining', async () => {
  let calls = 0,
    errors = 0,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new CoreGenresService({
    database: {
      genresAdvance: async () => {
        calls++
        if (calls === 1) throw new Error('worker unavailable')
        await gate
        return { revision: 2, processed: 200, pending: true }
      }
    } as GenreDatabaseApi,
    separators: () => ',',
    changed() {},
    failed() {
      errors++
    }
  })
  service.activate()
  await tick()
  await tick()
  assert.equal(calls, 1)
  assert.equal(errors, 1)
  service.invalidate()
  await tick()
  const shutdown = service.shutdown()
  release()
  await shutdown
  assert.equal(calls, 2)
  service.invalidate()
  await tick()
  assert.equal(calls, 2)
})

test('classification operations have library permissions and strict transport validation', () => {
  for (const name of ['genres.tree', 'genres.unmapped', 'genres.evidence', 'genres.browse', 'genres.members', 'genres.facets'] as const)
    assert.deepEqual(coreOperation(name), { kind: 'query', permission: 'library:read' })
  for (const name of ['genres.edit', 'genres.map', 'genres.override'] as const)
    assert.deepEqual(coreOperation(name), { kind: 'command', permission: 'library:write' })
  const request = {
    requestId: 'genres',
    epoch: 'core',
    kind: 'command',
    name: 'genres.override',
    payload: { target: { kind: 'source', id: 'exact' }, revision: 1, genreIds: [] }
  }
  assert.equal(isCoreRequest(request), true)
  assert.equal(isCoreRequest({ ...request, kind: 'query' }), false)
  assert.equal(
    isCoreRequest({
      ...request,
      payload: { ...request.payload, providerUrl: 'https://example.com' }
    }),
    false
  )
  assert.equal(isCoreRequest({ ...request, payload: { ...request.payload, revision: -1 } }), false)
})
