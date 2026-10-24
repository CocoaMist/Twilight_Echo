import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  EXPLORATION_SCHEMA_SQL,
  LibraryDatabaseExploration,
  explorationMembershipCtes
} from './libraryDatabaseExploration.ts'
import {
  validMusicExplorationPayload,
  validMusicExplorationReference,
  validMusicExplorationToken,
  type MusicExplorationReference,
  type MusicExplorationIngest,
  type MusicExplorationRelationInput
} from '../../shared/musicExploration.ts'
import type { MusicCredit } from '../../shared/musicCredits.ts'
const ref = (
  kind: MusicExplorationReference['kind'],
  value: string,
  provider = 'mb'
): MusicExplorationReference => ({ provider, kind, idType: 'id', value })
const person = ref('artist', 'p1'),
  person2 = ref('artist', 'p2'),
  work = ref('work', 'w1'),
  recording = ref('recording', 'r1'),
  recording2 = ref('recording', 'r2')
const attribution = {
  provider: 'mb',
  externalId: 'x',
  url: 'https://musicbrainz.org',
  license: 'CC0',
  licenseUrl: '',
  attribution: 'MusicBrainz',
  revision: '1',
  retrievedAt: 100
}
const credit = (
  p = person,
  target = recording,
  role: MusicCredit['role'] = 'vocal'
): MusicCredit => ({
  personRef: p as MusicCredit['personRef'],
  name: 'Same Name',
  targetRef: target as MusicCredit['targetRef'],
  role,
  rawRole: role === 'other' ? 'research assistant' : role,
  relationTypeId: 'original-role-id',
  direction: 'backward',
  order: 2,
  joinphrase: ' & ',
  attributes: [{ name: 'instrument', value: 'violin' }],
  begin: '1970',
  end: '1971',
  attribution
})
function fixture(t: test.TestContext) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(`PRAGMA foreign_keys=ON;CREATE TABLE catalog_state(key TEXT PRIMARY KEY,value TEXT);INSERT INTO catalog_state VALUES('revision','0');
 CREATE TABLE catalog_entities(id TEXT PRIMARY KEY,kind TEXT,title TEXT,artist TEXT,identity TEXT);
 CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,provider TEXT,track_id TEXT,recording_id TEXT,release_id TEXT);
 CREATE TABLE tracks(id TEXT PRIMARY KEY);CREATE TABLE catalog_pending(track_id TEXT PRIMARY KEY);
 CREATE TABLE catalog_memberships(owner TEXT,source_id TEXT);CREATE TABLE catalog_source_artists(source_id TEXT,artist_id TEXT);
 CREATE TABLE catalog_release_projects(release_id TEXT,project_id TEXT);
 CREATE TABLE metadata_entities(id TEXT PRIMARY KEY,provider TEXT,kind TEXT,external_id TEXT,name TEXT);
 CREATE TABLE metadata_identity_refs(provider TEXT,kind TEXT,id_type TEXT,value TEXT,target_id TEXT);
 CREATE TABLE metadata_identity_links(entity_id TEXT,kind TEXT,target_id TEXT,state TEXT);
 CREATE TABLE personal_preferences_state(profile_id TEXT PRIMARY KEY,revision INTEGER);INSERT INTO personal_preferences_state VALUES('default',0);
 CREATE TABLE metadata_credit_sets(target_id TEXT,provider TEXT,revision INTEGER,truncated INTEGER);
 CREATE TABLE metadata_credits(target_id TEXT,provider TEXT,position INTEGER,payload TEXT);`)
  sql.exec(EXPLORATION_SCHEMA_SQL)
  let now = 1000,
    content = 1,
    metadata = 1,
    clock = () => now
  const transaction = <T>(action: () => T): T => {
    const own = !sql.isTransaction
    if (own) sql.exec('BEGIN IMMEDIATE')
    try {
      const v = action()
      if (own) sql.exec('COMMIT')
      return v
    } catch (e) {
      if (own && sql.isTransaction) sql.exec('ROLLBACK')
      throw e
    }
  }
  const db = new LibraryDatabaseExploration({
    sql,
    transaction,
    contentRevision: () => content,
    metadataRevision: () => metadata,
    now: () => clock()
  })
  const id = (r: MusicExplorationReference) =>
    String(
      sql
        .prepare(
          'SELECT entity_id FROM music_exploration_refs WHERE provider=? AND kind=? AND id_type=? AND value=?'
        )
        .get(r.provider, r.kind, r.idType, r.value)!.entity_id
    )
  const ingest = (
    relations: MusicExplorationRelationInput[] = [],
    extra: Partial<MusicExplorationIngest> = {}
  ) =>
    db.ingest({
      owner: recording,
      provider: 'mb',
      setKey: 'recording',
      nodes: [
        { reference: recording, title: 'Recording' },
        { reference: recording2, title: 'Movement II' },
        { reference: person, title: 'Same Name' },
        { reference: person2, title: 'Same Name' },
        { reference: work, title: 'Symphony' }
      ],
      relations,
      truncated: false,
      ...extra
    })
  const edge = (
    from = person,
    to = recording,
    kind: MusicExplorationRelationInput['kind'] = 'credit',
    extra: Partial<MusicExplorationRelationInput> = {}
  ): MusicExplorationRelationInput => ({
    from,
    to,
    kind,
    order: 0,
    attribution,
    ...(kind === 'credit' ? { credit: credit(from, to) } : {}),
    ...extra
  })
  const source = (
    id: string,
    reference = recording,
    provider = 'local',
    membership = true,
    confirmed = true
  ) => {
    const entity = `physical:${id}`,
      target = `target:${id}`
    sql
      .prepare("INSERT INTO catalog_entities VALUES(?,'recording',?,'','source')")
      .run(entity, `Source ${id}`)
    sql.prepare('INSERT INTO catalog_sources VALUES(?,?,?,?,NULL)').run(id, provider, id, entity)
    if (provider === 'local') sql.prepare('INSERT INTO tracks VALUES(?)').run(id)
    if (membership) sql.prepare("INSERT INTO catalog_memberships VALUES('library',?)").run(id)
    sql
      .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
      .run(reference.provider, reference.kind, reference.idType, reference.value, target)
    sql
      .prepare('INSERT INTO metadata_identity_links VALUES(?,?,?,?)')
      .run(entity, 'recording', target, confirmed ? 'confirmed' : 'unresolved')
    return entity
  }
  return {
    sql,
    db,
    id,
    ingest,
    edge,
    source,
    setNow: (value: number) => {
      now = value
    },
    setClock: (value: () => number) => {
      clock = value
    },
    bumpContent: () => {
      content++
    },
    bumpMetadata: () => {
      metadata++
    }
  }
}
test('exploration DTO bounds, private authority and exact references', () => {
  assert.equal(validMusicExplorationPayload('exploration.query', {}), true)
  assert.equal(validMusicExplorationPayload('exploration.query', { limit: 101 }), false)
  assert.equal(
    validMusicExplorationPayload('exploration.query', { contexts: { mb: 'account' } }),
    false
  )
  assert.equal(validMusicExplorationPayload('exploration.query', { profileId: 'other' }), false)
  assert.equal(
    validMusicExplorationPayload('exploration.participation', {
      entityId: 'a',
      direction: 'incoming'
    }),
    false
  )
  assert.equal(
    validMusicExplorationPayload('exploration.performance.save', {
      title: 'Live',
      workId: 'w',
      recordingIds: Array(201).fill('r'),
      revision: 0
    }),
    false
  )
  assert.equal(validMusicExplorationReference({ ...person, provider: 'MB' }), false)
  assert.equal(validMusicExplorationReference({ ...person, value: 'name\0evil' }), false)
})
test('same names and different providers never merge; reading never creates anchors', (t) => {
  const f = fixture(t)
  f.ingest([f.edge()])
  const before = f.db.state()
  const page = f.db.query({ scope: 'catalog', kinds: ['artist'] })
  assert.equal(page.total, 2)
  assert.notEqual(f.id(person), f.id(person2))
  assert.equal(validMusicExplorationToken(page.token), true)
  assert.equal(f.db.query({ kinds: ['artist'] }).total, 0)
  assert.equal(f.db.detail({ entityId: 'Same Name' }).entity, null)
  assert.deepEqual(f.db.state(), before)
  const providerPerson = { ...person, provider: 'other' }
  f.db.ingest({
    owner: providerPerson,
    provider: 'other',
    setKey: 'person',
    nodes: [{ reference: providerPerson, title: 'Same Name' }],
    relations: [],
    truncated: false
  })
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['artist'], search: 'same' }).total, 3)
})
test('participation requires confirmed exact identity plus actual memberships, preserves role evidence', (t) => {
  const f = fixture(t)
  const c = credit(person, recording, 'other')
  f.ingest([f.edge(person, recording, 'credit', { credit: c })])
  const physical = f.source('local')
  f.source('cached', recording, 'stream', false)
  f.source('unconfirmed', recording, 'stream', true, false)
  const page = f.db.participation({ entityId: f.id(person) })
  assert.equal(page.total, 1)
  assert.equal(page.items[0].entity.id, physical)
  assert.equal(page.items[0].entity.sourceCount, 1)
  assert.deepEqual(page.items[0].relation.credit, c)
  assert.equal(f.db.participation({ entityId: f.id(person), roles: ['producer'] }).total, 0)
  assert.equal(f.db.participation({ entityId: f.id(person), roles: ['other'] }).total, 1)
  assert.equal(f.db.participation({ entityId: f.id(person), scope: 'catalog' }).total, 2)
  const incoming = f.db.relations({ entityId: physical, scope: 'library', direction: 'incoming' })
  assert.equal(incoming.total, 1)
  assert.equal(incoming.items[0].entity.id, f.id(person))
  assert.equal(JSON.stringify(page).includes('filePath'), false)
})
test('local removed or pending does not count; platform membership remains independent', (t) => {
  const f = fixture(t)
  f.ingest([f.edge()])
  f.source('local')
  f.source('stream', recording, 'stream')
  assert.equal(f.db.detail({ entityId: f.id(person) }).entity!.sourceCount, 2)
  f.sql.prepare("INSERT INTO catalog_pending VALUES('local')").run()
  assert.equal(f.db.detail({ entityId: f.id(person) }).entity!.sourceCount, 1)
  f.sql.exec("DELETE FROM catalog_memberships WHERE source_id='stream'")
  assert.equal(f.db.query({ kinds: ['artist'] }).total, 0)
  f.sql.exec('DELETE FROM catalog_pending;DELETE FROM tracks')
  assert.equal(f.db.detail({ entityId: f.id(person) }).entity!.sourceCount, 0)
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['artist'] }).total, 2)
})
test('genuine work links work without fabricated performances; provider incompleteness is separate from page', (t) => {
  const f = fixture(t)
  f.ingest(
    [
      f.edge(work, recording, 'work_recording'),
      f.edge(person, work, 'credit', { credit: credit(person, work, 'composer') })
    ],
    { truncated: true }
  )
  f.source('a')
  const works = f.db.query({ kinds: ['work'] })
  assert.equal(works.total, 1)
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['performance'] }).total, 0)
  const page = f.db.relations({ entityId: f.id(work), limit: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(page.providerTruncated, true)
  assert.equal(
    f.db.participation({ entityId: f.id(person), roles: ['composer'] }).items[0].entity.id,
    f.id(work)
  )
})
test('manual performances retain multiple ordered movements, separate renditions and durable anchors after delete', (t) => {
  const f = fixture(t)
  f.ingest([])
  const a = f.source('a'),
    b = f.source('b', recording2)
  const first = f.db.performanceSave({
    title: 'Live 2020',
    workId: f.id(work),
    recordingIds: [b, a, b],
    revision: f.db.state().revision
  })
  const second = f.db.performanceSave({
    title: 'Live 2021',
    workId: f.id(work),
    recordingIds: [a, b],
    revision: f.db.state().revision
  })
  assert.notEqual(first.entity!.id, second.entity!.id)
  assert.equal(first.entity!.sourceCount, 2)
  const movements = f.db.relations({
    entityId: first.entity!.id,
    direction: 'outgoing',
    relations: ['performance_recording']
  })
  assert.deepEqual(
    movements.items.map((x) => x.entity.id),
    [b, a, b]
  )
  assert.deepEqual(
    movements.items.map((x) => x.relation.order),
    [0, 1, 2]
  )
  assert.throws(
    () =>
      f.db.performanceSave({
        id: first.entity!.id,
        title: 'old',
        workId: f.id(work),
        recordingIds: [a],
        revision: first.token.revision
      }),
    /变化/
  )
  f.db.performanceDelete({ id: first.entity!.id, revision: f.db.state().revision })
  const retained = f.db.detail({ entityId: first.entity!.id })
  assert.equal(retained.entity!.title, 'Live 2020')
  assert.equal(retained.entity!.inLibrary, false)
  assert.equal(retained.references.length, 1)
  assert.equal(f.db.query({ kinds: ['performance'] }).total, 1)
})
test('token fences graph/catalog/content/metadata, contexts and expiry including expiry during SQL read', (t) => {
  const f = fixture(t)
  f.ingest([
    f.edge(person, recording, 'credit', {
      usage: { display: true, cache: true, crossSource: true, export: false, expiresAt: 2000 },
      sourceProvider: 'stream',
      providerContext: 'account-1'
    })
  ])
  f.source('a')
  assert.equal(f.db.participation({ entityId: f.id(person) }).total, 0)
  const context = { platformContexts: { stream: 'account-1' } },
    page = f.db.participation({ entityId: f.id(person) }, context)
  assert.equal(page.total, 1)
  assert.equal(page.token.expiresAt, 2000)
  assert.throws(
    () =>
      f.db.participation(
        { entityId: f.id(person), token: page.token },
        { platformContexts: { stream: 'account-2' } }
      ),
    /变化/
  )
  f.bumpContent()
  assert.throws(() => f.db.query({ token: page.token }, context), /变化/)
  const token = f.db.query({}, context).token
  f.bumpMetadata()
  assert.throws(() => f.db.query({ token }, context), /变化/)
  f.setNow(2000)
  assert.equal(f.db.participation({ entityId: f.id(person) }, context).total, 0)
  assert.throws(() => f.db.query({ token: page.token }, context), /变化/)
  f.setNow(1000)
  let calls = 0
  f.setClock(() => (++calls === 1 ? 1000 : 2000))
  assert.throws(() => f.db.query({}, context), /变化/)
  assert.equal(f.sql.isTransaction, false)
})
test('relation updates are atomic/idempotent and invalidate existing catalog/personal pages', (t) => {
  const f = fixture(t)
  const e = f.edge()
  f.ingest([e])
  const before = f.db.state()
  f.ingest([e])
  assert.deepEqual(f.db.state(), before)
  const token = f.db.query({ scope: 'catalog' }).token
  assert.throws(() => f.ingest([f.edge(work, person, 'work_recording')]), /无效/)
  assert.deepEqual(f.db.state(), before)
  f.ingest([])
  assert.ok(f.db.state().catalogRevision > before.catalogRevision)
  assert.throws(() => f.db.query({ scope: 'catalog', token }), /变化/)
  assert.equal(f.db.relations({ entityId: f.id(person), scope: 'catalog' }).total, 0)
  assert.equal(f.db.detail({ entityId: f.id(person) }).entity!.title, 'Same Name')
})
test('typed aliases share one anchor; conflicting anchors cannot silently merge personal references', (t) => {
  const f = fixture(t)
  f.ingest([])
  const alias = { ...person, idType: 'alias', value: 'alias-p1' }
  f.db.ingest({
    owner: person,
    provider: 'mb',
    setKey: 'aliases',
    nodes: [{ reference: person, aliases: [alias], title: 'Same Name' }],
    relations: [],
    truncated: false
  })
  assert.equal(f.id(alias), f.id(person))
  assert.throws(
    () =>
      f.db.ingest({
        owner: person,
        provider: 'mb',
        setKey: 'conflict',
        nodes: [{ reference: person, aliases: [person2], title: 'Same Name' }],
        relations: [],
        truncated: false
      }),
    /复核/
  )
})
test('existing M2 cached credits synchronize exact people/work refs with original role and truncation', (t) => {
  const f = fixture(t)
  const c = credit(person, work, 'composer')
  f.sql
    .prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
    .run('target', 'mb', 'recording', 'r1', 'Cached song')
  f.sql
    .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
    .run('mb', 'recording', 'id', 'r1', 'target')
  f.sql
    .prepare('INSERT INTO metadata_credit_sets VALUES(?,?,?,?)')
    .run('target', 'musicbrainz-details', 1, 1)
  f.sql
    .prepare('INSERT INTO metadata_credits VALUES(?,?,?,?)')
    .run('target', 'musicbrainz-details', 0, JSON.stringify(c))
  f.db.syncCredits({ targetId: 'target', provider: 'musicbrainz-details' })
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['artist'] }).total, 1)
  const page = f.db.participation({ entityId: f.id(person), scope: 'catalog' })
  assert.equal(page.total, 1)
  assert.equal(page.providerTruncated, true)
  assert.deepEqual(page.items[0].relation.credit, c)
  const state = f.db.state()
  f.db.syncCredits({ targetId: 'target', provider: 'musicbrainz-details' })
  assert.deepEqual(f.db.state(), state)
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['performance'] }).total, 0)
})
test('shared personal membership helper counts exact person/work participation without account-bound leaks', (t) => {
  const f = fixture(t)
  f.ingest([
    f.edge(work, recording, 'work_recording'),
    f.edge(person, work, 'credit', { credit: credit(person, work, 'composer') })
  ])
  f.source('a')
  const row = f.sql
    .prepare(
      `WITH RECURSIVE ${explorationMembershipCtes()} SELECT count(DISTINCT source_id) n FROM exploration_memberships WHERE entity_id=?`
    )
    .get(f.id(person))!
  assert.equal(row.n, 1)
})

