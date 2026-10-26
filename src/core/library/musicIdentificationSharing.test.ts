import assert from 'node:assert/strict'
import test from 'node:test'
import { IdentificationResponseCache } from './identificationResponseCache.ts'
import {
  MusicBrainzIdentificationProvider,
  PlatformIdentificationProvider
} from './musicIdentificationProvider.ts'
import { MetadataHttpError } from './metadataHttp.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type {
  IdentificationInput,
  IdentificationSourceInput
} from '../../shared/musicIdentification.ts'
import type { TrackData } from '../../shared/track.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const policy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: false,
  contact: 'https://example.com/app'
}
const query = {
  provider: 'musicbrainz',
  context: 'approved',
  method: 'artist',
  parameters: ['Artist', 10, 0, 'en']
}
const signal = () => new AbortController().signal
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const positive = <T>(value: T) => ({ value, retention: 'positive' as const })
const source = (seconds = 200.25): IdentificationSourceInput => ({
  sourceId: 'source',
  provider: 'local',
  trackId: 'track',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  albumArtist: '',
  artists: [{ name: 'Artist' }],
  artistIndexes: [0],
  duration: seconds,
  tags: {
    version: 1,
    scope: 'audio_file',
    durationSeconds: { value: seconds, origin: 'audio_tag' }
  }
})
const input = (
  kind: IdentificationInput['kind'] = 'artist',
  seconds = 200.25
): IdentificationInput => ({
  entityId: 'entity',
  kind,
  version: 'input-1',
  linkRevision: 0,
  name: kind === 'artist' ? 'Artist' : kind === 'recording' ? 'Song' : 'Album',
  artist: kind === 'artist' ? '' : 'Artist',
  sources: [source(seconds)]
})

test('serial requests reuse raw snapshots with original retrieval time and independent mutable copies', async () => {
  let now = 1000,
    calls = 0
  const cache = new IdentificationResponseCache({ now: () => now })
  const load = async () => {
    calls++
    return positive({ items: [{ id: '42' }] })
  }
  const first = await cache.read(query, signal(), load)
  first.value.items[0].id = 'changed'
  now = 2000
  const second = await cache.read(query, signal(), load)
  assert.equal(calls, 1)
  assert.deepEqual(second, { value: { items: [{ id: '42' }] }, retrievedAt: 1000 })
})

test('provider, context, method and exact parameters including language and page isolate responses', async () => {
  const cache = new IdentificationResponseCache()
  let calls = 0
  const load = async () => positive(++calls)
  const variants = [
    query,
    { ...query, provider: 'platform.ncm' },
    { ...query, context: 'account-2' },
    { ...query, method: 'recording' },
    { ...query, parameters: ['artist', 10, 0, 'en'] },
    { ...query, parameters: ['Artist', 10, 10, 'en'] },
    { ...query, parameters: ['Artist', 10, 0, 'zh'] }
  ]
  for (const q of [...variants, ...variants]) await cache.read(q, signal(), load)
  assert.equal(calls, variants.length)
})

test('positive and true-not-found snapshots expire on separate fixed deadlines, not cache hits', async () => {
  let now = 0,
    calls = 0
  const cache = new IdentificationResponseCache({ now: () => now })
  const load = async () => {
    calls++
    return positive('found')
  }
  const empty = async () => {
    calls++
    return { value: [], retention: 'negative' as const }
  }
  const negative = { ...query, parameters: ['missing'] }
  await cache.read(query, signal(), load)
  await cache.read(negative, signal(), empty)
  now = 59_999
  await cache.read(negative, signal(), empty)
  now = 60_000
  await cache.read(negative, signal(), empty)
  await cache.read(query, signal(), load)
  assert.equal(calls, 3)
  now = 300_000
  await cache.read(query, signal(), load)
  assert.equal(calls, 4)
})

test('LRU entry, aggregate byte and per-response limits bound retained data without truncating results', async () => {
  for (const options of [{ maxEntries: 2 }, { maxBytes: 140 }, { maxResponseBytes: 30 }]) {
    const cache = new IdentificationResponseCache(options)
    let calls = 0
    const load = async () => {
      calls++
      return positive('x'.repeat(40))
    }
    for (const name of ['one', 'two', 'three', 'one'])
      assert.equal(
        (await cache.read({ ...query, parameters: [name] }, signal(), load)).value.length,
        40
      )
    assert.equal(calls, 4)
  }
  const cache = new IdentificationResponseCache({ maxEntries: 2 })
  let calls = 0
  const load = async () => positive(++calls)
  for (const name of ['one', 'two', 'one', 'three', 'one', 'two'])
    await cache.read({ ...query, parameters: [name] }, signal(), load)
  assert.equal(calls, 4)
})

