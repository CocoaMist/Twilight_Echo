import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { LibraryDatabaseIdentification } from '../../../../main/library/libraryDatabaseIdentification.ts'
import type {
  IdentificationHistoryPage,
  IdentificationRestorePreview
} from '../../../../shared/musicIdentification.ts'
import { createIdentityHistoryView, type IdentityHistoryApi } from './identityHistoryView.ts'

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
        id: 'track',
        source: 'local',
        filePath: 'D:/one.flac',
        title: 'One',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const id = db.catalogQuery({ kind: 'artist' }).items[0].id
  const identity = new LibraryDatabaseIdentification({
    sql: db.sql,
    transaction: (action) => {
      db.sql.exec('BEGIN IMMEDIATE')
      try {
        const result = action()
        db.sql.exec('COMMIT')
        return result
      } catch (error) {
        db.sql.exec('ROLLBACK')
        throw error
      }
    }
  })
  const [candidate] = identity.publish(
    identity.input(id),
    [
      {
        provider: 'ncm',
        name: 'Artist',
        summary: '',
        matcherVersion: 'test1',
        references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }],
        evidence: {
          origin: 'search',
          matches: ['name'],
          missing: [],
          conflicts: [],
          incomplete: false,
          provenance: 'fixture'
        }
      }
    ],
    1000
  )
  identity.decide(
    {
      candidateId: candidate.id,
      revision: candidate.revision,
      linkRevision: candidate.linkRevision,
      decision: 'confirm'
    },
    1001
  )
  const link = identity.detail(id).link!
  identity.detach(link.id, link.revision, 1002)
  const calls = { history: 0, preview: 0, restore: 0, changed: 0 }
  const api: IdentityHistoryApi = {
    history: async (query) => {
      calls.history++
      return identity.history(query)
    },
    preview: async (query) => {
      calls.preview++
      return identity.restorePreview(query)
    },
    restore: async (query) => {
      calls.restore++
      return identity.restore(query, 2000)
    },
    changed: async () => {
      calls.changed++
    }
  }
  return { db, identity, id, api, calls }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test('history is lazy and read-only; an explicit preview is required before restoring real SQLite identity', async (t) => {
  const { id, api, calls } = fixture(t)
  const view = createIdentityHistoryView(api)
  t.after(view.dispose)
  view.setContext(id, 'epoch1')
  await view.refresh()
  assert.equal(calls.history, 0)
  await view.toggle()
  assert.equal(calls.history, 1)
  assert.equal(calls.restore, 0)
  await view.restore()
  assert.equal(calls.restore, 0)
  const history = view.state.value.page!.items.find((item) => item.hasSnapshot)!
  await view.review(history)
  assert.equal(view.canRestore.value, true)
  await view.restore()
  assert.equal(calls.restore, 1)
  assert.equal(calls.changed, 1)
  assert.equal(view.state.value.page!.current.link!.state, 'confirmed')
  assert.equal(view.state.value.preview, null)
  await view.restore()
  assert.equal(calls.restore, 1)
})

test('unknown restore receipt triggers a read, never replay, and a restored current identity disables a second restore', async (t) => {
  const { id, api, calls } = fixture(t)
  const restore = api.restore
  api.restore = async (query) => {
    await restore(query)
    throw new Error('receipt lost after commit')
  }
  const view = createIdentityHistoryView(api)
  t.after(view.dispose)
  view.setContext(id, 'epoch1')
  await view.toggle()
  const item = view.state.value.page!.items.find((item) => item.hasSnapshot)!
  await view.review(item)
  await view.restore()
  assert.equal(calls.restore, 1)
  assert.equal(view.state.value.page!.current.link!.state, 'confirmed')
  assert.match(view.state.value.error, /结果未确认/)
  await view.review(item)
  assert.equal(view.canRestore.value, false)
  await view.restore()
  assert.equal(calls.restore, 1)
})

test('changed source input keeps historical evidence stale even after reading fresh current fences', async (t) => {
  const { id, db, api, calls } = fixture(t)
  const view = createIdentityHistoryView(api)
  t.after(view.dispose)
  view.setContext(id, 'epoch1')
  await view.toggle()
  db.patchTracks([{ id: 'track', expectedVersion: 1, patch: { title: 'Changed' } }])
  while (db.catalogStatus().localPending) db.catalogAdvance()
  await view.refresh()
  await view.review(view.state.value.page!.items.find((item) => item.hasSnapshot)!)
  assert.equal(view.state.value.preview!.stale, true)
  assert.equal(view.canRestore.value, false)
  await view.restore()
  assert.equal(calls.restore, 0)
})

