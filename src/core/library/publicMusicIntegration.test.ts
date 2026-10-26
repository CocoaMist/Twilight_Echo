import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { PublicMusicSource, type PublicMusicPolicy } from './publicMusicSources.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'
import type { MusicExternalReference } from '../../shared/musicIdentification.ts'

const MB = '151bb385-1af0-40b6-9269-bf2ed982311f'
const signal = () => new AbortController().signal
const json = (value: unknown) => new Response(JSON.stringify(value))
function seed(db: LibraryDatabase) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'song',
        source: 'local',
        filePath: 'D:/music/test.flac',
        title: 'Song',
        artist: 'Camellia',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return db.catalogQuery({ kind: 'artist' }).items[0].id
}
const asyncDb = (db: LibraryDatabase) =>
  new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
const confirm = (db: LibraryDatabase, entityId: string, refs: MusicExternalReference[]) => {
  const [candidate] = db.identificationPublish(
    db.identificationInput(entityId),
    [
      {
        provider: refs[0].provider,
        name: 'Camellia',
        summary: 'Fixture',
        matcherVersion: 'fixture',
        references: refs,
        evidence: {
          origin: 'search',
          matches: [],
          missing: ['review'],
          conflicts: [],
          incomplete: false,
          provenance: 'fixture'
        }
      }
    ],
    1000
  )
  db.identificationDecide(
    {
      candidateId: candidate.id,
      revision: candidate.revision,
      linkRevision: candidate.linkRevision,
      decision: 'confirm'
    },
    1001
  )
}
test('independently confirmed native identities combine languages, image handles and source preferences without MB', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db),
    original = db.queryTracks({ limit: 1 }).tracks[0]
  confirm(
    db,
    entityId,
    ['vocadb', 'theaudiodb', 'discogs'].map((provider, i) => ({
      provider,
      kind: 'artist',
      idType: 'native',
      value: String(i + 1)
    }))
  )
  let now = 2000
  const p: PublicMusicPolicy = {
    enabled: true,
    contact: 'https://example.org/player',
    musicbrainzApproved: false,
    vocadb: true,
    theaudiodb: true,
    audioDbKey: '123',
    discogs: true,
    discogsToken: ''
  }
  const providers = ['vocadb', 'theaudiodb', 'discogs'].map(
    (id) =>
      new PublicMusicSource(
        id as 'vocadb',
        () => p,
        async (url) => {
          if (String(url).includes('musicbrainz'))
            throw new Error('Native identity must not require MB')
          if (String(url).includes('vocadb'))
            return json({
              id: 1,
              name: 'Camellia',
              description: { english: 'VocaDB long introduction' }
            })
          if (String(url).includes('theaudiodb'))
            return json({
              artists: [
                {
                  idArtist: '2',
                  strArtist: 'Camellia',
                  strBiographyCN: '中文资料',
                  strCreativeCommons: 'Yes',
                  strArtistThumb: 'https://r2.theaudiodb.com/images/media/artist/thumb/test.jpg'
                }
              ]
            })
          return json({ id: 3, name: 'Camellia', profile: 'Discogs profile' })
        },
        () => now
      )
  )
  const makeCore = () =>
    new CoreEntityMetadataService({
      database: asyncDb(db),
      provider: {
        id: 'musicbrainz-wiki',
        capabilities: {
          entities: ['artist'],
          fields: ['name', 'description', 'introduction'],
          explicitIdentity: true
        },
        resolve: async () => null,
        enrich: async () => []
      },
      enrichmentProviders: () => providers,
      artwork: async () => 'twilight-media://image/test-grant',
      policy: () => ({
        enabled: true,
        publicServiceApproved: false,
        wikipediaText: false,
        contact: p.contact
      }),
      now: () => now,
      changed() {},
      failed(error) {
        throw error
      }
    })
  let core = makeCore()
  t.after(() => core.shutdown())
  for (const provider of providers)
    await core.enrich({
      entityId,
      provider: provider.id,
      language: 'zh-Hans',
      batchId: provider.id
    })
  core.activate()
  for (
    let i = 0;
    i < 300 && db.metadataJobs({ entityId }).items.some((j) => j.state !== 'completed');
    i++
  )
    await new Promise((r) => setImmediate(r))
  assert.ok(db.metadataJobs({ entityId }).items.every((j) => j.state === 'completed'))
  const health = await core.inspectHealth(entityId, 'zh-Hans')
  assert.equal(health.enrichment.find((p) => p.id === 'theaudiodb')?.artwork, true)
  assert.equal(health.enrichment.find((p) => p.id === 'vocadb')?.artwork, undefined)
  const detail = await core.detail(entityId, 'zh-Hans')
  assert.equal(detail.introduction?.value, '中文资料')
  assert.deepEqual(detail.sourceOptions, ['discogs', 'theaudiodb', 'vocadb'])
  assert.equal(detail.artwork?.[0].handle, 'twilight-media://image/test-grant')
  assert.equal(detail.artwork?.[0].targetRef.value, '2')
  assert.equal(JSON.stringify(detail).includes('https://r2.theaudiodb.com'), false)
  db.metadataSourcePreference(
    { entityId, revision: detail.revision, provider: 'vocadb', language: 'zh-Hans' },
    now
  )
  assert.equal(
    (await core.detail(entityId, 'zh-Hans')).introduction?.value,
    'VocaDB long introduction'
  )
  await core.shutdown()
  core = makeCore()
  assert.equal(
    (await core.detail(entityId, 'zh-Hans')).introduction?.attribution?.provider,
    'vocadb'
  )
  p.theaudiodb = false
  assert.equal((await core.detail(entityId, 'zh-Hans')).artwork, undefined)
  now += 6 * 3600000 + 1
  assert.equal(
    (await core.detail(entityId, 'zh-Hans')).facts.some(
      (f) => f.attribution.provider === 'discogs'
    ),
    false
  )
  assert.deepEqual(db.queryTracks({ limit: 1 }).tracks[0], original)
})