test('one cancellation leaves shared I/O alive; last cancellation aborts and rejects late publication', async () => {
  const cache = new IdentificationResponseCache()
  let release!: (v: ReturnType<typeof positive>) => void,
    upstream!: AbortSignal,
    calls = 0
  const load = async (sig: AbortSignal) => {
    calls++
    upstream = sig
    return new Promise<ReturnType<typeof positive>>((resolve) => {
      release = resolve
    })
  }
  const a = new AbortController(),
    b = new AbortController()
  const first = cache.read(query, a.signal, load),
    rejected = assert.rejects(first, /first left/)
  const second = cache.read(query, b.signal, load)
  await tick()
  a.abort(new Error('first left'))
  await rejected
  assert.equal(upstream.aborted, false)
  release(positive('ok'))
  assert.equal((await second).value, 'ok')
  assert.equal(calls, 1)
  cache.invalidate(query.provider)
  const c = new AbortController()
  const abandoned = cache.read(query, c.signal, load),
    cancelled = assert.rejects(abandoned, /last left/)
  await tick()
  c.abort(new Error('last left'))
  await cancelled
  assert.equal(upstream.aborted, true)
  release(positive('late'))
  await tick()
  assert.equal((await cache.read(query, signal(), async () => positive('fresh'))).value, 'fresh')
})

test('provider invalidation aborts all affected waiters even when the transport ignores cancellation', async () => {
  const cache = new IdentificationResponseCache()
  let release!: (v: ReturnType<typeof positive>) => void
  const first = cache.read(
    query,
    signal(),
    () =>
      new Promise<ReturnType<typeof positive>>((resolve) => {
        release = resolve
      })
  )
  const second = cache.read(query, signal(), async () => assert.fail('shared'))
  const rejected = Promise.all([
    assert.rejects(first, /context changed/),
    assert.rejects(second, /context changed/)
  ])
  await tick()
  await cache.read({ ...query, provider: 'other' }, signal(), async () => positive('other'))
  cache.invalidate(query.provider)
  await rejected
  release(positive('stale-account'))
  await tick()
  assert.equal(
    (await cache.read(query, signal(), async () => positive('current-account'))).value,
    'current-account'
  )
  assert.equal(
    (
      await cache.read({ ...query, provider: 'other' }, signal(), async () =>
        assert.fail('unaffected')
      )
    ).value,
    'other'
  )
})

test('pre-cancelled reads, rejected loads and non-retainable responses never create a reusable result', async () => {
  const cache = new IdentificationResponseCache(),
    c = new AbortController()
  c.abort(new Error('before read'))
  await assert.rejects(
    cache.read(query, c.signal, async () => assert.fail('pre-cancelled')),
    /before read/
  )
  let calls = 0
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      cache.read(query, signal(), async () => {
        calls++
        throw new MetadataHttpError('busy', 429, 10000)
      }),
      (e: unknown) => e instanceof MetadataHttpError && e.retryAt === 10000
    )
    await cache.read(query, signal(), async () => {
      calls++
      return { value: 'malformed', retention: false }
    })
  }
  assert.equal(calls, 4)
})

test('100 same-name MB entity queries share one search, not evidence or confirmation', async () => {
  let calls = 0,
    now = 1000
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => {
      calls++
      return json({
        count: 1,
        recordings: [
          { id: id(1), title: 'Song', length: 200250, 'artist-credit': [{ name: 'Artist' }] }
        ]
      })
    },
    () => now
  )
  for (let n = 0; n < 100; n++) {
    now++
    const result = await p.recall(
      { ...input('recording', n % 2 ? 210 : 200.25), entityId: `entity-${n}` },
      signal()
    )
    assert.equal(result.proposals[0].evidence.conflicts.includes('duration'), n % 2 === 1)
    assert.equal(result.proposals[0].evidence.verification, undefined)
    assert.equal(JSON.parse(result.proposals[0].evidence.provenance).retrievedAt, 1001)
    result.proposals[0].evidence.conflicts.push('consumer-only')
  }
  assert.equal(calls, 1)
})

