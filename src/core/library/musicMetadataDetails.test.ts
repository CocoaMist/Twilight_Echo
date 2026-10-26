import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_METADATA_DETAILS_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataPolicy
} from '../../shared/entityMetadata.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { MusicCreditTarget } from '../../shared/musicCredits.ts'
import {
  MusicBrainzWikiProvider,
  MusicBrainzDetailsProvider,
  MetadataIdentityError
} from './entityMetadataProvider.ts'
import { musicBrainzCredits } from './musicBrainzCredits.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { validEntityMetadataPayload } from '../../shared/entityMetadata.ts'
import { coreOperation } from '../../shared/coreProtocol.ts'

const GROUP = 'b1392450-e666-3926-a536-22c65f834433'
const RELEASE = '11111111-1111-4111-8111-111111111111'
const RECORDING = '22222222-2222-4222-8222-222222222222'
const WORK = '33333333-3333-4333-8333-333333333333'
const A = '44444444-4444-4444-8444-444444444444'
const B = '55555555-5555-4555-8555-555555555555'
const policy: EntityMetadataPolicy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: true,
  contact: 'https://github.com/Px-asen/Twilight_Echo'
}
const root = (kind: MusicCreditTarget['kind'], value: string): MusicCreditTarget => ({
  provider: 'musicbrainz',
  kind,
  idType: 'mbid',
  value
})
const attribution = {
  provider: 'musicbrainz',
  externalId: RELEASE,
  url: `https://musicbrainz.org/release/${RELEASE}`,
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'MusicBrainz contributors',
  revision: '',
  retrievedAt: 1000
}
const artist = (id = A) => ({ id, name: 'Same name' })
const relation = (type: string, id = A, extra = {}) => ({
  'target-type': 'artist',
  type,
  artist: artist(id),
  'type-id': '66666666-6666-4666-8666-666666666666',
  direction: 'backward',
  attributes: [],
  ...extra
})
function releaseData() {
  const recording = {
    id: RECORDING,
    title: 'One',
    'artist-credit': [
      { artist: artist(A), name: 'First credited name', joinphrase: ' & ' },
      { artist: artist(B), name: 'Second', joinphrase: '' }
    ],
    relations: [
      relation('vocal', A, {
        attributes: ['lead', 'instrument'],
        'attribute-values': { instrument: 'piano' },
        begin: '1997',
        end: '1997-05'
      }),
      relation('mix', B),
      {
        'target-type': 'work',
        type: 'performance',
        work: {
          id: WORK,
          title: 'Work',
          relations: [relation('composer'), relation('lyricist', B)]
        }
      }
    ]
  }
  return {
    id: RELEASE,
    title: 'Album',
    date: '2009-03',
    country: 'GB',
    barcode: '1234567890',
    'artist-credit': [{ artist: artist(), name: 'Artist', joinphrase: '' }],
    relations: [relation('producer'), relation('arranger', B), relation('mixing assistant', B)],
    'release-group': { id: GROUP, relations: [relation('executive producer')] },
    media: [{ tracks: [{ recording }, { recording }] }]
  }
}
function fixture() {
  const state = {
    reciprocal: 'P436',
    pageQid: 'Q202996',
    chineseMissing: false,
    chineseIntroduction: '专辑项目背景介绍',
    calls: [] as URL[],
    data: releaseData() as Record<string, any>
  }
  const provider = new MusicBrainzWikiProvider(
    () => policy,
    async (input) => {
      const url = new URL(String(input))
      state.calls.push(url)
      let data: unknown
      if (url.hostname === 'musicbrainz.org') data = state.data
      else if (url.hostname === 'www.wikidata.org')
        data = {
          entities: {
            Q202996: {
              id: 'Q202996',
              lastrevid: 77,
              claims: { [state.reciprocal]: [{ mainsnak: { datavalue: { value: GROUP } } }] },
              descriptions: { 'zh-hans': { value: 'Radiohead 的录音室专辑' } },
              sitelinks: { zhwiki: { title: 'OK Computer' }, enwiki: { title: 'OK Computer' } }
            }
          }
        }
      else
        data = {
          query: {
            pages: [
              {
                pageid: 123,
                title: 'OK Computer',
                pageprops:
                  url.hostname.startsWith('zh.') && state.chineseMissing
                    ? { disambiguation: '', wikibase_item: state.pageQid }
                    : { wikibase_item: state.pageQid },
                extract: url.hostname.startsWith('zh.')
                  ? state.chineseIntroduction
                  : 'English album introduction',
                revisions: [{ revid: 88 }]
              }
            ]
          }
        }
      return new Response(JSON.stringify(data), { status: 200 })
    },
    () => 1000
  )
  return { state, provider, detail: new MusicBrainzDetailsProvider(() => policy, provider) }
}
function seed(db: LibraryDatabase, kind: CatalogKind, externalId: string) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/music/one.flac',
        title: 'One',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entityId = db.catalogQuery({ kind }).items[0].id
  confirm(db, entityId, kind, externalId)
  return entityId
}
function confirm(db: LibraryDatabase, entityId: string, kind: CatalogKind, externalId: string) {
  const [candidate] = db.identificationPublish(
    db.identificationInput(entityId),
    [
      {
        provider: 'musicbrainz',
        matcherVersion: 'fixture-v1',
        name: 'Album',
        summary: '',
        references: [{ provider: 'musicbrainz', kind, idType: 'mbid', value: externalId }],
        evidence: {
          origin: 'search',
          matches: [],
          missing: ['manual'],
          conflicts: [],
          incomplete: true,
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
const asyncDb = (db: LibraryDatabase) =>
  new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })

test('album projects use reciprocal release-group IDs for Wikipedia and retain first date, type, language and source revision', async () => {
  const { state, detail } = fixture()
  state.chineseIntroduction = '完整专辑作品介绍。'.repeat(180)
  state.data = {
    id: GROUP,
    title: 'OK Computer',
    'first-release-date': '1997-05-21',
    'primary-type': 'Album',
    relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q202996' } }]
  }
  const result = await detail.enrich(
    { kind: 'album_project', externalId: GROUP, language: 'zh-Hant' },
    new AbortController().signal
  )
  assert.equal(state.calls[0].pathname, `/ws/2/release-group/${GROUP}`)
  assert.equal(result.facts.find((f) => f.field === 'firstReleaseDate')?.value, '1997-05-21')
  assert.equal(result.facts.find((f) => f.field === 'primaryType')?.value, 'Album')
  const intro = result.facts.find((f) => f.field === 'introduction')!
  assert.equal(intro.value, state.chineseIntroduction)
  assert.equal(intro.language, 'zh-Hant')
  assert.equal(intro.sourceLanguage, 'zh')
  assert.equal(intro.attribution.revision, '88')
  assert.equal(intro.attribution.license, 'CC-BY-SA-4.0')
  const wiki = state.calls.find(url => url.hostname === 'zh.wikipedia.org')!
  assert.equal(wiki.searchParams.get('exintro'), '1')
  assert.equal(wiki.searchParams.has('exchars'), false, 'MediaWiki clamps exchars to 1200 and truncates the lead')
  assert.equal(
    result.facts.some((f) => f.field === 'releaseDate'),
    false
  )
})

test('wrong typed Wikidata reciprocity and unrelated encyclopedia pages never become album introductions', async () => {
  const { state, detail } = fixture()
  state.data = {
    id: GROUP,
    title: 'Album',
    relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q202996' } }]
  }
  state.reciprocal = 'P434'
  await assert.rejects(
    detail.enrich(
      { kind: 'album_project', externalId: GROUP, language: 'en' },
      new AbortController().signal
    ),
    MetadataIdentityError
  )
  state.reciprocal = 'P436'
  state.pageQid = 'Q1'
  const unrelated = await detail.enrich(
    { kind: 'album_project', externalId: GROUP, language: 'zh-Hans' },
    new AbortController().signal
  )
  assert.equal(
    unrelated.facts.some((f) => f.field === 'introduction'),
    false
  )
  state.pageQid = 'Q202996'
  state.chineseMissing = true
  const fallback = await detail.enrich(
    { kind: 'album_project', externalId: GROUP, language: 'zh-Hans' },
    new AbortController().signal
  )
  assert.equal(fallback.facts.find((f) => f.field === 'introduction')?.language, 'en')
})

test('release date precision and credits stay at their own release, project, recording and work targets', async () => {
  const { detail, state } = fixture()
  const result = await detail.enrich(
    { kind: 'release', externalId: RELEASE, language: 'en' },
    new AbortController().signal
  )
  assert.equal(
    state.calls.length,
    1,
    'a release does not silently fetch the project biography as its own'
  )
  assert.equal(result.facts.find((f) => f.field === 'releaseDate')?.value, '2009-03')
  assert.equal(
    result.facts.some((f) => f.field === 'firstReleaseDate'),
    false
  )
  const credits = result.credits!.items
  assert.equal(credits.find((c) => c.rawRole === 'producer')?.targetRef.value, RELEASE)
  assert.equal(credits.find((c) => c.rawRole === 'executive producer')?.targetRef.value, GROUP)
  assert.equal(credits.find((c) => c.rawRole === 'vocal')?.targetRef.value, RECORDING)
  assert.equal(credits.find((c) => c.rawRole === 'composer')?.targetRef.kind, 'work')
  assert.equal(credits.find((c) => c.rawRole === 'lyricist')?.targetRef.value, WORK)
  assert.equal(credits.find((c) => c.rawRole === 'arranger')?.role, 'arranger')
  assert.equal(credits.find((c) => c.rawRole === 'mix')?.role, 'mix')
  assert.equal(credits.find((c) => c.rawRole === 'mixing assistant')?.role, 'other')
  assert.equal(
    credits.filter((c) => c.rawRole === 'vocal').length,
    1,
    'repeated recording occurrences do not duplicate a relation'
  )
  const main = credits.filter((c) => c.targetRef.value === RECORDING && c.role === 'primary_artist')
  assert.deepEqual(
    main.map((c) => [c.name, c.personRef.value, c.order, c.joinphrase]),
    [
      ['First credited name', A, 0, ' & '],
      ['Second', B, 1, '']
    ]
  )
  const vocal = credits.find((c) => c.rawRole === 'vocal')!
  assert.deepEqual(vocal.attributes, [{ name: 'lead' }, { name: 'instrument', value: 'piano' }])
  assert.equal(vocal.begin, '1997')
  assert.equal(vocal.end, '1997-05')
  assert.equal(vocal.direction, 'backward')
})

test('credit collection is bounded and never creates identity from a same-name or missing-ID participant', () => {
  const result = musicBrainzCredits(
    {
      relations: [
        relation('producer'),
        relation('producer', B),
        relation('producer', 'not-an-id'),
        ...Array.from({ length: 2050 }, (_, i) => relation(`role-${i}`))
      ]
    },
    root('release', RELEASE),
    attribution
  )
  assert.equal(result.items.length, 2048)
  assert.equal(result.truncated, true)
  assert.deepEqual(
    result.items.slice(0, 2).map((c) => c.personRef.value),
    [A, B]
  )
  assert.equal(
    result.items.some((c) => c.personRef.value === 'not-an-id'),
    false
  )
})

test('Core details persist facts and typed credits atomically without changing source tags or asserting child identities', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'release', RELEASE),
    { provider, detail } = fixture()
  const before = db.getContentRevision(),
    entities = db.sql.prepare('SELECT count(*) n FROM metadata_entities').get()!.n
  const core = new CoreEntityMetadataService({
    database: asyncDb(db),
    provider,
    enrichmentProviders: () => [detail],
    policy: () => policy,
    now: () => 2000,
    changed() {},
    failed(error) {
      throw error
    }
  })
  t.after(() => core.shutdown())
  const job = await core.enrich({
    entityId,
    provider: 'musicbrainz-details',
    language: 'en',
    batchId: 'credits'
  })
  core.activate()
  for (let i = 0; i < 500 && db.metadataJobs({ jobId: job.id }).items[0].state !== 'completed'; i++)
    await new Promise<void>((r) => setImmediate(r))
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'completed')
  const result = await core.detail(entityId, 'en')
  assert.ok(result.credits!.items.some((c) => c.targetRef.kind === 'work'))
  assert.equal(db.getContentRevision(), before)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_entities').get()!.n, entities)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_credit_sets').get()!.n, 1)
  assert.equal(db.queryTracks({ limit: 1 }).tracks[0].album, 'Album')
  const identity = db.identificationDetail(entityId)
  await core.detachIdentity(identity.link!.id, identity.link!.revision)
  assert.equal((await core.detail(entityId, 'en')).credits, undefined)
})

