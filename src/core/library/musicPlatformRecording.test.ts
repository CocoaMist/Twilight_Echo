import test from 'node:test'
import assert from 'node:assert/strict'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { collectTrackIdentityTags } from '../../main/library/trackIdentityTags.ts'
import { PlatformIdentificationProvider } from './musicIdentificationProvider.ts'
import { platformRecordingReferences, validPlatformRecordingPage, type PlatformRecordingPage } from '../../shared/musicPlatformRecording.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'

const page = (): PlatformRecordingPage => ({ total: 1, items: [{ id: '123', title: 'Song',
  artists: [{ id: '42', name: 'AC/DC' }, { id: '43', name: 'Guest' }], durationSeconds: 200.1,
  album: { id: '456', title: 'Album' } }] })
function seed(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks: [{
    id: 'one', source: 'local', filePath: 'D:/music/one.flac', title: 'Song', artist: 'AC/DC/Guest',
    artists: [{ name: 'AC/DC' }, { name: 'Guest' }], album: 'Album', duration: 200.5,
    identityTags: collectTrackIdentityTags({ title: 'Song', album: 'Album', artists: ['AC/DC/Guest'] }, 200.5, { title: '', artist: '' })
  }] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return db
}
const provider = (load: () => unknown) => new PlatformIdentificationProvider('ncm', {
  inventory: () => [{ id: 'ncm', enabled: true, configuration: '1', supportedMethods: ['searchRecordingIdentities'] }],
  search: async () => { throw Error('not a name-only match') }, recordingSearch: async () => load()
})

test('song title + raw duration + complete credits + album identify digital records and each individual, not slash fragments', async t => {
  const db = seed(t), adapter = provider(page)
  const request = { enabled: true, newImports: true, history: false,
    providers: [{ id: adapter.id, matcherVersion: adapter.matcherVersion, kinds: ['artist', 'recording', 'release'] as CatalogKind[] }] }
  while (db.identificationSchedule(request, 1000).more) {
    // Drain bounded scheduling batches before claiming the persisted jobs.
  }
  let count = 0
  for (let work = db.metadataClaim(1000); work; work = db.metadataClaim(1000)) {
    const input = db.identificationInput(work.job.entityId)
    const r = await adapter.recall(input, new AbortController().signal)
    assert.equal(r.proposals[0].evidence.verification?.method, 'platform_recordings')
    assert.equal(db.metadataFinish(work, { state: 'identified', ...r }, 1001, request), true)
    assert.equal(db.identificationDetail(input.entityId).link?.state, 'confirmed')
    count++
  }
  assert.equal(count, 4)
})

test('truncation, same-name people, missing album, rounded time and guest mismatches cannot authorize a guess', t => {
  const db = seed(t), entity = db.catalogQuery({ kind: 'artist' }).items.find(i => i.title === 'AC/DC')!
  const input = db.identificationInput(entity.id), sample = { sourceId: input.sources![0].sourceId, page: page() }
  for (const mutate of [
    (p: PlatformRecordingPage) => { p.total = 11 },
    (p: PlatformRecordingPage) => { p.items[0].durationSeconds = 205 },
    (p: PlatformRecordingPage) => { p.items[0].artists[1].name = 'Other' },
    (p: PlatformRecordingPage) => { p.items[0].album = null },
    (p: PlatformRecordingPage) => { p.items[0].title = 'Song (Live)' }
  ]) {
    const s = structuredClone(sample); mutate(s.page)
    assert.deepEqual(platformRecordingReferences(input, [s]), [])
  }
  assert.deepEqual(platformRecordingReferences({ ...input, name: 'AC/DC/Guest' }, [sample]), [])
  const conflict = structuredClone(sample)
  conflict.page.items.push({ ...page().items[0], id: '124', artists: [{ id: '99', name: 'AC/DC' }, { id: '43', name: 'Guest' }] })
  conflict.page.total = 2
  assert.deepEqual(platformRecordingReferences(input, [conflict]), ['42', '99'])
  assert.equal(validPlatformRecordingPage({ ...page(), private: 'discard' }), false)
})

