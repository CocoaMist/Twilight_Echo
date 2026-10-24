import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import type { EntityMetadataJob, EntityMetadataState } from '../../shared/entityMetadata.ts'
import { validMetadataTasksPayload } from '../../shared/entityMetadataTasks.ts'
import { isCoreRequest, coreOperation } from '../../shared/coreProtocol.ts'

const MBID = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
function fixture(t: test.TestContext, count = 8) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: count }, (_, i) => ({
      id: `track-${i}`,
      source: 'local',
      filePath: `D:/private/${i}.flac`,
      title: `Song ${i}`,
      artist: `Artist ${i}`,
      album: `Album ${i}`
    }))
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return { db, entities: db.catalogQuery({ kind: 'artist' }).items }
}
function setState(
  db: LibraryDatabase,
  job: EntityMetadataJob,
  state: EntityMetadataState,
  outcome: EntityMetadataJob['outcome'] = null
) {
  const next = { ...job, state, outcome, nextAttemptAt: 50000, attempts: 2 }
  db.sql
    .prepare('UPDATE metadata_jobs SET state=?,next_attempt=?,payload=? WHERE id=?')
    .run(state, next.nextAttemptAt, JSON.stringify(next), job.id)
  return next
}

test('task projections page jobs rather than consumers, retain all state counts, and read without writes or private inputs', (t) => {
  const { db, entities } = fixture(t)
  const states: EntityMetadataState[] = [
    'queued',
    'running',
    'retry_wait',
    'needs_review',
    'blocked',
    'failed',
    'completed',
    'cancelled'
  ]
  const jobs = entities.map((entity, i) => {
    const request = {
      entityId: entity.id,
      mbid: MBID,
      language: 'en' as const,
      type: 'resolve' as const
    }
    const job = db.metadataEnqueue({ ...request, batchId: 'shared' }, 1000)
    db.metadataEnqueue({ ...request, batchId: `other-${i}` }, 1000)
    return setState(db, job, states[i], states[i] === 'completed' ? 'not_found' : null)
  })
  const before = db.sql.prepare('SELECT total_changes() n').get()!.n
  const all = db.metadataTasks({ limit: 3 })
  assert.equal(all.total, 8)
  assert.equal(all.items.length, 3)
  assert.deepEqual(
    all.items.map((i) => i.id),
    jobs
      .slice(-3)
      .reverse()
      .map((j) => j.id)
  )
  assert.equal(all.items[0].demandCount, 2)
  assert.equal(all.items[0].entity!.id, entities[7].id)
  assert.equal(all.items[1].outcome, 'not_found')
  const second = db.metadataTasks({ offset: 3, limit: 3 })
  assert.equal(new Set([...all.items, ...second.items].map((i) => i.id)).size, 6)
  assert.deepEqual(Object.values(all.counts), Array(8).fill(1))
  const active = db.metadataTasks({ filter: 'active', limit: 1 })
  assert.equal(active.total, 3)
  assert.equal(active.items[0].state, 'retry_wait')
  assert.equal(active.items[0].nextAttemptAt, 50000)
  assert.equal(active.items[0].attempts, 2)
  assert.deepEqual(active.counts, all.counts)
  assert.deepEqual(
    db.metadataTasks({ filter: 'attention' }).items.map((i) => i.state),
    ['failed', 'blocked', 'needs_review']
  )
  assert.equal(db.metadataTasks({ batchId: 'shared' }).total, 8)
  assert.equal(db.metadataTasks({ batchId: 'not-a-batch' }).total, 0)
  assert.equal(db.metadataTaskDemands({ jobId: jobs[0].id }).total, 2)
  assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, before)
  const serialized = JSON.stringify(all)
  for (const secret of ['D:/private', 'providerContext', 'externalId', 'candidate', 'input'])
    assert.equal(serialized.includes(secret), false)
})