test('typed detail results roll back with facts when an oversized credit set is rejected', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'release', RELEASE)
  db.metadataEnqueue(
    {
      entityId,
      type: 'enrich',
      provider: 'musicbrainz-details',
      language: 'en',
      batchId: 'atomic'
    },
    2000
  )
  const work = db.metadataClaim(2000)!,
    credit = musicBrainzCredits(releaseData(), root('release', RELEASE), attribution).items[0]
  assert.throws(
    () =>
      db.metadataFinish(
        work,
        {
          state: 'completed',
          outcome: 'partial',
          facts: [{ field: 'name', value: 'Should roll back', language: 'und', attribution }],
          credits: { items: Array.from({ length: 2049 }, () => credit), truncated: false }
        },
        2001
      ),
    /Too many metadata credits/
  )
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_facts').get()!.n, 0)
  assert.equal(db.metadataJobs({}).items[0].state, 'running')
})

test('large release credits are stored completely, paginated on SQLite and fenced against a refreshed snapshot', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'release', RELEASE)
  const credits = musicBrainzCredits(
    { relations: Array.from({ length: 350 }, (_, i) => relation(`role-${i}`)) },
    root('release', RELEASE),
    attribution
  )
  assert.equal(credits.truncated, false)
  db.metadataEnqueue(
    { entityId, type: 'enrich', provider: 'musicbrainz-details', language: 'en', batchId: 'paged' },
    2000
  )
  db.metadataFinish(
    db.metadataClaim(2000)!,
    { state: 'completed', outcome: 'partial', facts: [], credits },
    2001
  )
  assert.equal(db.metadataDetail(entityId, 'en').credits!.items.length, 64)
  assert.equal(
    db.metadataDetail(entityId, 'en').credits!.truncated,
    true,
    'detail is a bounded preview'
  )
  const first = db.metadataCredits({ entityId, limit: 200 })
  const second = db.metadataCredits({ entityId, offset: 200, limit: 200, revision: first.revision })
  assert.equal(first.total, 350)
  assert.equal(first.truncated, false, 'provider completeness is separate from pagination')
  assert.equal(second.items.length, 150)
  assert.equal(new Set([...first.items, ...second.items].map((c) => c.rawRole)).size, 350)
  db.metadataEnqueue(
    {
      entityId,
      type: 'enrich',
      provider: 'musicbrainz-details',
      providerContext: 'refresh',
      language: 'en',
      batchId: 'new-page'
    },
    3000
  )
  db.metadataFinish(
    db.metadataClaim(3000)!,
    {
      state: 'completed',
      outcome: 'partial',
      facts: [],
      credits: { items: credits.items.slice(0, 1), truncated: false }
    },
    3001
  )
  assert.throws(() => db.metadataCredits({ entityId, revision: first.revision }), /变化/)
  assert.equal(db.metadataCredits({ entityId }).total, 1)
  assert.equal(
    validEntityMetadataPayload('metadata.entity.credits', {
      entityId,
      limit: 200,
      revision: second.revision
    }),
    true
  )
  assert.equal(
    validEntityMetadataPayload('metadata.entity.credits', { entityId, limit: 201 }),
    false
  )
  assert.equal(
    validEntityMetadataPayload('metadata.entity.credits', { entityId, sql: 'anything' }),
    false
  )
  assert.equal(coreOperation('metadata.entity.credits')?.permission, 'library:read')
})

