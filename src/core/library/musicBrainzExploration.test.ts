import assert from 'node:assert/strict'
import test from 'node:test'
import { musicBrainzExploration } from './musicBrainzExploration.ts'
import { musicBrainzCredits } from './musicBrainzCredits.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { MusicCreditTarget } from '../../shared/musicCredits.ts'
const id = (i: number) => `00000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`
const root: MusicCreditTarget = {
  provider: 'musicbrainz',
  kind: 'recording',
  idType: 'mbid',
  value: id(1)
}
const attribution = {
  provider: 'musicbrainz',
  externalId: id(1),
  url: `https://musicbrainz.org/recording/${id(1)}`,
  license: 'CC0',
  licenseUrl: '',
  attribution: 'MusicBrainz',
  revision: '1',
  retrievedAt: 1000
}
const relation = (workId = id(10), extra: Record<string, unknown> = {}) => ({
  'target-type': 'work',
  type: 'performance',
  direction: 'forward',
  work: { id: workId, title: 'Same work' },
  ...extra
})
function data() {
  return {
    id: id(1),
    title: 'Track',
    relations: [relation()],
    'artist-credit': [{ name: 'Same Person', artist: { id: id(20), name: 'Same Person' } }]
  }
}
test('MB performance relation becomes genuine work→recording only, not a manufactured performance', () => {
  const input = data(),
    graph = musicBrainzExploration(input, root, attribution)
  assert.equal(graph.relations.length, 1)
  assert.equal(graph.relations[0].kind, 'work_recording')
  assert.deepEqual(graph.relations[0].from, {
    provider: 'musicbrainz',
    kind: 'work',
    idType: 'mbid',
    value: id(10)
  })
  assert.deepEqual(graph.relations[0].to, root)
  assert.equal(
    graph.nodes.some((n) => n.reference.kind === 'performance'),
    false
  )
  assert.equal(graph.truncated, false)
})
test('MB same titles stay distinct IDs, invalid/backward/other relation types cannot infer work membership', () => {
  const input = {
    id: id(1),
    title: 'Track',
    relations: [
      relation(id(10)),
      relation(id(11)),
      relation('invalid'),
      relation(id(12), { direction: 'backward' }),
      relation(id(13), { type: 'inspired by' }),
      relation(id(14), { 'target-type': 'release' }),
      relation(id(10))
    ]
  }
  const graph = musicBrainzExploration(input, root, attribution)
  assert.equal(graph.relations.length, 2)
  assert.deepEqual(
    graph.relations.map((r) => r.from.value),
    [id(10), id(11)]
  )
  assert.equal(graph.nodes.filter((n) => n.reference.kind === 'work').length, 2)
})
test('MB release media yields bounded source order and incomplete flags independently of page size', () => {
  const albumRoot = { ...root, kind: 'release' as const, value: id(2) }
  const graph = musicBrainzExploration(
    {
      title: 'Album',
      media: [
        {
          tracks: Array.from({ length: 600 }, (_, i) => ({
            recording: {
              id: id(i + 1000),
              title: `Movement ${i}`,
              relations: [relation(id(i + 2000))]
            }
          }))
        }
      ]
    },
    albumRoot,
    attribution
  )
  assert.ok(graph.nodes.length <= 500)
  assert.ok(graph.relations.length <= 1000)
  assert.equal(graph.truncated, true)
  assert.deepEqual(
    graph.relations.slice(0, 3).map((r) => r.order),
    [0, 1, 2]
  )
  assert.equal(
    graph.nodes.some((n) => n.reference.kind === 'performance'),
    false
  )
})
function production(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'local',
        source: 'local',
        filePath: 'D:/music/song.flac',
        title: 'Song',
        artist: 'Same Person',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entity = db.catalogQuery({ kind: 'recording' }).items[0],
    target = 'mb-target'
  db.sql
    .prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
    .run(target, 'musicbrainz', 'recording', id(1), 'Song')
  db.sql
    .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
    .run('musicbrainz', 'recording', 'mbid', id(1), target)
  db.sql
    .prepare(
      "INSERT INTO metadata_identity_links VALUES(?,?,?,1,?,'confirmed') ON CONFLICT(entity_id,kind) DO UPDATE SET target_id=excluded.target_id,state='confirmed',revision=revision+1"
    )
    .run('local-link', entity.id, 'recording', target)
  const enqueue = () =>
    db.metadataEnqueue(
      {
        entityId: entity.id,
        type: 'enrich',
        provider: 'musicbrainz-details',
        language: 'en',
        batchId: 'exploration-test'
      },
      1000
    )
  return { db, entity, enqueue }
}
test('real metadata finish atomically publishes trusted credits and work graph over actual local membership', (t) => {
  const { db, entity, enqueue } = production(t),
    job = enqueue(),
    work = db.metadataClaim(1000)!
  assert.equal(work.job.id, job.id)
  assert.equal(work.job.entityKind, 'recording')
  const input = data(),
    graph = musicBrainzExploration(input, root, attribution),
    credits = musicBrainzCredits(input, root, attribution)
  assert.equal(
    db.metadataFinish(
      work,
      { state: 'completed', outcome: 'matched', facts: [], credits, exploration: graph },
      1001
    ),
    true
  )
  const people = db.explorationQuery({ kinds: ['artist'] })
  assert.equal(people.total, 1)
  const participation = db.explorationParticipation({ entityId: people.items[0].id })
  assert.equal(participation.items[0].entity.id, entity.id)
  const works = db.explorationQuery({ kinds: ['work'] })
  assert.equal(works.total, 1)
  assert.equal(
    db.explorationRelations({ entityId: works.items[0].id, direction: 'outgoing' }).items[0].entity
      .id,
    entity.id
  )
  assert.equal(db.explorationQuery({ scope: 'catalog', kinds: ['performance'] }).total, 0)
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'completed')
})
test('invalid trusted graph rolls back original credits/job and does not leave a half-published graph', (t) => {
  const { db, enqueue } = production(t),
    job = enqueue(),
    work = db.metadataClaim(1000)!,
    input = data()
  const graph = musicBrainzExploration(input, root, attribution),
    before = db.explorationState()
  graph.relations[0] = { ...graph.relations[0], to: { ...root, kind: 'artist' } }
  assert.throws(
    () =>
      db.metadataFinish(
        work,
        {
          state: 'completed',
          outcome: 'matched',
          facts: [],
          credits: musicBrainzCredits(input, root, attribution),
          exploration: graph
        },
        1001
      ),
    /无效/
  )
  assert.equal(db.explorationQuery({ scope: 'catalog' }).total, 0)
  assert.deepEqual(db.explorationState(), before)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_credits').get()!.n, 0)
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'running')
})


test('large work graphs obey the ingest byte budget while retaining source incompleteness', () => {
  const graph = musicBrainzExploration({ id: root.value, title: 'Root', relations: Array.from({ length: 1200 }, (_, i) => ({
    'target-type': 'work', type: 'performance', direction: 'forward', work: { id: id(i + 2), title: 'W'.repeat(1024) }
  })) }, root, { ...attribution, attribution: 'Contributors'.repeat(100) })
  assert.equal(graph.truncated, true)
  assert.ok(JSON.stringify(graph).length < 1024 * 1024)
  assert.ok(graph.nodes.length <= 500)
  assert.ok(graph.relations.length <= 1000)
})