test('current demands have stable pages, actual automatic ownership and independent cancellation', (t) => {
  const { db, entities } = fixture(t, 1)
  const entityId = entities[0].id
  const request = { entityId, mbid: MBID, language: 'en' as const, type: 'resolve' as const }
  const automatic = db.sql
    .prepare('SELECT demand_id,origin FROM metadata_identification_schedule WHERE entity_id=?')
    .get(entityId)!
  const job = db.metadataEnqueue({ ...request, batchId: String(automatic.demand_id) }, 1000)
  for (const batchId of ['auto:human-supplied', 'b', 'c', 'd', 'e', 'f', 'g'])
    db.metadataEnqueue({ ...request, batchId }, 1000)
  const one = db.metadataTaskDemands({ jobId: job.id, offset: 0, limit: 6 })
  const two = db.metadataTaskDemands({ jobId: job.id, offset: 6, limit: 6 })
  assert.equal(one.total, 8)
  assert.equal(one.items.length, 6)
  assert.equal(two.items.length, 2)
  const all = [...one.items, ...two.items]
  assert.equal(new Set(all.map((i) => i.batchId)).size, 8)
  assert.equal(all.find((i) => i.batchId === automatic.demand_id)!.automatic, true)
  assert.equal(all.find((i) => i.batchId === 'auto:human-supplied')!.automatic, false)
  assert.ok(all.every((i) => i.canCancel))
  db.metadataCancel(job.id, 'b', 1001)
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'queued')
  assert.equal(db.metadataTaskDemands({ jobId: job.id }).total, 7)
  assert.equal(
    db.metadataTasks({ batchId: 'b' }).total,
    0,
    'removed consumers are not invented batch history'
  )
  for (const item of all.filter((i) => i.batchId !== 'b'))
    db.metadataCancel(job.id, item.batchId, 1002)
  assert.equal(db.metadataTasks({}).items[0].state, 'cancelled')
  assert.equal(db.metadataTaskDemands({ jobId: job.id }).total, 0)
})