test('recording credits exclude the release set, retain explicit work relations and fence the first page against identity changes', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'recording', RECORDING)
  const releaseId = db.catalogQuery({ kind: 'release' }).items[0].id
  confirm(db, releaseId, 'release', RELEASE)
  const recording = releaseData().media[0].tracks[0].recording
  const sets = [
    { id: entityId, credits: musicBrainzCredits(recording, root('recording', RECORDING), attribution) },
    { id: releaseId, credits: musicBrainzCredits(releaseData(), root('release', RELEASE), attribution) }
  ]
  for (const set of sets) {
    db.metadataEnqueue({ entityId: set.id, type: 'enrich', provider: 'musicbrainz-details', language: 'en', batchId: 'recording-reader' }, 2000)
    db.metadataFinish(db.metadataClaim(2000)!, { state: 'completed', outcome: 'matched', facts: [], credits: set.credits }, 2001)
  }
  const references = db.catalogQuery({ kind: 'recording', context: { type: 'track', provider: 'local', id: 'one' } })
  assert.deepEqual(references.items.map(item => item.id), [entityId])
  const detail = db.metadataDetail(entityId, 'en')
  const query = { entityId, entityRevision: detail.revision, limit: 2 }
  const first = db.metadataCredits(query)
  const items = [...first.items]
  for (let offset = 2; offset < first.total; offset += 2)
    items.push(...db.metadataCredits({ ...query, offset, revision: first.revision }).items)
  assert.deepEqual(items, sets[0].credits.items)
  assert.ok(items.some(c => c.targetRef.kind === 'work' && c.targetRef.value === WORK))
  assert.ok(items.every(c => c.targetRef.value === RECORDING || c.targetRef.value === WORK))
  assert.ok(sets[1].credits.items.some(c => c.targetRef.kind === 'release'))
  assert.equal(validEntityMetadataPayload('metadata.entity.credits', query), true)
  for (const entityRevision of [-1, 1.5, '1', null])
    assert.equal(validEntityMetadataPayload('metadata.entity.credits', { entityId, entityRevision }), false)
  const link = db.identificationDetail(entityId).link!
  db.identificationDetach(link.id, link.revision, 3000)
  assert.throws(() => db.metadataCredits(query), /变化/)
  assert.throws(() => db.metadataCredits({ ...query, revision: first.revision, offset: 2 }), /变化/)
  assert.equal(db.metadataCredits({ entityId }).total, 0, 'old consumers retain their original query contract')
})

