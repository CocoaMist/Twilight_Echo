import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  IdentificationCandidatesQuery,
  IdentificationPreview,
  MusicIdentityDetail
} from '../../../../shared/musicIdentification.ts'
import {
  createIdentityReviewView,
  IDENTITY_CANDIDATE_PAGE_SIZE,
  type IdentityReviewApi
} from './identityReviewView.ts'

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/one.flac',
        title: 'One',
        artist: 'Same name',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const id = db.catalogQuery({ kind: 'artist' }).items[0].id
  const [candidate] = db.identificationPublish(
    db.identificationInput(id),
    [
      {
        provider: 'musicbrainz',
        matcherVersion: 'fixture1',
        name: 'Same name',
        summary: 'An independent artist',
        references: [
          {
            provider: 'musicbrainz',
            kind: 'artist',
            idType: 'mbid',
            value: '11111111-1111-4111-8111-111111111111'
          }
        ],
        evidence: {
          origin: 'search',
          matches: ['name'],
          missing: ['cross_reference'],
          conflicts: [],
          incomplete: true,
          provenance: 'fixture'
        }
      }
    ],
    1000
  )
  const calls = { decide: 0, detach: 0, start: 0, changed: 0 }
  const api: IdentityReviewApi = {
    detail: async (entityId) => db.identificationDetail(entityId),
    candidates: async (query) => db.identificationCandidates(query),
    preview: async (query) => db.identificationPreview(query),
    decide: async (query) => {
      calls.decide++
      return db.identificationDecide(query, 2000)
    },
    detach: async (query) => {
      calls.detach++
      return db.identificationDetach(query.linkId, query.revision, 2001)
    },
    start: async () => {
      calls.start++
    },
    newId: () => 'demand1',
    changed: async () => {
      calls.changed++
    }
  }
  return { db, id, candidate, api, calls }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('saved candidate review, rejection reversal, confirmation and explicit detach use real SQLite versions and preserve manual text', async (t) => {
  const { db, id, candidate, api, calls } = fixture(t)
  db.metadataOverride(
    { entityId: id, revision: 0, mode: 'value', language: 'en', value: 'My artist notes' },
    1001
  )
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'local:epoch1')
  assert.equal(view.state.value.preview, null)
  assert.equal(calls.start, 0, 'reading never queries a remote service')
  await view.decide('confirm')
  assert.equal(calls.decide, 0, 'no decision without an explicit preview')
  await view.review(candidate)
  assert.equal(view.canConfirm.value, true, 'incomplete evidence can still be reviewed manually')
  await view.decide('reject')
  assert.equal(view.state.value.candidates!.total, 0)
  await view.filter('rejected')
  await view.review(view.state.value.candidates!.items[0])
  assert.equal(view.state.value.preview!.candidate.suppressed, true)
  await view.decide('confirm')
  assert.equal(view.state.value.identity!.link!.state, 'confirmed')
  await view.detach()
  assert.equal(calls.detach, 0)
  view.beginDetach()
  await view.detach()
  assert.equal(view.state.value.identity!.link!.state, 'detached')
  assert.equal(db.metadataDetail(id, 'en').introduction!.value, 'My artist notes')
  assert.deepEqual(calls, { decide: 2, detach: 1, start: 0, changed: 3 })
})

test('changed identity evidence disables confirmation and rejection without silently rebasing a candidate', async (t) => {
  const { db, id, candidate, api, calls } = fixture(t)
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'local')
  db.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'A different recording' } }])
  while (db.catalogStatus().localPending) db.catalogAdvance()
  await view.review(candidate)
  assert.equal(view.state.value.preview!.stale, true)
  assert.equal(view.canConfirm.value, false)
  assert.equal(view.canReject.value, false)
  await view.decide('confirm')
  await view.decide('reject')
  assert.equal(calls.decide, 0)
})

test('a lost committed receipt is reconciled by reading, never by repeating the decision', async (t) => {
  const { id, candidate, api, calls } = fixture(t)
  const decide = api.decide
  api.decide = async (query) => {
    await decide(query)
    throw new Error('connection lost after commit')
  }
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'local')
  await view.review(candidate)
  await view.decide('confirm')
  assert.equal(view.state.value.identity!.link!.state, 'confirmed')
  assert.match(view.state.value.actionError, /结果未确认/)
  assert.equal(view.state.value.preview, null)
  await view.decide('confirm')
  assert.equal(calls.decide, 1)
})

test('a server revision conflict rereads current state and requires a new preview', async (t) => {
  const { id, candidate, api, calls } = fixture(t)
  api.decide = async () => {
    calls.decide++
    throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
  }
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'local')
  await view.review(candidate)
  await view.decide('confirm')
  assert.match(view.state.value.actionError, /已变化/)
  assert.equal(view.state.value.preview, null)
  assert.equal(view.state.value.saving, false)
  await view.decide('confirm')
  assert.equal(calls.decide, 1)
})

test('navigation aborts old reads and a late mutation receipt never refreshes the new page', async (t) => {
  const { id, candidate, api, calls } = fixture(t)
  const pending = deferred<unknown>()
  api.decide = async () => pending.promise
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'epoch1')
  await view.review(candidate)
  const write = view.decide('confirm')
  await view.setContext(id, 'epoch2')
  pending.resolve({})
  await write
  assert.equal(calls.changed, 0)
  assert.equal(view.state.value.notice, '')
  assert.equal(view.state.value.saving, false)
})