test('shared enrichment targets keep their name but never masquerade as a source catalog entity', (t) => {
  const { db, entities } = fixture(t, 2)
  for (const entity of entities) {
    const [candidate] = db.identificationPublish(
      db.identificationInput(entity.id),
      [
        {
          provider: 'musicbrainz',
          name: 'Shared artist',
          summary: '',
          matcherVersion: 'fixture',
          references: [{ provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: MBID }],
          evidence: {
            origin: 'explicit_id',
            matches: ['explicit_id'],
            missing: [],
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
  const one = db.metadataEnqueue(
    { entityId: entities[0].id, type: 'enrich', language: 'en', batchId: 'local' },
    2000
  )
  const two = db.metadataEnqueue(
    { entityId: entities[1].id, type: 'enrich', language: 'en', batchId: 'other' },
    2000
  )
  assert.equal(one.id, two.id)
  assert.notEqual(one.entityId, entities[0].id)
  const task = db.metadataTasks({}).items[0]
  assert.equal(task.title, 'Shared artist')
  assert.equal(task.kind, 'artist')
  assert.equal(task.entity, null)
  assert.equal(task.demandCount, 2)
})

test('old jobs remain visible after source removal but do not offer an obsolete catalog review entry', (t) => {
  const { db, entities } = fixture(t, 1)
  const job = db.metadataEnqueue(
    { entityId: entities[0].id, type: 'resolve', mbid: MBID, language: 'en', batchId: 'one' },
    1000
  )
  assert.equal(db.metadataTasks({}).items[0].entity!.id, entities[0].id)
  db.sql.prepare("DELETE FROM tracks WHERE id='track-0'").run()
  assert.equal(db.metadataTasks({}).items[0].entity, null)
  assert.equal(db.metadataTasks({}).items[0].id, job.id)
  assert.equal(db.metadataJobs({}).total, 1)
})

test('legacy tasks and finished jobs expose consumers without allowing a generic reexecution or cancellation', (t) => {
  const { db, entities } = fixture(t, 1)
  const job = db.metadataEnqueue(
    { entityId: entities[0].id, type: 'resolve', mbid: MBID, language: 'en', batchId: 'one' },
    1000
  )
  setState(db, job, 'completed', 'matched')
  assert.equal(db.metadataTaskDemands({ jobId: job.id }).items[0].canCancel, false)
  const legacy = {
    ...job,
    type: 'legacy',
    state: 'running',
    legacy: {
      pluginId: 'fixture',
      batchId: 'one',
      albumId: 'a',
      operation: 'credits',
      title: 'Original album'
    }
  }
  db.sql
    .prepare('UPDATE metadata_jobs SET state=?,payload=? WHERE id=?')
    .run('running', JSON.stringify(legacy), job.id)
  assert.equal(db.metadataTasks({}).items[0].title, 'Original album')
  assert.equal(db.metadataTasks({}).items[0].entity, null)
  assert.equal(db.metadataTaskDemands({ jobId: job.id }).items[0].canCancel, false)
})

test('generation-fenced controls cannot cancel a completed or recovered job and original callers stay compatible', (t) => {
  const { db, entities } = fixture(t, 1)
  const job = db.metadataEnqueue(
    { entityId: entities[0].id, type: 'resolve', mbid: MBID, language: 'en', batchId: 'one' },
    1000
  )
  const work = db.metadataClaim(1000)!
  db.metadataRecover(1001)
  assert.throws(() => db.metadataCancel(job.id, 'one', 1002, job.generation), /变化/)
  assert.equal(db.metadataTaskDemands({ jobId: job.id }).total, 1)
  const current = db.metadataClaim(1002)!
  assert.ok(current.job.generation > work.job.generation)
  db.metadataFinish(current, { state: 'completed', outcome: 'not_found', facts: [] }, 1003)
  assert.throws(() => db.metadataCancel(job.id, 'one', 1004, current.job.generation), /变化/)
  assert.equal(db.metadataTasks({}).items[0].state, 'completed')
  assert.equal(db.metadataTaskDemands({ jobId: job.id }).total, 1)
  assert.equal(
    db.metadataCancel(job.id, 'one', 1005),
    true,
    'old cancellation input keeps its original contract'
  )
})

test('new task queries are library-read-only, reject excess input and retain the existing jobs contract', (t) => {
  const { db } = fixture(t, 1)
  for (const [name, valid] of [
    ['metadata.entity.tasks', {}],
    ['metadata.entity.demands', { jobId: 'a' }],
    ['metadata.entity.sources', { jobId: 'a' }]
  ] as const) {
    assert.deepEqual(coreOperation(name), { kind: 'query', permission: 'library:read' })
    assert.equal(
      isCoreRequest({ requestId: 'test', epoch: 'core', kind: 'query', name, payload: valid }),
      true
    )
    for (const bad of [
      { ...valid, limit: 101 },
      { ...valid, offset: -1 },
      { ...valid, providerContext: 'secret' },
      { ...valid, limit: 0 }
    ])
      assert.equal(validMetadataTasksPayload(name, bad), false)
  }
  assert.equal(validMetadataTasksPayload('metadata.entity.tasks', { filter: 'completed' }), false)
  assert.equal(validMetadataTasksPayload('metadata.entity.demands', { jobId: 'x\0y' }), false)
  assert.throws(() => db.metadataTasks({ limit: 101 }), /Invalid/)
  assert.throws(() => db.metadataTaskDemands({ jobId: 'a', offset: -1 }), /Invalid/)
  assert.deepEqual(db.metadataJobs({}), { total: 0, items: [] })
})

test('history and requery expose bounded read and write permissions through the actual Core validator', () => {
  const history = { entityId: 'entity', historySeq: 1, linkRevision: 3, inputVersion: 'input' }
  const requery = { demandId: 'new-demand', batchId: 'current-batch', items: [{ entityId: 'entity', jobId: 'job', generation: 2,
    linkRevision: 3, inputVersion: 'input' }] }
  for (const [name, kind, payload] of [
    ['identification.history', 'query', { entityId: 'entity', limit: 6 }],
    ['identification.restorePreview', 'query', history],
    ['identification.restore', 'command', history],
    ['metadata.entity.requery', 'command', requery]
  ] as const) {
    assert.deepEqual(coreOperation(name), { kind, permission: kind === 'query' ? 'library:read' : 'library:write' })
    assert.equal(isCoreRequest({ requestId: 'test', epoch: 'core', kind, name, payload }), true)
    assert.equal(isCoreRequest({ requestId: 'test', epoch: 'core', kind, name, payload: { ...payload, providerContext: 'private' } }), false)
  }
  assert.equal(isCoreRequest({ requestId: 'test', epoch: 'core', kind: 'command', name: 'metadata.entity.requery',
    payload: { ...requery, items: [requery.items[0], requery.items[0]] } }), false)
})