test('large valid old credit sets are bounded/incomplete, not rejected, and richer work names survive', (t) => {
  const f = fixture(t)
  f.ingest([])
  f.sql
    .prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
    .run('target', 'mb', 'recording', 'r1', 'Cached song')
  f.sql
    .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
    .run('mb', 'recording', 'id', 'r1', 'target')
  f.sql
    .prepare('INSERT INTO metadata_credit_sets VALUES(?,?,?,?)')
    .run('target', 'musicbrainz-details', 1, 0)
  const put = f.sql.prepare('INSERT INTO metadata_credits VALUES(?,?,?,?)')
  for (let i = 0; i < 2048; i++)
    put.run(
      'target',
      'musicbrainz-details',
      i,
      JSON.stringify(credit(ref('artist', `p-${i}`), work, 'composer'))
    )
  assert.doesNotThrow(() =>
    f.db.syncCredits({ targetId: 'target', provider: 'musicbrainz-details' })
  )
  assert.equal(f.db.detail({ entityId: f.id(work) }).entity!.title, 'Symphony')
  assert.equal(f.db.detail({ entityId: f.id(work) }).providerTruncated, true)
  assert.ok(f.db.query({ scope: 'catalog', kinds: ['artist'] }).total <= 500)
  assert.equal(f.sql.prepare('SELECT count(*) n FROM metadata_credits').get()!.n, 2048)
})
test('cached credit backfill is paged, resumable, idempotent and atomic per set', (t) => {
  const f = fixture(t)
  for (let i = 0; i < 3; i++) {
    f.sql
      .prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
      .run(`target${i}`, 'mb', 'recording', `r${i}`, `Song ${i}`)
    f.sql
      .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
      .run('mb', 'recording', 'id', `r${i}`, `target${i}`)
    f.sql
      .prepare('INSERT INTO metadata_credit_sets VALUES(?,?,?,?)')
      .run(`target${i}`, 'musicbrainz-details', 1, 0)
    f.sql
      .prepare('INSERT INTO metadata_credits VALUES(?,?,?,?)')
      .run(
        `target${i}`,
        'musicbrainz-details',
        0,
        JSON.stringify(credit(ref('artist', `p${i}`), ref('recording', `r${i}`)))
      )
  }
  assert.deepEqual(f.db.backfillCredits(2), { processed: 2, pending: true })
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['artist'] }).total, 2)
  assert.deepEqual(f.db.backfillCredits(2), { processed: 1, pending: false })
  const before = f.db.state()
  assert.deepEqual(f.db.backfillCredits(), { processed: 0, pending: false })
  assert.deepEqual(f.db.state(), before)
})
test('exact reference lookup reads existing anchors and aliases without ingesting or name fallback', (t) => {
  const f = fixture(t)
  f.ingest([])
  const state = f.db.state()
  assert.equal(f.db.lookupReference({ reference: person }).entity!.id, f.id(person))
  assert.equal(f.db.lookupReference({ reference: ref('artist', 'Same Name') }).entity, null)
  assert.deepEqual(f.db.state(), state)
  f.sql.exec(
    "INSERT INTO catalog_entities VALUES('legacy-local-name','artist','Same Name','','source');INSERT INTO tracks VALUES('x');INSERT INTO catalog_sources VALUES('x','local','x','legacy-local-name',NULL);INSERT INTO catalog_memberships VALUES('library','x');INSERT INTO catalog_source_artists VALUES('x','legacy-local-name')"
  )
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['artist'] }).total, 2)
})