test('shared MB typed ID lookup independently verifies raw names and source IDs', async () => {
  let calls = 0
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => {
      calls++
      return json({ id: id(1), name: 'Artist', type: 'Person' })
    }
  )
  const first = input(),
    second = input()
  first.sources![0].tags.musicbrainz = { artistIds: [id(1)], albumArtistIds: [] }
  second.sources![0].sourceId = 'other-source'
  second.sources![0].tags = {
    ...first.sources![0].tags,
    artists: { value: ['Different artist'], origin: 'audio_tag' }
  }
  assert.deepEqual(
    (await p.recall(first, signal())).proposals[0].evidence.verification?.sourceIds,
    ['source']
  )
  const result = await p.recall(second, signal())
  assert.ok(result.proposals[0].evidence.conflicts.includes('raw_artist_name'))
  assert.equal(result.proposals[0].evidence.verification, undefined)
  assert.equal(calls, 1)
})

test('recreated platform adapters share sanitized search responses and isolate methods, configuration and disablement', async () => {
  const cache = new IdentificationResponseCache(),
    methods = ['searchArtists', 'searchSongs', 'searchAlbums']
  const platform = { id: 'ncm', enabled: true, configuration: '1', supportedMethods: methods }
  let calls = 0
  const adapter = () =>
    new PlatformIdentificationProvider('ncm', {
      responses: cache,
      inventory: () => [platform],
      search: async (_id, method) => {
        calls++
        return {
          total: 1,
          items: [
            {
              id: 'ncm:42',
              name: 'Artist',
              title: 'Song',
              artist: 'Artist',
              duration: 200.25,
              source: 'ncm',
              filePath: 'https://secret.invalid/?token=secret',
              cookie: 'credential',
              lyrics: 'private'
            }
          ],
          method
        }
      }
    })
  for (let n = 0; n < 100; n++)
    await adapter().recall({ ...input(), entityId: `entity-${n}` }, signal())
  assert.equal(calls, 1)
  const retained = Reflect.get(cache, 'cached') as Map<string, unknown>
  assert.doesNotMatch(
    JSON.stringify([...retained.values()]),
    /secret|credential|private|filePath|lyrics|cookie/
  )
  await adapter().recall(input('recording'), signal())
  assert.equal(calls, 2)
  platform.configuration = '2'
  await adapter().recall(input(), signal())
  assert.equal(calls, 3)
  platform.enabled = false
  await assert.rejects(adapter().recall(input(), signal()), /provider_disabled/)
  assert.equal(calls, 3)
})

test('MB empty searches and 404 IDs use negative expiry while HTTP failures and malformed pages are retried', async () => {
  let now = 0,
    calls = 0,
    mode = 'empty'
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async () => {
      calls++
      return mode === 'empty'
        ? json({ count: 0, artists: [] })
        : mode === 'missing'
          ? json({}, 404)
          : mode === 'error'
            ? json({}, 503)
            : json({ artists: [] })
    },
    () => now
  )
  await p.recall(input(), signal())
  await p.recall(input(), signal())
  assert.equal(calls, 1)
  now = 60_000
  mode = 'invalid'
  await p.recall(input(), signal())
  await p.recall(input(), signal())
  assert.equal(calls, 3)
  mode = 'error'
  await assert.rejects(p.recall(input(), signal()), /metadata_http_503/)
  await assert.rejects(p.recall(input(), signal()), /metadata_http_503/)
  assert.equal(calls, 5)
  const i = input()
  i.sources![0].tags.musicbrainz = { artistIds: [id(1)], albumArtistIds: [] }
  mode = 'missing'
  await p.recall(i, signal())
  await p.recall(i, signal())
  assert.equal(calls, 6)
})

function album(db: LibraryDatabase, folder: string, changed = false) {
  const tracks: TrackData[] = [1, 2].map((n) => ({
    id: `${folder}-${n}`,
    source: 'local',
    filePath: `D:/music/${folder}/${n}.flac`,
    fileName: `${n}.flac`,
    title: `Song ${n}`,
    artist: 'Artist',
    album: 'Album',
    duration: 200.25,
    size: 0,
    cover: null,
    lyrics: null,
    identityTags: {
      version: 1,
      scope: 'audio_file',
      title: { value: `Song ${n}`, origin: 'audio_tag' },
      artists: { value: ['Artist'], origin: 'audio_tag' },
      album: { value: 'Album', origin: 'audio_tag' },
      durationSeconds: { value: changed && n === 2 ? 210 : 200.25, origin: 'audio_tag' },
      trackNumber: { value: n, origin: 'audio_tag' },
      trackTotal: { value: 2, origin: 'audio_tag' },
      discNumber: { value: 1, origin: 'audio_tag' },
      discTotal: { value: 1, origin: 'audio_tag' }
    }
  }))
  db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return (kind: IdentificationInput['kind']) => db.catalogQuery({ kind }).items[0].id
}