test('database recomputes proof from saved raw tags and rejects forged artist IDs', async t => {
  const db = seed(t), adapter = provider(page), entity = db.catalogQuery({ kind: 'artist' }).items[0]
  const request = { enabled: true, newImports: true, history: false,
    providers: [{ id: adapter.id, matcherVersion: adapter.matcherVersion, kinds: ['artist'] as CatalogKind[] }] }
  db.identificationSchedule(request, 1000)
  const work = db.metadataClaim(1000)!, input = db.identificationInput(work.job.entityId)
  const r = await adapter.recall(input, new AbortController().signal)
  r.proposals[0].references[0].value = '999'
  r.proposals[0].evidence.verification!.reference.value = '999'
  db.metadataFinish(work, { state: 'identified', ...r }, 1001, request)
  assert.notEqual(db.identificationDetail(entity.id).link?.state, 'confirmed')
})

test('missing guest IDs retain full credits without inventing that guest identity', t => {
  const db = seed(t), entity = db.catalogQuery({ kind: 'artist' }).items.find(i => i.title === 'AC/DC')!
  const input = db.identificationInput(entity.id), result = page()
  result.items[0].artists[1].id = null
  assert.equal(validPlatformRecordingPage(result), true)
  const samples = [{ sourceId: input.sources![0].sourceId, page: result }]
  assert.deepEqual(platformRecordingReferences(input, samples), ['42'])
  assert.deepEqual(platformRecordingReferences({ ...input, name: 'Guest' }, samples), [])
})

test('bounded recording pagination takes the complete index and rejects a changing or duplicate page', async t => {
  const db = seed(t), input = db.identificationInput(db.catalogQuery({ kind: 'artist' }).items.find(i => i.title === 'AC/DC')!.id)
  for (const variant of ['complete', 'changed', 'duplicate', 'over-budget']) {
    const offsets: number[] = []
    const adapter = new PlatformIdentificationProvider('ncm', {
      inventory: () => [{ id: 'ncm', enabled: true, configuration: '1', supportedMethods: ['searchRecordingIdentities', 'searchArtists'] }],
      search: async () => ({ items: [], total: 0 }),
      recordingSearch: async (_id, _query, _signal, offset = 0) => {
        offsets.push(offset)
        return { total: variant === 'over-budget' ? 41 : offset && variant === 'changed' ? 12 : 11,
          items: Array.from({ length: offset ? 1 : 10 }, (_, index) => ({ ...page().items[0],
            id: offset && variant === 'duplicate' ? '123' : String(123 + offset + index),
            title: offset ? 'Other' : index ? 'Different' : 'Song' })) }
      }
    })
    const r = await adapter.recall(input, new AbortController().signal)
    assert.equal(r.proposals.length, variant === 'complete' ? 1 : 0, variant)
    assert.deepEqual(offsets, variant === 'over-budget' ? [0, 0] : [0, 10])
  }
})

test('feature credits and whole joined performer strings match without discarding any artist or version', t => {
  const db = seed(t), original = db.identificationInput(db.catalogQuery({ kind: 'recording' }).items[0].id)
  const match = (title: string, names: string[], remote: PlatformRecordingPage) => {
    const input = structuredClone(original), source = input.sources![0]
    source.tags.title!.value = title;source.tags.artists!.value = names
    return platformRecordingReferences(input, [{ sourceId: source.sourceId, page: remote }])
  }
  assert.deepEqual(match('Song', ['AC/DC & Guest'], page()), ['123'])
  assert.deepEqual(match('Song (feat. Guest)', ['AC/DC'], page()), ['123'])
  assert.deepEqual(match('Song', ['Guest', 'AC/DC'], page()), ['123'])
  const featured = page();featured.items[0].title = 'Song (feat. Guest)'
  assert.deepEqual(match('Song', ['AC/DC & Guest'], featured), ['123'])
  assert.deepEqual(match('Song (feat. Other)', ['AC/DC'], page()), [])
  assert.deepEqual(match('Song', ['AC/DC'], page()), [], 'an uncredited guest still requires review')
  for (const version of ['Live', 'Remix', 'Instrumental', 'Moment']) {
    assert.deepEqual(match(`Song (${version})`, ['AC/DC & Guest'], page()), [])
  }
  const artist = { ...original, kind: 'artist' as const, name: 'AC/DC & Guest' }
  artist.sources![0].tags.artists!.value = ['AC/DC & Guest']
  assert.deepEqual(platformRecordingReferences(artist, [{ sourceId: artist.sources![0].sourceId, page: page() }]), [])
})

