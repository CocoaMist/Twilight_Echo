import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import {
  createPersonalRatingsView,
  observePersonalRatingsView,
  type PersonalRatingsApi
} from './personalRatingsView.ts'
import { createTrackRatingsView } from './trackRatingsView.ts'
import { createRatingTargetsView } from './ratingTargetsView.ts'
import type { MusicRatingsDetail } from '../../../../shared/musicRatings.ts'
import type { CatalogPage } from '../../../../shared/musicCatalog.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const detail = (entityId = 'one', steps: number | null = 7, revision = 1): MusicRatingsDetail => ({
  entityId,
  kind: 'recording',
  scope: 'entity',
  value: { steps, revision, updatedAt: 100 },
  token: { ratingsRevision: revision, linkRevision: 0, targetKey: `entity:${entityId}` }
})
function fixture(extra: Partial<PersonalRatingsApi> = {}) {
  const requests: unknown[] = []
  let saved = detail()
  const view = createPersonalRatingsView({
    detail: async () => saved,
    set: async (request) => {
      requests.push(request)
      saved = detail(request.entityId, request.steps, saved.token.ratingsRevision + 1)
      return saved
    },
    history: async (query) => ({
      entityId: query.entityId,
      kind: 'recording',
      scope: 'entity',
      offset: query.offset ?? 0,
      total: 1,
      items: [{ ...saved.value!, seq: 1, reason: 'set' }]
    }),
    ...extra
  })
  return { view, requests }
}

test('half-star drafts remain distinct from saved receipts; save and explicit clear use the read token', async (t) => {
  const { view, requests } = fixture()
  t.after(view.dispose)
  await view.setContext('one', 'scope')
  view.choose(0)
  view.choose(11)
  view.choose(1.5)
  assert.equal(view.state.value.draft, undefined)
  view.choose(9)
  assert.equal(view.state.value.detail!.value!.steps, 7)
  assert.equal(view.state.value.draft, 9)
  assert.equal(view.state.value.notice, '')
  await view.save()
  assert.deepEqual(requests[0], { entityId: 'one', token: detail().token, steps: 9 })
  assert.equal(view.state.value.detail!.value!.steps, 9)
  assert.equal(view.state.value.draft, undefined)
  assert.match(view.state.value.notice, /已保存/)
  await view.clear()
  assert.equal(view.state.value.detail!.value!.steps, null)
  assert.equal((requests[1] as { steps: unknown }).steps, null)
  assert.match(view.state.value.notice, /已清除/)
})

test('failed and stale writes keep the draft and withdraw old saved values without replay', async (t) => {
  for (const error of [
    new Error('lost receipt'),
    Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
  ]) {
    let writes = 0
    const { view } = fixture({
      set: async () => {
        writes++
        throw error
      }
    })
    t.after(view.dispose)
    await view.setContext('one', '')
    view.choose(10)
    await view.save()
    await view.save()
    assert.equal(writes, 1)
    assert.equal(view.state.value.draft, 10)
    assert.equal(view.state.value.detail, null)
    assert.equal(view.state.value.blocked, true)
    assert.equal(view.state.value.notice, '')
    await view.refresh()
    assert.equal(view.state.value.draft, 10)
    assert.equal(view.state.value.detail!.value!.steps, 7)
  }
})

test('domain changes withdraw detail and history, preserve drafts, and require explicit rereading', async (t) => {
  let reads = 0
  const { view } = fixture({
    detail: async () => {
      reads++
      return detail()
    }
  })
  t.after(view.dispose)
  const snapshot = shallowRef({
    epoch: 'one',
    ratingsRevision: 1,
    entityMetadataRevision: 1,
    catalogRevision: 1,
    libraryRevision: 1,
    sequence: 0
  })
  const stop = observePersonalRatingsView(view, {
    entityId: () => 'one',
    scope: () => '',
    snapshot: () => snapshot.value
  })
  t.after(stop)
  await new Promise<void>((r) => setImmediate(r))
  view.choose(10)
  await view.toggleHistory()
  for (const field of [
    'ratingsRevision',
    'entityMetadataRevision',
    'catalogRevision',
    'libraryRevision',
    'epoch'
  ] as const) {
    snapshot.value = { ...snapshot.value, [field]: field === 'epoch' ? 'two' : 2 }
    assert.equal(view.state.value.detail, null)
    assert.equal(view.state.value.history, null)
    assert.equal(view.state.value.draft, 10)
    assert.equal(view.canSave.value, false)
    const previous = reads
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(reads, previous, 'changes never silently rebase the saved receipt')
    await view.refresh()
  }
  const previous = reads
  snapshot.value = { ...snapshot.value, sequence: 5 }
  assert.equal(reads, previous)
  assert.notEqual(view.state.value.detail, null)
})