test('v17 upgrades preserve targets, overrides, source membership and running jobs with a restorable pre-upgrade snapshot', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'metadata-details-migration-')),
    path = join(directory, 'library.sqlite')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let db = new LibraryDatabase(path)
  const entityId = seed(db, 'release', RELEASE),
    targetId = db.identificationDetail(entityId).link!.targetId
  const detail = db.metadataDetail(entityId, 'en')
  db.metadataOverride(
    { entityId, revision: detail.revision, mode: 'value', value: 'My album notes', language: 'en' },
    1000
  )
  const job = db.metadataEnqueue(
    {
      entityId,
      type: 'enrich',
      provider: 'musicbrainz-details',
      language: 'en',
      batchId: 'persist'
    },
    2000
  )
  db.metadataClaim(2000)
  db.sql.exec(`${LEGACY_METADATA_DETAILS_SQL} PRAGMA user_version=17;`)
  db.close()
  db = new LibraryDatabase(path)
  try {
    assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
    assert.equal(db.identificationDetail(entityId).link!.targetId, targetId)
    assert.equal(db.metadataDetail(entityId, 'en').introduction?.value, 'My album notes')
    db.metadataRecover(3000)
    const work = db.metadataClaim(3000)!
    assert.equal(work.job.id, job.id)
    assert.equal(work.job.generation, job.generation + 1)
    const backups = readdirSync(directory).filter((f) => f.includes('v17-backup-'))
    assert.equal(backups.length, 1)
    const backup = new DatabaseSync(join(directory, backups[0]), { readOnly: true })
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 17)
      assert.equal(backup.prepare('SELECT count(*) n FROM metadata_overrides').get()!.n, 1)
    } finally {
      backup.close()
    }
  } finally {
    db.close()
  }
})

test('v18 DDL failure rolls back new credit tables and preserves the v17 source and backup', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'metadata-details-rollback-')),
    path = join(directory, 'library.sqlite')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const db = new LibraryDatabase(path),
    entityId = seed(db, 'release', RELEASE)
  db.sql.exec(
    `${LEGACY_METADATA_DETAILS_SQL} CREATE VIEW metadata_credits AS SELECT 1; PRAGMA user_version=17;`
  )
  db.close()
  assert.throws(() => new LibraryDatabase(path), /already exists/)
  const source = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(source.prepare('PRAGMA user_version').get()!.user_version, 17)
    assert.equal(
      source.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata_credit_sets'").get(),
      undefined
    )
    assert.ok(source.prepare('SELECT id FROM catalog_entities WHERE id=?').get(entityId))
  } finally {
    source.close()
  }
  assert.equal(readdirSync(directory).filter((f) => f.includes('v17-backup-')).length, 1)
})