test('scope changes isolate late history pages, previews and command receipts', async (t) => {
  const { id, api, calls } = fixture(t)
  const page = await api.history({ entityId: id }, new AbortController().signal)
  const latePage = deferred<IdentificationHistoryPage>()
  api.history = () => latePage.promise
  const view = createIdentityHistoryView(api)
  t.after(view.dispose)
  view.setContext(id, 'epoch1')
  const pending = view.toggle()
  view.setContext(id, 'epoch2')
  latePage.resolve(page)
  await pending
  assert.equal(view.state.value.page, null)
  api.history = async () => page
  await view.toggle()
  const latePreview = deferred<IdentificationRestorePreview>()
  const item = page.items.find((item) => item.hasSnapshot)!
  const preview = await api.preview(
    {
      entityId: id,
      historySeq: item.seq,
      inputVersion: page.inputVersion,
      linkRevision: page.current.link!.revision
    },
    new AbortController().signal
  )
  api.preview = () => latePreview.promise
  const pendingPreview = view.review(item)
  view.setContext('different', 'epoch2')
  latePreview.resolve(preview)
  await pendingPreview
  assert.equal(view.state.value.preview, null)
  view.setContext(id, 'epoch3')
  await view.toggle()
  api.preview = async () => preview
  await view.review(item)
  const receipt = deferred<unknown>()
  api.restore = () => {
    calls.restore++
    return receipt.promise
  }
  const pendingRestore = view.restore()
  view.setContext(id, 'epoch4')
  receipt.resolve({})
  await pendingRestore
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.saving, false)
  assert.equal(calls.changed, 0)
})

test('restoring history requires a fresh rating choice and carries the exact preview revision', async t => {
  const { id, api } = fixture(t)
  const preview = api.preview, requests: any[] = []
  api.preview = async (query, signal) => ({ ...(await preview(query, signal)), ratingImpact: {
    revision: 20, current: { steps: 3, revision: 1, updatedAt: 100 }, target: { steps: 9, revision: 2, updatedAt: 200 }, conflict: true, action: 'choose'
  } })
  api.restore = async query => { requests.push(query) }
  const view = createIdentityHistoryView(api)
  t.after(view.dispose)
  view.setContext(id, '')
  await view.toggle()
  const item = view.state.value.page!.items.find(item => item.hasSnapshot)!
  await view.review(item)
  assert.equal(view.canRestore.value, false)
  view.chooseRating('target')
  assert.equal(view.canRestore.value, true)
  view.invalidate()
  assert.equal(view.canRestore.value, false)
  assert.equal(view.state.value.ratingChoice, null)
  await view.refresh()
  await view.review(item)
  view.chooseRating('clear')
  await view.restore()
  assert.deepEqual(requests[0].ratingResolution, { revision: 20, choice: 'clear' })
})

test('history restoration accepts only the related exact-person choices in its own preview', async t => {
  const { id, api } = fixture(t), original = api.preview, requests: any[] = []
  api.preview = async (query, signal) => ({ ...(await original(query, signal)), preferenceImpact: {
    revision: 45, current: null, target: { state: 'favorite', revision: 1, updatedAt: 1 }, conflict: true, action: 'choose',
    related: [{ entityId: 'related-person', title: 'Related person', value: { state: 'ban', revision: 2, updatedAt: 2 } }]
  } })
  api.restore = async query => { requests.push(query) }
  const view = createIdentityHistoryView(api); t.after(view.dispose)
  view.setContext(id, ''); await view.toggle()
  const item = view.state.value.page!.items.find(item => item.hasSnapshot)!
  await view.review(item)
  view.choosePreference('related:forged'); assert.equal(view.canRestore.value, false)
  view.choosePreference('related:related-person'); assert.equal(view.canRestore.value, true)
  await view.restore()
  assert.deepEqual(requests[0].preferenceResolution, { revision: 45, choice: 'related:related-person' })
})