for (const provider of ['musicbrainz', 'platform.ncm'] as const) {
  test(`${provider} shares album queries and full track responses but revalidates each local album in its own finish transaction`, async (t) => {
    const a = new LibraryDatabase(':memory:'),
      b = new LibraryDatabase(':memory:')
    t.after(() => {
      a.close()
      b.close()
    })
    const aId = album(a, 'first'),
      bId = album(b, 'second', true),
      calls: string[] = []
    const credit = [{ name: 'Artist', artist: { name: 'Artist', id: id(1) } }]
    const p =
      provider === 'musicbrainz'
        ? new MusicBrainzIdentificationProvider(
            () => policy,
            async (u) => {
              const url = new URL(String(u))
              calls.push(url.href)
              if (url.searchParams.has('query'))
                return json({
                  count: 1,
                  'release-groups': [
                    { id: id(2), title: 'Album', 'primary-type': 'Album', 'artist-credit': credit }
                  ]
                })
              if (url.searchParams.has('release-group'))
                return json({ 'release-count': 1, releases: [{ id: id(3) }] })
              return json({
                id: id(3),
                title: 'Album',
                'release-group': { id: id(2) },
                'artist-credit': credit,
                media: [
                  {
                    position: 1,
                    'track-count': 2,
                    tracks: [1, 2].map((n) => ({
                      position: n,
                      title: `Song ${n}`,
                      id: id(10 + n),
                      length: 200250,
                      'artist-credit': credit,
                      recording: { id: id(20 + n) }
                    }))
                  }
                ]
              })
            }
          )
        : new PlatformIdentificationProvider('ncm', {
            inventory: () => [
              {
                id: 'ncm',
                enabled: true,
                configuration: '1',
                supportedMethods: ['searchAlbums', 'fetchAlbumIdentity']
              }
            ],
            search: async () => {
              calls.push('search')
              return { items: [{ id: '42', name: 'Album', artist: 'Artist' }], total: 1 }
            },
            albumIdentity: async () => {
              calls.push('album')
              return {
                schemaVersion: 1,
                provider: 'ncm',
                id: '42',
                title: 'Album',
                artists: [{ id: '7', name: 'Artist' }],
                trackCount: 2,
                complete: true,
                tracks: [1, 2].map((n) => ({
                  id: String(100 + n),
                  title: `Song ${n}`,
                  artists: [{ id: '7', name: 'Artist' }],
                  durationSeconds: 200.25,
                  disc: 1,
                  position: n,
                  isrcs: []
                }))
              }
            }
          })
    const kind = provider === 'musicbrainz' ? 'album_project' : 'release'
    for (const [db, target] of [
      [a, aId(kind)],
      [b, bId(kind)]
    ] as const) {
      db.identificationEnqueue(
        {
          entityId: target,
          batchId: 'batch',
          providers: [{ id: p.id, matcherVersion: p.matcherVersion }]
        },
        1000
      )
      const work = db.metadataClaim(1000)!
      const result = await p.recall(work.identification!, signal())
      assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1001), true)
    }
    assert.equal(calls.length, provider === 'musicbrainz' ? 3 : 2)
    assert.equal(a.identificationDetail(aId(kind)).link?.state, 'confirmed')
    assert.equal(b.identificationDetail(bId(kind)).link?.state, 'unresolved')
    assert.ok(
      b.identificationCandidates({ entityId: bId(kind) }).items[0].evidence.conflicts.length
    )
    assert.equal(
      b
        .catalogQuery({ kind: 'recording' })
        .items.some((e) => b.identificationDetail(e.id).link?.state === 'confirmed'),
      false
    )
  })
}

