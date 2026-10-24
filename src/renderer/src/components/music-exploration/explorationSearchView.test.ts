import assert from 'node:assert/strict'
import test from 'node:test'
import { h, ref, shallowRef } from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import { createExplorationSearchView } from './explorationSearchView.ts'
import type { MusicExplorationPage, MusicExplorationQuery } from '../../../../shared/musicExploration.ts'
const token = { revision: 1, catalogRevision: 2, contentRevision: 3, metadataRevision: 4, contextKey: '[]', asOf: 100, expiresAt: null }
const page = (offset = 0): MusicExplorationPage => ({ token, offset, total: 11, items: [{ id: 'person-1', kind: 'artist', title: 'Same name', artist: '', inLibrary: true, sourceCount: 2 }] })

test('entity search defaults to actual library content and uses a frozen token only for its current page', async () => {
  const queries: MusicExplorationQuery[] = []
  const view = createExplorationSearchView(async query => { queries.push(query); return page(query.offset) })
  await view.setQuery(' Same name ')
  assert.deepEqual(queries[0], { search: 'Same name', kinds: ['artist', 'work', 'performance'], scope: 'library', offset: 0, limit: 10 })
  await view.page(10)
  assert.deepEqual(queries[1].token, token)
  assert.equal(queries[1].offset, 10)
  await view.setQuery('Other', 'catalog')
  assert.equal(queries[2].scope, 'catalog')
  assert.equal(queries[2].token, undefined)
  view.dispose()
})

test('changing text, clearing or disposing entity search retires an old response', async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (p: MusicExplorationPage) => void }> = []
  const view = createExplorationSearchView((_q, signal) => new Promise(resolve => pending.push({ signal, resolve })))
  const first = view.setQuery('Old'), second = view.setQuery('New')
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(page(10)); await second
  pending[0].resolve(page()); await first
  assert.equal(view.state.value.page?.offset, 10)
  const third = view.setQuery('Third')
  await view.setQuery(' ')
  assert.equal(pending[2].signal.aborted, true)
  pending[2].resolve(page()); await third
  assert.equal(view.state.value.page, null)
  const last = view.setQuery('Last')
  view.dispose(); pending[3].resolve(page()); await last
  assert.equal(view.state.value.page, null)
})

test('stale or offline entity search clears old results and requires an explicit fresh read', async () => {
  let fail = false, calls = 0
  const view = createExplorationSearchView(async () => { calls++; if (fail) throw new Error('人物作品已变化'); return page() })
  await view.setQuery('Person')
  fail = true; await view.page(10)
  assert.equal(calls, 2)
  assert.equal(view.state.value.page, null)
  assert.match(view.state.value.error, /已变化/)
  fail = false; await view.refresh()
  const current = () => view.state.value.page
  assert.equal(current()?.offset, 0)
  view.dispose()
})

test('a permission deadline removes visible search results without networking and cancels on disposal', async () => {
  let now = 100, callback: (() => void) | null = null, reads = 0, cancelled = 0
  const view = createExplorationSearchView(async () => { reads++; return { ...page(), token: { ...token, expiresAt: 200 } } }, {
    now: () => now, schedule: fn => { callback = fn; return () => { cancelled++; callback = null } }
  })
  await view.setQuery('Person')
  now = 200; (callback as unknown as () => void)()
  assert.equal(view.state.value.page, null)
  assert.match(view.state.value.error, /到期/)
  assert.equal(reads, 1)
  now = 100; await view.refresh()
  view.dispose()
  assert.equal(cancelled, 1)
  assert.equal(callback, null)
})

test('compiled unified entity results navigate the chosen exact ID and clear on a new query or durable change', async t => {
  const snapshot = shallowRef({ epoch: 'one', explorationRevision: 1 }), query = ref('Same name')
  const requests: MusicExplorationQuery[] = [], opened: string[] = []
  const Search = component('../music-exploration/MusicExplorationSearch.vue', {
    './explorationSearchView.ts': { createExplorationSearchView },
    './MusicExplorationPanel.vue': { __esModule: true, default: { props: ['entityId'], setup: (p: any) => () => { opened.push(p.entityId); return h('aside', p.entityId) } } },
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({ state: snapshot, query: async (name: string, q: MusicExplorationQuery) => {
      assert.equal(name, 'exploration.query'); requests.push(q); return page(q.offset)
    } }) }
  })
  const ui = mount(t, () => h(Search, { query: query.value }))
  await settle()
  assert.equal(requests[0].scope, 'library')
  const result = () => ui.nodes().find(n => n.tag === 'button' && n.props['aria-pressed'] === false)!
  result().props.onClick(); await settle()
  assert.equal(opened.at(-1), 'person-1')
  ui.button('下一页').props.onClick(); await settle()
  assert.deepEqual(requests.at(-1)!.token, token)
  query.value = 'Other'; await settle()
  assert.equal(requests.at(-1)!.search, 'Other')
  assert.doesNotMatch(ui.text(), /收起详情/)
  const reads = requests.length
  snapshot.value = { ...snapshot.value, explorationRevision: 2 }; await settle()
  assert.equal(requests.length, reads + 1)
  const select = ui.nodes().find(n => n.tag === 'select')!
  select.props['onUpdate:modelValue']('catalog'); await settle()
  assert.equal(requests.at(-1)!.scope, 'catalog')
})
