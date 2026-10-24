import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  IdentificationInboxPage,
  IdentificationInboxQuery
} from '../../../../shared/musicIdentification.ts'
import { createIdentityInboxView, IDENTITY_INBOX_PAGE_SIZE } from './identityInboxView.ts'

const entity = { id: 'a', kind: 'artist', title: 'Same name', artist: 'Same name' } as const
const page = (offset = 0): IdentificationInboxPage => ({
  total: 21,
  offset,
  items: [{ entity, candidateCount: 2, sample: { provider: 'local', title: 'One', album: 'Album' } }]
})
test('inbox queries are bounded, choices are explicit, and filters and page navigation clear the old selection', async () => {
  const calls: IdentificationInboxQuery[] = []
  const view = createIdentityInboxView(async (query) => {
    calls.push(query)
    return page(query.offset)
  })
  await view.refresh()
  assert.equal(view.state.value.selected, null)
  view.select(entity)
  await view.page(20)
  assert.equal(view.state.value.selected, null)
  view.select(entity)
  await view.filter('recording', 'rejected')
  assert.equal(view.state.value.selected, null)
  assert.deepEqual(calls, [
    { offset: 0, limit: IDENTITY_INBOX_PAGE_SIZE, state: 'candidate' },
    { offset: 20, limit: IDENTITY_INBOX_PAGE_SIZE, state: 'candidate' },
    { offset: 0, limit: IDENTITY_INBOX_PAGE_SIZE, state: 'rejected', kind: 'recording' }
  ])
  view.dispose()
})

test('a reviewed entity can stay open after leaving the pending list; membership or epoch changes clear it', async () => {
  let current = page()
  const view = createIdentityInboxView(async () => current)
  await view.refresh()
  view.select(entity)
  current = { ...page(), items: [], total: 0 }
  await view.refresh()
  assert.equal(view.state.value.selected!.id, entity.id)
  await view.refresh(true)
  assert.equal(view.state.value.selected, null)
  view.dispose()
})

test('old filter responses and post-unmount results cannot overwrite the current inbox', async () => {
  let resolve!: (page: IdentificationInboxPage) => void
  const old = new Promise<IdentificationInboxPage>((r) => {
    resolve = r
  })
  const signals: AbortSignal[] = []
  const view = createIdentityInboxView(async (query, signal) => {
    signals.push(signal)
    return query.kind ? { ...page(), total: 0, items: [] } : old
  })
  const loading = view.refresh()
  await view.filter('recording', 'candidate')
  resolve(page())
  await loading
  assert.equal(signals[0].aborted, true)
  assert.equal(view.state.value.page!.total, 0)
  const last = view.refresh()
  view.dispose()
  await last
  assert.equal(signals[2].aborted, true)
})