test('MB-only confirmed identities route public providers by exact cross-reference; native IDs take priority', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db)
  confirm(db, entityId, [{ provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: MB }])
  for (const provider of ['vocadb', 'theaudiodb', 'discogs']) {
    const job = db.metadataEnqueue(
      {
        entityId,
        type: 'enrich',
        provider,
        language: 'en',
        batchId: provider,
        providerContext: 'context'
      },
      2000
    )
    assert.equal(job.externalId, MB)
  }
  const ref = { provider: 'vocadb', kind: 'artist' as const, idType: 'native', value: '445' }
  confirm(db, entityId, [
    { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: MB },
    ref
  ])
  const job = db.metadataEnqueue(
    {
      entityId,
      type: 'enrich',
      provider: 'vocadb',
      language: 'en',
      batchId: 'native',
      providerContext: 'context'
    },
    3000
  )
  assert.equal(job.externalId, '445')
})

test('new provider recalls retain existing input-revision fences and never confirm a single name result', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db),
    provider = new PublicMusicSource(
      'vocadb',
      () => ({
        enabled: true,
        contact: 'test',
        musicbrainzApproved: false,
        vocadb: true,
        theaudiodb: false,
        audioDbKey: '',
        discogs: false,
        discogsToken: ''
      }),
      async () => json({ totalCount: 1, items: [{ id: 445, name: 'Camellia' }] })
    )
  db.identificationEnqueue(
    {
      entityId,
      batchId: 'test',
      providers: [{ id: 'vocadb', matcherVersion: provider.matcherVersion }]
    },
    2000
  )
  const work = db.metadataClaim(2000)!,
    result = await provider.recall(work.identification!, signal())
  db.metadataFinish(work, { state: 'identified', ...result }, 2001)
  assert.notEqual(db.identificationDetail(entityId).link?.state, 'confirmed')
  assert.equal(db.metadataJobs({ entityId }).items[0].state, 'needs_review')
  db.identificationEnqueue(
    {
      entityId,
      batchId: 'test2',
      providers: [{ id: 'vocadb', matcherVersion: provider.matcherVersion + '-new' }]
    },
    2000 + 86400001
  )
  const second = db.metadataClaim(2000 + 86400001)!
  db.patchTracks([
    {
      id: 'song',
      expectedVersion: db.queryTracks({ limit: 1 }).versions.song,
      patch: { artist: 'Different artist' }
    }
  ])
  while (db.catalogStatus().localPending) db.catalogAdvance()
  assert.equal(
    db.metadataFinish(second, { state: 'identified', ...result }, 2002 + 86400001),
    false
  )
})