test('forward dedication remains an attributed relation but is not counted as person participation', (t) => {
  const f = fixture(t)
  f.ingest([
    f.edge(person, recording, 'credit', {
      credit: { ...credit(), rawRole: 'dedication', role: 'other', direction: 'forward' }
    })
  ])
  f.source('a')
  assert.equal(f.db.detail({ entityId: f.id(person) }).entity!.sourceCount, 0)
  assert.equal(f.db.query({ kinds: ['artist'] }).total, 0)
  assert.equal(f.db.participation({ entityId: f.id(person), scope: 'catalog' }).total, 0)
  const relation = f.db.relations({
    entityId: f.id(person),
    scope: 'catalog',
    relations: ['credit']
  })
  assert.equal(relation.total, 1)
  assert.equal(relation.items[0].relation.credit!.direction, 'forward')
  assert.equal(relation.items[0].relation.credit!.rawRole, 'dedication')
})

test('old credits lacking rights context do not become global platform person relations', (t) => {
  const f = fixture(t)
  f.sql
    .prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
    .run('target', 'stream', 'recording', 'r1', 'Platform song')
  f.sql
    .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
    .run('stream', 'recording', 'id', 'r1', 'target')
  f.sql
    .prepare('INSERT INTO metadata_credit_sets VALUES(?,?,?,?)')
    .run('target', 'platform.stream', 1, 0)
  f.sql
    .prepare('INSERT INTO metadata_credits VALUES(?,?,?,?)')
    .run('target', 'platform.stream', 0, JSON.stringify(credit()))
  const before = f.db.state()
  f.db.syncCredits({ targetId: 'target', provider: 'platform.stream' })
  assert.deepEqual(f.db.state(), before)
  assert.equal(f.db.query({ scope: 'catalog' }).total, 0)
})
test('graph byte budget retains valid large cached credits without failing original metadata', (t) => {
  const f = fixture(t)
  f.sql
    .prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
    .run('target', 'mb', 'recording', 'r1', 'Cached song')
  f.sql
    .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
    .run('mb', 'recording', 'id', 'r1', 'target')
  f.sql
    .prepare('INSERT INTO metadata_credit_sets VALUES(?,?,?,?)')
    .run('target', 'musicbrainz-details', 1, 0)
  const huge = { ...credit(), rawRole: 'x'.repeat(950000) }
  f.sql
    .prepare('INSERT INTO metadata_credits VALUES(?,?,?,?)')
    .run('target', 'musicbrainz-details', 0, JSON.stringify(huge))
  assert.doesNotThrow(() =>
    f.db.syncCredits({ targetId: 'target', provider: 'musicbrainz-details' })
  )
  assert.equal(f.db.query({ scope: 'catalog', kinds: ['recording'] }).items[0].title, 'Cached song')
  const anchor = f.db.lookupReference({ reference: recording })
  assert.equal(anchor.providerTruncated, true)
  assert.equal(
    Number(f.sql.prepare('SELECT length(payload) n FROM metadata_credits').get()!.n) > 950000,
    true
  )
})

test('exact reference changes invalidate preference conflict previews while relation-only changes do not', (t) => {
  const f = fixture(t)
  const revision = () =>
    Number(
      f.sql
        .prepare("SELECT revision FROM personal_preferences_state WHERE profile_id='default'")
        .get()!.revision
    )
  f.ingest([f.edge()])
  const initial = revision()
  assert.equal(initial, 5)
  f.ingest([f.edge(person, recording2)])
  assert.equal(revision(), initial)
  f.sql
    .prepare(
      "UPDATE music_exploration_refs SET value='renamed-external-id' WHERE provider=? AND kind=? AND id_type=? AND value=?"
    )
    .run(person.provider, person.kind, person.idType, person.value)
  assert.equal(revision(), initial + 1)
  f.sql.prepare('DELETE FROM music_exploration_refs WHERE entity_id=?').run(f.id(person2))
  assert.equal(revision(), initial + 2)
})