test('a revision pushed by own successful write can reconcile once; old-context receipt cannot change a new page', async (t) => {
  const pending = deferred<MusicRatingsDetail>()
  const { view } = fixture({ set: () => pending.promise, detail: async (id) => detail(id) })
  t.after(view.dispose)
  await view.setContext('one', '')
  view.choose(9)
  const write = view.save()
  view.invalidate()
  pending.resolve(detail('one', 9, 2))
  await write
  assert.notEqual(view.state.value.detail, null)
  assert.match(view.state.value.notice, /已保存/)
  const late = deferred<MusicRatingsDetail>()
  const other = fixture({ set: () => late.promise, detail: async (id) => detail(id) }).view
  t.after(other.dispose)
  await other.setContext('one', '')
  other.choose(9)
  const old = other.save()
  await other.setContext('two', '')
  late.resolve(detail('one', 9, 2))
  await old
  assert.equal(other.state.value.detail!.entityId, 'two')
  assert.equal(other.state.value.notice, '')
})

test('late reads and history cannot republish withdrawn ratings; history is lazy and bounded', async (t) => {
  const old = deferred<MusicRatingsDetail>(),
    history = deferred<any>()
  const queries: unknown[] = []
  const { view } = fixture({
    detail: async (id) => (id === 'old' ? old.promise : detail(id)),
    history: async (query) => {
      queries.push(query)
      return history.promise
    }
  })
  t.after(view.dispose)
  const first = view.setContext('old', '')
  await view.setContext('one', '')
  old.resolve(detail('old'))
  await first
  assert.equal(view.state.value.detail!.entityId, 'one')
  assert.equal(queries.length, 0)
  const read = view.toggleHistory()
  assert.deepEqual(queries, [{ entityId: 'one', offset: 0, limit: 6 }])
  view.invalidate()
  history.resolve({
    entityId: 'one',
    kind: 'recording',
    scope: 'entity',
    offset: 0,
    total: 0,
    items: []
  })
  await read
  assert.equal(view.state.value.history, null)
})

test('track ratings resolve exact catalog membership and never choose among same-name independent entities', async (t) => {
  const queries: unknown[] = []
  const page = (offset = 0): CatalogPage => ({
    revision: 4,
    offset,
    total: 8,
    items: ['a', 'b'].map((id) => ({
      id,
      kind: 'recording',
      title: 'Same title',
      artist: 'Same artist',
      identity: 'source',
      sourceCount: 1
    }))
  })
  const view = createTrackRatingsView(async (query) => {
    queries.push(query)
    return page(query.offset)
  })
  t.after(view.dispose)
  await view.setContext({ provider: 'local', id: 'D:/one.flac' }, '')
  assert.deepEqual(queries[0], {
    kind: 'recording',
    context: { type: 'track', provider: 'local', id: 'D:/one.flac' },
    source: 'local',
    offset: 0,
    limit: 6,
    revision: undefined
  })
  assert.equal(view.state.value.selected, null)
  view.select(view.state.value.page!.items[1])
  assert.equal(view.state.value.selected!.id, 'b')
  await view.page(6)
  assert.equal((queries[1] as { revision: unknown }).revision, 4)
  view.invalidate()
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.selected, null)
})