test('serial Core jobs keep source-scoped candidates and user rejection while reusing one platform response', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const target = album(db, 'library')('artist')
  let calls = 0
  const cache = new IdentificationResponseCache()
  const inventory = [
    { id: 'ncm', enabled: true, configuration: '1', supportedMethods: ['searchArtists'] }
  ]
  const adapter = () =>
    new PlatformIdentificationProvider('ncm', {
      responses: cache,
      inventory: () => inventory,
      search: async () => {
        calls++
        return { total: 1, items: [{ id: '7', name: 'Artist' }] }
      }
    })
  const database = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
  const service = new CoreEntityMetadataService({
    database,
    provider: new MusicBrainzWikiProvider(() => policy),
    identificationProviders: () => [adapter()],
    policy: () => policy,
    now: () => 1000,
    changed() {},
    failed(e) {
      assert.fail(String(e))
    }
  })
  t.after(() => service.shutdown())
  service.activate()
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (check()) return
      await tick()
    }
    assert.fail('Core did not publish')
  }
  for (const artist of db.catalogQuery({ kind: 'artist' }).items) {
    await service.startIdentification({ entityId: artist.id, batchId: `entity-${artist.id}` })
    await wait(() => db.identificationCandidates({ entityId: artist.id }).total > 0)
  }
  const candidate = db.identificationCandidates({ entityId: target }).items[0]
  await service.decideIdentity({
    candidateId: candidate.id,
    revision: candidate.revision,
    linkRevision: candidate.linkRevision,
    decision: 'reject'
  })
  db.sql.prepare("UPDATE catalog_entities SET title='Artist ' WHERE id=?").run(target)
  db.sql.prepare("UPDATE catalog_entities SET title='Artist' WHERE id=?").run(target)
  await service.startIdentification({ entityId: target, batchId: 'again' })
  await wait(() =>
    db
      .identificationCandidates({ entityId: target })
      .items.some((c) => c.inputVersion !== candidate.inputVersion)
  )
  assert.equal(calls, 1)
  assert.equal(db.identificationDetail(target).link?.state, 'unresolved')
  assert.ok(db.identificationCandidates({ entityId: target }).items.every((c) => c.suppressed))
})

test('Core recovers the active generation on an account context change and drops the old transport result', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const target = album(db, 'context')('artist'),
    cache = new IdentificationResponseCache()
  const platform = {
    id: 'ncm',
    enabled: true,
    configuration: 'account-one',
    supportedMethods: ['searchArtists']
  }
  let calls = 0,
    late!: (v: unknown) => void
  const adapter = () =>
    new PlatformIdentificationProvider('ncm', {
      responses: cache,
      inventory: () => [platform],
      search: async () => {
        calls++
        return calls === 1
          ? new Promise((resolve) => {
              late = resolve
            })
          : { total: 1, items: [{ id: '8', name: 'Artist' }] }
      }
    })
  const database = new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
  const service = new CoreEntityMetadataService({
    database,
    provider: new MusicBrainzWikiProvider(() => policy),
    identificationProviders: () => [adapter()],
    policy: () => policy,
    now: () => 1000,
    changed() {},
    failed(e) {
      assert.fail(String(e))
    }
  })
  t.after(() => service.shutdown())
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (check()) return
      await tick()
    }
    assert.fail('Core did not resume')
  }
  service.activate()
  const {
    jobs: [job]
  } = await service.startIdentification({ entityId: target, batchId: 'manual' })
  await wait(() => calls === 1)
  platform.configuration = 'account-two'
  cache.invalidate('platform.ncm')
  service.refreshIdentification(false, 'platform.ncm')
  await wait(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'needs_review')
  assert.equal(calls, 2)
  assert.ok(db.metadataJobs({ jobId: job.id }).items[0].generation > job.generation)
  late({ total: 1, items: [{ id: '7', name: 'Artist' }] })
  await tick()
  assert.deepEqual(
    db.identificationCandidates({ entityId: target }).items.map((c) => c.references[0].value),
    ['8']
  )
})

test('adapter callers cancel independently while sharing one real MB request', async () => {
  let finish!: () => void,
    actualSignal!: AbortSignal,
    calls = 0
  const p = new MusicBrainzIdentificationProvider(
    () => policy,
    async (_url, options) => {
      calls++
      actualSignal = options!.signal!
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return json({ count: 1, artists: [{ id: id(1), name: 'Artist', type: 'Person' }] })
    }
  )
  const a = new AbortController(),
    b = new AbortController()
  const one = p.recall(input(), a.signal),
    rejected = assert.rejects(one, /cancel entity one/)
  const two = p.recall({ ...input(), entityId: 'entity-two' }, b.signal)
  await tick()
  a.abort(new Error('cancel entity one'))
  await rejected
  assert.equal(actualSignal.aborted, false)
  finish()
  assert.equal((await two).proposals.length, 1)
  assert.equal(calls, 1)
})
