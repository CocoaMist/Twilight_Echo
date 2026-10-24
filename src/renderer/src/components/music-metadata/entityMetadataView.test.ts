import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef, nextTick } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import {
  createEntityMetadataView,
  observeEntityMetadataView,
  collectionMetadataContext,
  metadataExternalUrl,
  METADATA_REFERENCE_PAGE_SIZE,
  type EntityMetadataReadApi
} from './entityMetadataView.ts'
import type { EntityMetadataDetail } from '../../../../shared/entityMetadata.ts'
import type { CatalogEntity, CatalogPage } from '../../../../shared/musicCatalog.ts'

const entity = (id: string): CatalogEntity => ({
  id,
  kind: 'artist',
  title: 'Same name',
  artist: 'Same name',
  identity: 'source',
  sourceCount: 1
})
const page = (ids: string[], total = ids.length, offset = 0): CatalogPage => ({
  revision: 1,
  total,
  offset,
  items: ids.map(entity)
})
const detail = (id: string): EntityMetadataDetail => ({
  entityId: id,
  targetId: null,
  link: null,
  revision: 0,
  name: 'Same name',
  introduction: {
    value: `Introduction ${id}`,
    language: 'en',
    origin: 'manual',
    attribution: null
  },
  override: null,
  facts: []
})
const target = collectionMetadataContext('artists', 'artist:Same name')!
function api(extra: Partial<EntityMetadataReadApi> = {}): EntityMetadataReadApi {
  return {
    catalog: async () => page(['a']),
    sources: async () => ({ revision: 1, offset: 0, total: 0, items: [] }),
    detail: async (id) => detail(id),
    ...extra
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((r) => setImmediate(r))

test('a unique exact reference displays its saved metadata in the actual source context and selected language', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      { id: 'one', source: 'local', filePath: 'D:/one.flac', title: 'One', artist: 'Same name' }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const artist = db.catalogQuery({ kind: 'artist' }).items[0]
  db.metadataOverride(
    { entityId: artist.id, revision: 0, mode: 'value', value: '我的艺人介绍', language: 'zh-Hant' },
    1000
  )
  const calls: unknown[] = []
  const view = createEntityMetadataView({
    catalog: async (query) => {
      calls.push(query)
      return db.catalogQuery(query)
    },
    sources: async (query) => db.catalogSources(query),
    detail: async (id, language, sourceProvider) => {
      calls.push({ id, language, sourceProvider })
      return db.metadataDetail(id, language, { sourceProvider })
    }
  })
  t.after(view.dispose)
  await view.setContext(target, 'zh-Hant')
  assert.equal(view.state.value.selected!.id, artist.id)
  assert.equal(view.state.value.detail!.introduction!.value, '我的艺人介绍')
  assert.match(view.state.value.samples[artist.id], /One/)
  assert.deepEqual(calls[1], { id: artist.id, language: 'zh-Hant', sourceProvider: 'local' })
  assert.equal(
    db.metadataJobs({}).total,
    0,
    'opening a page never enqueues identification or enrichment'
  )
})

test('same-name choices never choose the first; each page is bounded and revision fenced', async () => {
  const calls: unknown[] = []
  const view = createEntityMetadataView(
    api({
      catalog: async (query) => {
        calls.push(query)
        return query.offset ? page(['g'], 7, 6) : page(['a', 'b', 'c', 'd', 'e', 'f'], 7)
      },
      detail: async (id) => {
        calls.push(id)
        return detail(id)
      }
    })
  )
  await view.setContext(target, 'en')
  assert.equal(view.state.value.selected, null)
  assert.equal(view.state.value.detail, null)
  await view.select(view.state.value.page!.items[1])
  assert.equal(view.state.value.detail!.entityId, 'b')
  await view.page(6)
  assert.equal(view.state.value.selected, null)
  assert.deepEqual(calls[2], {
    kind: 'artist',
    context: target.context,
    source: 'local',
    offset: 6,
    limit: METADATA_REFERENCE_PAGE_SIZE,
    revision: 1
  })
  assert.equal(view.state.value.page!.total, 7)
  view.dispose()
})

test('a late old context read cannot overwrite a newly navigated native-ID page', async () => {
  const old = deferred<CatalogPage>(),
    signals: AbortSignal[] = []
  const view = createEntityMetadataView(
    api({
      catalog: async (query, signal) => {
        signals.push(signal)
        return query.context?.type === 'collection' ? old.promise : page(['native'])
      }
    })
  )
  const first = view.setContext(target, 'en')
  await view.setContext(
    {
      context: { type: 'native', provider: 'ncm', id: '42' },
      kind: 'artist',
      sourceProvider: 'ncm'
    },
    'en'
  )
  old.resolve(page(['old']))
  await first
  assert.equal(signals[0].aborted, true)
  assert.equal(view.state.value.detail!.entityId, 'native')
  view.dispose()
})

test('domain revision observation refreshes details and references without querying on playback ticks', async () => {
  let catalogs = 0,
    details = 0
  const snapshot = shallowRef({
    epoch: 'one',
    catalogRevision: 1,
    libraryRevision: 1,
    entityMetadataRevision: 1,
    settingsRevision: 1,
    sequence: 0
  })
  const view = createEntityMetadataView(
    api({
      catalog: async () => {
        catalogs++
        return page(['a', 'b'])
      },
      detail: async (id) => {
        details++
        return detail(id)
      }
    })
  )
  const stop = observeEntityMetadataView(view, {
    target: () => target,
    language: () => 'en',
    snapshot: () => snapshot.value
  })
  await tick()
  await view.select(entity('b'))
  assert.equal(catalogs, 1)
  assert.equal(details, 1)
  for (let i = 1; i <= 5; i++) {
    snapshot.value = { ...snapshot.value, sequence: i }
    await nextTick()
  }
  assert.equal(catalogs, 1)
  assert.equal(details, 1)
  snapshot.value = { ...snapshot.value, entityMetadataRevision: 2 }
  await nextTick()
  await tick()
  assert.equal(catalogs, 1)
  assert.equal(details, 2)
  snapshot.value = { ...snapshot.value, catalogRevision: 2 }
  await nextTick()
  await tick()
  assert.equal(catalogs, 2)
  assert.equal(details, 3)
  assert.equal(view.state.value.selected!.id, 'b')
  snapshot.value = { ...snapshot.value, settingsRevision: 2 }
  await nextTick()
  await tick()
  assert.equal(details, 4)
  snapshot.value = { ...snapshot.value, epoch: 'two' }
  await nextTick()
  await tick()
  assert.equal(
    view.state.value.selected,
    null,
    'Core restart clears the old selection before resolving current membership'
  )
  assert.equal(catalogs, 3)
  stop()
  view.dispose()
  snapshot.value = { ...snapshot.value, catalogRevision: 3 }
  await nextTick()
  assert.equal(catalogs, 3)
})

test('refresh stays on the chosen page; removing that page returns to the first without selecting another name', async () => {
  let total = 8
  const view = createEntityMetadataView(
    api({
      catalog: async (query) =>
        query.offset
          ? page(total > 6 ? ['g', 'h'] : [], total, 6)
          : page(['a', 'b', 'c', 'd', 'e', 'f'], total)
    })
  )
  await view.setContext(target, 'en')
  await view.page(6)
  await view.select(entity('h'))
  await view.refresh()
  assert.equal(view.state.value.page!.offset, 6)
  assert.equal(view.state.value.selected!.id, 'h')
  total = 6
  await view.refresh()
  assert.equal(view.state.value.page!.offset, 0)
  assert.equal(view.state.value.selected, null)
  view.dispose()
})

test('switching selected entities cancels old detail and never flashes its late response', async () => {
  const old = deferred<EntityMetadataDetail>(),
    signals: AbortSignal[] = []
  const view = createEntityMetadataView(
    api({
      catalog: async () => page(['a', 'b']),
      detail: async (id, _language, _provider, signal) => {
        signals.push(signal)
        return id === 'a' ? old.promise : detail(id)
      }
    })
  )
  await view.setContext(target, 'en')
  const first = view.select(entity('a'))
  await view.select(entity('b'))
  assert.equal(signals[0].aborted, true)
  old.resolve(detail('a'))
  await first
  assert.equal(view.state.value.detail!.entityId, 'b')
  view.dispose()
})

test('refresh preserves an actual choice but clears it if membership disappears; no same-name substitution', async () => {
  let ids = ['a', 'b']
  const view = createEntityMetadataView(api({ catalog: async () => page(ids) }))
  await view.setContext(target, 'en')
  await view.select(entity('b'))
  await view.refresh()
  assert.equal(view.state.value.selected!.id, 'b')
  ids = ['c', 'd']
  await view.refresh()
  assert.equal(view.state.value.selected, null)
  assert.equal(view.state.value.detail, null)
  view.dispose()
})

test('metadata invalidation clears cached introduction immediately, then shows an explicit clear instead of stale text', async () => {
  const changed = deferred<EntityMetadataDetail>()
  let reads = 0
  const view = createEntityMetadataView(
    api({ detail: async (id) => (++reads === 1 ? detail(id) : changed.promise) })
  )
  await view.setContext(target, 'en')
  const refreshing = view.refreshDetail()
  assert.equal(view.state.value.detail, null)
  changed.resolve({
    ...detail('a'),
    introduction: null,
    override: { mode: 'clear', language: 'en', value: '' }
  })
  await refreshing
  assert.equal(view.state.value.detail!.introduction, null)
  assert.equal(view.state.value.detail!.override!.mode, 'clear')
  view.dispose()
})

test('failed detail and stale pagination remain visible errors; explicit retry reads fresh context', async () => {
  let detailFailed = true
  const view = createEntityMetadataView(
    api({
      catalog: async (query) => {
        if (query.revision !== undefined) throw new Error('音乐资料已变化，请刷新后重试')
        return page(['a'])
      },
      detail: async (id) => {
        if (detailFailed) throw new Error('Read unavailable')
        return detail(id)
      }
    })
  )
  await view.setContext(target, 'en')
  assert.match(view.state.value.detailError, /unavailable/)
  detailFailed = false
  await view.refreshDetail()
  assert.equal(view.state.value.detailError, '')
  await view.page(6)
  assert.match(view.state.value.error, /已变化/)
  assert.equal(view.state.value.detail, null)
  await view.refresh()
  assert.equal(view.state.value.error, '')
  assert.ok(view.state.value.detail)
  view.dispose()
})

test('disposing a view aborts both work areas and ignores late data', async () => {
  const pending = deferred<EntityMetadataDetail>()
  let signal: AbortSignal | undefined
  const view = createEntityMetadataView(
    api({
      detail: async (_id, _language, _provider, s) => {
        signal = s
        return pending.promise
      }
    })
  )
  const reading = view.setContext(target, 'en')
  await tick()
  view.dispose()
  assert.equal(signal!.aborted, true)
  pending.resolve(detail('a'))
  await reading
  assert.equal(view.state.value.detail, null)
})

test('legacy navigation keeps exact grouping IDs and external links allow only web URLs without credentials', () => {
  assert.equal(collectionMetadataContext('playlists', 'artist:A'), null)
  assert.equal(collectionMetadataContext('artists', null), null)
  assert.deepEqual(collectionMetadataContext('albums', 'album:D:/Music/Album|Artist')!.context, {
    type: 'collection',
    collection: 'albums',
    id: 'D:/Music/Album|Artist'
  })
  assert.ok(metadataExternalUrl('https://musicbrainz.org/artist/42'))
  for (const url of [
    'file:///D:/private',
    'javascript:alert(1)',
    'https://user:secret@test.invalid',
    'not a URL'
  ])
    assert.equal(metadataExternalUrl(url), null)
})

test('painted preferred text expires without polling, while the personal image choice remains available', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const attribution = { provider: 'platform.ncm', externalId: '42', revision: '1', retrievedAt: 1,
    url: 'https://example.com', license: '', licenseUrl: '', attribution: 'NCM' }
  let reads = 0
  const view = createEntityMetadataView(api({ detail: async id => {
    reads++
    return { ...detail(id),
      introduction: { value: 'Temporary text', language: 'en', origin: 'external', attribution },
      artworkOverride: { mode: 'clear' }, sourcePreference: { provider: 'platform.ncm', available: true },
      sourceOptions: ['platform.ncm'], facts: [{ field: 'introduction', value: 'Temporary text', language: 'en', attribution,
        usage: { display: true, cache: true, crossSource: true, export: false, expiresAt: 1010 } }] }
  } }))
  t.after(view.dispose)
  await view.setContext(target, 'en')
  assert.equal(view.state.value.detail?.introduction?.value, 'Temporary text')
  t.mock.timers.tick(10)
  assert.equal(view.state.value.detail?.introduction, null)
  assert.equal(view.state.value.detail?.artworkOverride?.mode, 'clear')
  assert.deepEqual(view.state.value.detail?.sourcePreference, { provider: 'platform.ncm', available: false })
  assert.deepEqual(view.state.value.detail?.sourceOptions, [])
  assert.match(view.state.value.detailNotice, /到期/)
  assert.equal(reads, 1, 'expiry withdraws only, without automatic metadata reads')
})