test('physical rating targets stay separate under manual versions, page explicitly and fence late membership reads', async (t) => {
  const late = deferred<any>(),
    queries: unknown[] = []
  const target = (id: string) => ({
    id,
    kind: 'release' as const,
    title: 'Same album',
    artist: 'Same artist'
  })
  const view = createRatingTargetsView(async (query) => {
    queries.push(query)
    return query.offset
      ? late.promise
      : {
          entityId: query.entityId,
          offset: 0,
          total: 8,
          items: [target('first'), target('remaster')]
        }
  })
  t.after(view.dispose)
  await view.setContext('manual', '')
  assert.equal(view.state.value.selected, null)
  view.select(view.state.value.page!.items[1])
  assert.equal(view.state.value.selected!.id, 'remaster')
  const next = view.page(6)
  view.invalidate()
  late.resolve({ entityId: 'manual', offset: 6, total: 8, items: [target('late')] })
  await next
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.blocked, true)
  assert.equal(
    view.state.value.selected!.id,
    'remaster',
    'selection is retained only as an inactive anchor for an explicit reread'
  )
  assert.deepEqual(queries, [
    { entityId: 'manual', offset: 0, limit: 6 },
    { entityId: 'manual', offset: 6, limit: 6 }
  ])
})

test('first unknown domain revisions can initialize during the initial read, but later known changes fence it', async (t) => {
  const snapshot = shallowRef({
    epoch: 'one',
    ratingsRevision: null as number | null,
    entityMetadataRevision: null as number | null,
    catalogRevision: null as number | null,
    libraryRevision: null as number | null
  })
  let reads = 0
  const { view } = fixture({
    detail: async () => {
      reads++
      await Promise.resolve()
      snapshot.value = {
        ...snapshot.value,
        ratingsRevision: 0,
        entityMetadataRevision: 0,
        catalogRevision: 0,
        libraryRevision: 0
      }
      return detail('one', 7, 0)
    }
  })
  t.after(view.dispose)
  const stop = observePersonalRatingsView(view, {
    entityId: () => 'one',
    scope: () => '',
    snapshot: () => snapshot.value
  })
  t.after(stop)
  await new Promise<void>((r) => setImmediate(r))
  assert.equal(reads, 1)
  assert.notEqual(view.state.value.detail, null)
  assert.equal(view.state.value.blocked, false)
  snapshot.value = { ...snapshot.value, ratingsRevision: 1 }
  assert.equal(view.state.value.detail, null)
  assert.equal(view.state.value.blocked, true)
})

test('an old-epoch write receipt cannot reread or announce success in the new epoch', async (t) => {
  const pending = deferred<MusicRatingsDetail>(),
    snapshot = shallowRef({ epoch: 'one', ratingsRevision: 1 })
  let reads = 0
  const { view } = fixture({
    detail: async () => {
      reads++
      return detail()
    },
    set: () => pending.promise
  })
  t.after(view.dispose)
  const stop = observePersonalRatingsView(view, {
    entityId: () => 'one',
    scope: () => '',
    snapshot: () => snapshot.value
  })
  t.after(stop)
  await new Promise<void>((r) => setImmediate(r))
  view.choose(10)
  const write = view.save()
  snapshot.value = { ...snapshot.value, epoch: 'two' }
  pending.resolve(detail('one', 10, 2))
  await write
  assert.equal(reads, 1)
  assert.equal(view.state.value.detail, null)
  assert.equal(view.state.value.draft, 10)
  assert.equal(view.state.value.notice, '')
  assert.equal(view.state.value.saving, false)
})

test('track-context target reads retain the exact source identity even beneath a manual recording version', async (t) => {
  const queries: unknown[] = []
  const view = createRatingTargetsView(async (query) => {
    queries.push(query)
    return {
      entityId: query.entityId,
      offset: 0,
      total: 1,
      items: [{ id: 'physical', kind: 'recording', title: 'Recording', artist: 'Artist' }]
    }
  })
  t.after(view.dispose)
  await view.setContext('manual-version', '', { provider: 'ncm', id: '42' })
  assert.deepEqual(queries[0], {
    entityId: 'manual-version',
    offset: 0,
    limit: 6,
    trackContext: { provider: 'ncm', id: '42' }
  })
  assert.equal(view.state.value.selected!.id, 'physical')
})