test('refresh and unmount discard late previews and failed reads without reviving controls', async (t) => {
  const { id, candidate, api } = fixture(t)
  const pending = deferred<IdentificationPreview>()
  let previewSignal!: AbortSignal
  const realPreview = api.preview
  const result = await realPreview(
    { candidateId: candidate.id, revision: candidate.revision, linkRevision: 0 },
    new AbortController().signal
  )
  api.preview = async (_query, signal) => {
    previewSignal = signal
    return pending.promise
  }
  const view = createIdentityReviewView(api)
  await view.setContext(id, 'local')
  const first = view.review(candidate)
  await view.refresh()
  pending.resolve(result)
  await first
  assert.equal(previewSignal.aborted, true)
  assert.equal(view.state.value.preview, null)
  const old = deferred<MusicIdentityDetail>()
  api.detail = async () => old.promise
  const load = view.refresh()
  view.dispose()
  old.reject(new Error('late failure'))
  await load
  assert.equal(view.state.value.error, '')
})

test('candidate paging stays bounded, changing filters resets the page and no page auto-selects a name', async (t) => {
  const { id, candidate, api } = fixture(t)
  const queries: IdentificationCandidatesQuery[] = []
  api.candidates = async (query) => {
    queries.push(query)
    return { total: 8, items: [candidate] }
  }
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'local')
  await view.page(6)
  await view.filter('rejected')
  assert.deepEqual(
    queries.map((q) => [q.offset, q.limit, q.state]),
    [
      [0, IDENTITY_CANDIDATE_PAGE_SIZE, 'candidate'],
      [6, IDENTITY_CANDIDATE_PAGE_SIZE, 'candidate'],
      [0, IDENTITY_CANDIDATE_PAGE_SIZE, 'rejected']
    ]
  )
  assert.equal(view.state.value.preview, null)
})

test('only explicit recognition starts work and duplicate clicks cannot replay a pending start', async (t) => {
  const { id, api } = fixture(t)
  const pending = deferred<unknown>()
  const demands: unknown[] = []
  api.start = async (query) => {
    demands.push(query)
    return pending.promise
  }
  const view = createIdentityReviewView(api)
  t.after(view.dispose)
  await view.setContext(id, 'local')
  const start = view.start()
  await view.start()
  assert.deepEqual(demands, [{ entityId: id, batchId: 'demand1' }])
  pending.resolve({})
  await start
  assert.match(view.state.value.notice, /后台识别/)
})

test('rating conflict requires an explicit choice and every confirmation fences the preview rating revision', async (t) => {
  for (const choice of ['current', 'target', 'clear'] as const) {
    const { id, candidate, api } = fixture(t)
    const preview = api.preview, requests: unknown[] = []
    api.preview = async (query, signal) => ({ ...(await preview(query, signal)), ratingImpact: {
      revision: 42, current: { steps: 7, revision: 1, updatedAt: 100 }, target: { steps: 9, revision: 2, updatedAt: 200 }, conflict: true, action: 'choose'
    } })
    api.decide = async query => { requests.push(query) }
    const view = createIdentityReviewView(api)
    t.after(view.dispose)
    await view.setContext(id, '')
    await view.review(candidate)
    assert.equal(view.canConfirm.value, false)
    await view.decide('confirm')
    assert.equal(requests.length, 0)
    view.chooseRating(choice)
    assert.equal(view.canConfirm.value, true)
    await view.decide('confirm')
    assert.deepEqual((requests[0] as { ratingResolution: unknown }).ratingResolution, { revision: 42, choice })
    assert.equal(view.state.value.ratingChoice, null)
  }
  for (const action of ['carry', 'share', 'keep'] as const) {
    const { id, candidate, api } = fixture(t)
    const preview = api.preview, requests: any[] = []
    api.preview = async (query, signal) => ({ ...(await preview(query, signal)), ratingImpact: { revision: 43, current: null, target: null, conflict: false, action } })
    api.decide = async query => { requests.push(query) }
    const view = createIdentityReviewView(api)
    t.after(view.dispose)
    await view.setContext(id, '')
    await view.review(candidate)
    await view.decide('confirm')
    assert.deepEqual(requests[0].ratingResolution, { revision: 43, choice: action === 'carry' ? 'current' : 'target' })
  }
})

test('related-person preference choices must come from the current preview and carry its revision', async t => {
  const { id, candidate, api } = fixture(t), original = api.preview, requests: any[] = []
  api.preview = async (query, signal) => ({ ...(await original(query, signal)), preferenceImpact: {
    revision: 44, current: { state: 'favorite', revision: 1, updatedAt: 1 }, target: null, conflict: true, action: 'choose',
    related: [{ entityId: 'graph-person', title: 'Exact person', value: { state: 'ban', revision: 2, updatedAt: 2 } }]
  } })
  api.decide = async query => { requests.push(query) }
  const view = createIdentityReviewView(api); t.after(view.dispose)
  await view.setContext(id, ''); await view.review(candidate)
  view.choosePreference('related:forged'); assert.equal(view.canConfirm.value, false)
  view.choosePreference('related:graph-person'); assert.equal(view.canConfirm.value, true)
  await view.decide('confirm')
  assert.deepEqual(requests[0].preferenceResolution, { revision: 44, choice: 'related:graph-person' })
})