test('native artist aliases corroborate the exact ID and preserve homonym ambiguity', t => {
  const db = seed(t), input = db.identificationInput(db.catalogQuery({ kind: 'recording' }).items[0].id)
  const p = page();p.items[0].artists[0] = { id: '42', name: '日本語名', aliases: ['AC/DC'] }
  const samples = [{ sourceId: input.sources![0].sourceId, page: p }]
  assert.deepEqual(platformRecordingReferences(input, samples), ['123'])
  assert.deepEqual(platformRecordingReferences({ ...input, kind: 'artist', name: 'AC/DC' }, samples), ['42'])
  p.items.push({ ...structuredClone(p.items[0]), id: '124', artists: [{ id: '99', name: '同名人物', aliases: ['AC/DC'] }, { id: '43', name: 'Guest' }] });p.total = 2
  assert.deepEqual(platformRecordingReferences({ ...input, kind: 'artist', name: 'AC/DC' }, samples), ['42', '99'])
  p.items[0].artists[0].id = null
  assert.equal(validPlatformRecordingPage(p), false, 'aliases without an owning native ID are not proof')
})

test('over-broad searches narrow by the observed album without treating a truncated page as unique', async t => {
  const db = seed(t), input = db.identificationInput(db.catalogQuery({ kind: 'recording' }).items[0].id)
  const queries: string[] = []
  const adapter = new PlatformIdentificationProvider('ncm', {
    inventory: () => [{ id: 'ncm', enabled: true, configuration: '1', supportedMethods: ['searchRecordingIdentities'] }],
    recordingSearch: async (_id, query) => { queries.push(query);return { ...page(), total: query.endsWith(' Album') ? 1 : 41 } },
    search: async () => { throw Error('unexpected name-only search') }
  })
  const result = await adapter.recall(input, new AbortController().signal)
  assert.equal(result.proposals[0].evidence.verification?.method, 'platform_recordings')
  assert.deepEqual(queries, ['Song AC/DC/Guest', 'Song AC/DC/Guest Album'])
})

test('artist alias lookup is optional, ID-checked, cached, and accepted by database proof recomputation', async t => {
  const db = seed(t), input = db.identificationInput(db.catalogQuery({ kind: 'recording' }).items[0].id)
  let calls = 0, wrongId = false
  const adapter = new PlatformIdentificationProvider('ncm', {
    inventory: () => [{ id: 'ncm', enabled: true, configuration: wrongId ? 'changed' : '1', supportedMethods: ['searchRecordingIdentities', 'fetchArtistIdentity'] }],
    recordingSearch: async () => { const p = page();p.items[0].artists[0].name = '日本語名';return p },
    artistIdentity: async (_provider, id) => { calls++;return { id: wrongId ? '999' : id, name: id === '42' ? '日本語名' : 'Guest', aliases: id === '42' ? ['AC/DC'] : [] } },
    search: async () => { throw Error('unexpected name-only search') }
  })
  const request = { enabled: true, newImports: true, history: false,
    providers: [{ id: adapter.id, matcherVersion: adapter.matcherVersion, kinds: ['recording'] as CatalogKind[] }] }
  db.identificationSchedule(request, 1000)
  const work = db.metadataClaim(1000)!
  const result = await adapter.recall(work.identification!, new AbortController().signal)
  assert.equal(result.proposals[0].evidence.verification?.method, 'platform_recordings')
  await adapter.recall(input, new AbortController().signal)
  assert.equal(calls, 2, 'two distinct artist IDs should each be loaded once')
  assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1001, request), true)
  assert.equal(db.identificationDetail(input.entityId).link?.state, 'confirmed')
  wrongId = true
  await assert.rejects(adapter.recall(input, new AbortController().signal), /invalid_provider_artist_identity/)
})

for (const change of ['cancel', 'configuration'] as const) {
  test(`a late artist alias reply cannot escape ${change}`, async t => {
    const db = seed(t), input = db.identificationInput(db.catalogQuery({ kind: 'recording' }).items[0].id)
    let configuration = '1', release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const adapter = new PlatformIdentificationProvider('ncm', {
      inventory: () => [{ id: 'ncm', enabled: true, configuration, supportedMethods: ['searchRecordingIdentities', 'fetchArtistIdentity'] }],
      recordingSearch: async () => { const p = page();p.items[0].artists[0].name = '日本語名';return p },
      artistIdentity: async (_provider, id) => {
        entered();await pending
        return { id, name: '日本語名', aliases: ['AC/DC'] }
      },
      search: async () => { throw Error('unexpected name-only search') }
    })
    const controller = new AbortController(), result = adapter.recall(input, controller.signal)
    await started
    if (change === 'cancel') controller.abort(new Error('user cancelled'))
    else configuration = '2'
    release()
    await assert.rejects(result, change === 'cancel' ? /user cancelled/ : /provider_configuration_changed/)
  })
}
