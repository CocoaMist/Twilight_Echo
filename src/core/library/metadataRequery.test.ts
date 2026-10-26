import assert from 'node:assert/strict'
import test from 'node:test'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from '../../main/library/libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from '../../main/library/libraryDatabaseProtocol.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataFact,
  EntityMetadataJob,
  EntityMetadataState
} from '../../shared/entityMetadata.ts'
import {
  validMetadataTasksPayload,
  type MetadataTaskRequery,
  type MetadataTaskRequeryItem
} from '../../shared/entityMetadataTasks.ts'
import type { IdentificationScheduleRequest } from '../../shared/musicIdentificationSchedule.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
import { MetadataHttp } from './metadataHttp.ts'

const MBID = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
const PROVIDER = 'musicbrainz-details'
const CONTEXT = 'account-and-permission-a'
const contexts = { [PROVIDER]: CONTEXT }
const policy = {
  enabled: true,
  publicServiceApproved: true,
  wikipediaText: true,
  contact: 'https://example.com/contact'
}
const fact = (value = 'Original introduction'): EntityMetadataFact => ({
  field: 'introduction',
  value,
  language: 'en',
  attribution: {
    provider: 'fixture',
    externalId: MBID,
    url: `https://musicbrainz.org/artist/${MBID}`,
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: 'Fixture',
    revision: '1',
    retrievedAt: 1000
  }
})
const completed = (value = 'Original introduction') => ({
  state: 'completed' as const,
  outcome: 'matched' as const,
  facts: [fact(value)]
})
function seed(db: LibraryDatabase, count = 2) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: count }, (_, index) => ({
      id: `track-${index}`,
      source: 'local',
      filePath: `D:/private/${index}.flac`,
      title: `Song ${index}`,
      artist: `Artist ${index}`,
      album: `Album ${index}`
    }))
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entities = db.catalogQuery({ kind: 'artist' }).items
  for (const entity of entities) {
    const input = db.identificationInput(entity.id)
    const [candidate] = db.identificationPublish(
      input,
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
  return entities
}
function fixture(t: test.TestContext, count = 2) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  return { db, entities: seed(db, count) }
}
function initial(
  db: LibraryDatabase,
  entityId: string,
  language: 'en' | 'zh-Hans' = 'en',
  batchId = 'original'
) {
  const job = db.metadataEnqueue(
    { entityId, type: 'enrich', language, provider: PROVIDER, providerContext: CONTEXT, batchId },
    1100
  )
  const work = db.metadataClaim(1100)!
  assert.equal(work.job.id, job.id)
  assert.equal(db.metadataFinish(work, completed(), 1101), true)
  return db.metadataJobs({ jobId: job.id }).items[0]
}
function item(
  db: LibraryDatabase,
  job: EntityMetadataJob,
  entityId?: string
): MetadataTaskRequeryItem {
  const page = db.metadataTaskSources({ jobId: job.id, limit: 100 })
  const source = entityId
    ? page.items.find((source) => source.entity.id === entityId)!
    : page.items[0]
  assert.ok(source, 'a current real consumer must be selectable')
  return {
    jobId: job.id,
    generation: page.generation,
    entityId: source.entity.id,
    inputVersion: source.inputVersion,
    linkRevision: source.linkRevision
  }
}
function requery(
  db: LibraryDatabase,
  job: EntityMetadataJob,
  demandId = 'requery',
  entityId?: string
) {
  return db.metadataRequery({ items: [item(db, job, entityId)], demandId }, contexts, 1200).jobs[0]
}
function state(db: LibraryDatabase, id: string) {
  return db.metadataJobs({ jobId: id }).items[0]
}
function forceState(
  db: LibraryDatabase,
  job: EntityMetadataJob,
  nextState: EntityMetadataState,
  nextAttemptAt = 1101
) {
  const next = { ...job, state: nextState, nextAttemptAt }
  db.sql
    .prepare('UPDATE metadata_jobs SET state=?,next_attempt=?,payload=? WHERE id=?')
    .run(next.state, nextAttemptAt, JSON.stringify(next), job.id)
  return next
}
function detach(db: LibraryDatabase, entityId: string) {
  const link = db.identificationDetail(entityId).link!
  db.identificationDetach(link.id, link.revision, 1300)
}
const configuration = (enabled = true): IdentificationScheduleRequest => ({
  enabled,
  newImports: true,
  history: false,
  providers: [],
  enrichment: { language: 'en', providers: [{ id: PROVIDER, context: CONTEXT, kinds: ['artist'] }] }
})
function drain(db: LibraryDatabase, config = configuration()) {
  for (let i = 0; i < 100; i++) if (!db.identificationSchedule(config, 1200).more) return
  assert.fail('Identification outbox did not drain')
}
function asyncDb(db: LibraryDatabase): EntityMetadataDatabaseApi {
  return new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail('Requery condition timed out')
}
function core(
  t: test.TestContext,
  db: LibraryDatabase,
  provider: MetadataDetailProvider,
  database: EntityMetadataDatabaseApi = asyncDb(db)
) {
  const errors: unknown[] = []
  const service = new CoreEntityMetadataService({
    database,
    provider: new MusicBrainzWikiProvider(() => policy),
    enrichmentProviders: () => [provider],
    policy: () => policy,
    now: () => 2000,
    changed() {},
    failed: (error) => errors.push(error)
  })
  t.after(async () => {
    await service.shutdown()
    assert.deepEqual(errors, [])
  })
  return service
}
function detailProvider(patch: Partial<MetadataDetailProvider> = {}): MetadataDetailProvider {
  return {
    id: PROVIDER,
    supports: (kind) => kind === 'artist',
    blockedReason: () => null,
    context: () => CONTEXT,
    enrich: async () => ({ facts: [fact('Refreshed')], availability: 'available' }),
    ...patch
  }
}

test('requery payloads bound a batch and reject duplicate jobs, private fields and invalid revisions', () => {
  const entry = {
    jobId: 'job',
    generation: 1,
    entityId: 'entity',
    inputVersion: 'input',
    linkRevision: 0
  }
  const request = { demandId: 'new-explicit', items: [entry] }
  assert.equal(validMetadataTasksPayload('metadata.entity.requery', request), true)
  for (const invalid of [
    { ...request, items: [] },
    { ...request, items: [entry, entry] },
    { ...request, items: [{ ...entry, generation: 0 }] },
    { ...request, items: [{ ...entry, inputVersion: 'x'.repeat(32769) }] },
    { ...request, items: [{ ...entry, providerContext: 'secret' }] },
    { ...request, items: Array.from({ length: 11 }, (_, i) => ({ ...entry, jobId: `job-${i}` })) }
  ])
    assert.equal(validMetadataTasksPayload('metadata.entity.requery', invalid), false)
})

test('source pagination reads current confirmed real members, never target UUID aliases or private paths', (t) => {
  const { db, entities } = fixture(t, 8)
  const job = initial(db, entities[0].id)
  const before = db.sql.prepare('SELECT total_changes() n').get()!.n
  const first = db.metadataTaskSources({ jobId: job.id, offset: 0, limit: 6 })
  const second = db.metadataTaskSources({ jobId: job.id, offset: 6, limit: 6 })
  assert.equal(first.total, 8)
  assert.equal(first.items.length, 6)
  assert.equal(second.items.length, 2)
  assert.equal(new Set([...first.items, ...second.items].map((source) => source.entity.id)).size, 8)
  assert.ok([...first.items, ...second.items].every((source) => source.entity.id !== job.entityId))
  assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, before)
  assert.equal(JSON.stringify(first).includes('D:/private'), false)
  db.sql.prepare("UPDATE catalog_sources SET availability='missing' WHERE track_id='track-0'").run()
  db.sql.prepare("INSERT INTO catalog_pending VALUES('track-1')").run()
  db.sql.prepare("DELETE FROM tracks WHERE id='track-2'").run()
  assert.equal(db.metadataTaskSources({ jobId: job.id }).total, 5)
})

test('batch requery validates all current batch memberships and input fences before any mutation', (t) => {
  const { db, entities } = fixture(t)
  const one = initial(db, entities[0].id, 'en', 'selected-batch')
  const two = initial(db, entities[0].id, 'zh-Hans', 'other-batch')
  const selected = [item(db, one), item(db, two)]
  const before = db.metadataJobs({}).items
  assert.throws(
    () =>
      db.metadataRequery(
        { items: selected, demandId: 'not-published', batchId: 'selected-batch' },
        contexts,
        1200
      ),
    /变化/
  )
  assert.deepEqual(db.metadataJobs({}).items, before)
  assert.equal(db.metadataTasks({ batchId: 'not-published' }).total, 0)
  db.metadataEnqueue(
    {
      entityId: entities[0].id,
      type: 'enrich',
      provider: PROVIDER,
      providerContext: CONTEXT,
      language: 'zh-Hans',
      batchId: 'selected-batch'
    },
    1150
  )
  assert.throws(
    () =>
      db.metadataRequery(
        {
          items: [selected[0], { ...selected[1], inputVersion: 'stale' }],
          demandId: 'also-not-published',
          batchId: 'selected-batch'
        },
        contexts,
        1200
      ),
    /变化/
  )
  assert.deepEqual(db.metadataJobs({}).items, before)
  const restored = db.metadataRequery(
    { items: selected, demandId: 'published', batchId: 'selected-batch' },
    contexts,
    1200
  )
  assert.equal(restored.jobs.length, 2)
  assert.equal(db.metadataTasks({ batchId: 'published' }).total, 2)
  assert.ok(restored.jobs.every((job) => job.state === 'queued' && job.generation === 2))
})

test('only enrichment terminal states can requery and automatic demand IDs cannot impersonate explicit authorization', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  const selected = item(db, job)
  const auto = String(
    db.sql
      .prepare('SELECT demand_id FROM metadata_identification_schedule WHERE entity_id=?')
      .get(entities[0].id)!.demand_id
  )
  assert.throws(
    () => db.metadataRequery({ items: [selected], demandId: auto }, contexts, 1200),
    /变化/
  )
  for (const nextState of ['queued', 'running', 'retry_wait', 'needs_review'] as const) {
    forceState(db, job, nextState)
    assert.equal(db.metadataTaskSources({ jobId: job.id }).total, 0)
    assert.throws(
      () => db.metadataRequery({ items: [selected], demandId: 'invalid-state' }, contexts, 1200),
      /变化/
    )
  }
  forceState(db, job, 'failed')
  assert.equal(requery(db, state(db, job.id)).generation, job.generation + 1)
  assert.throws(
    () => db.metadataRequery({ items: [selected], demandId: 'old-generation' }, contexts, 1201),
    /变化/
  )
})

for (const [name, change] of Object.entries({
  'source removed before catalog projection catches up': (db: LibraryDatabase, _entityId: string) =>
    db.sql.prepare("DELETE FROM tracks WHERE id='track-0'").run(),
  'source awaiting catalog rebuild': (db: LibraryDatabase, _entityId: string) =>
    db.sql.prepare("INSERT INTO catalog_pending VALUES('track-0')").run(),
  'library membership removed': (db: LibraryDatabase, _entityId: string) =>
    db.sql
      .prepare(
        "DELETE FROM catalog_memberships WHERE source_id IN (SELECT id FROM catalog_sources WHERE track_id='track-0')"
      )
      .run(),
  'input version changed': (db: LibraryDatabase, entityId: string) =>
    db.sql.prepare("UPDATE catalog_entities SET title=title||' revised' WHERE id=?").run(entityId),
  'identity detached': detach
})) {
  test(`new-generation authorization rejects ${name} before claiming network work`, (t) => {
    const { db, entities } = fixture(t)
    const entity = entities.find((entity) =>
      db.identificationInput(entity.id).sources!.some((source) => source.trackId === 'track-0')
    )!
    const job = initial(db, entity.id)
    const restored = requery(db, job, 'new-authorization', entity.id)
    change(db, entity.id)
    assert.equal(db.metadataClaim(2000), null)
    assert.equal(state(db, job.id).state, 'cancelled')
    assert.ok(state(db, job.id).generation > restored.generation)
    assert.equal(
      db.metadataTaskDemands({ jobId: job.id }).total,
      2,
      'old explicit demands remain but cannot authorize a new generation'
    )
    assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_facts').get()!.n, 1)
  })
}

test('input and link fences are rechecked at commit, preserving existing facts', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  const restored = requery(db, job, 'commit-fence', entities[0].id)
  const work = db.metadataClaim(1200)!
  assert.equal(work.job.generation, restored.generation)
  detach(db, entities[0].id)
  assert.equal(db.metadataFinish(work, completed('Must not publish'), 1301), false)
  assert.equal(state(db, job.id).state, 'cancelled')
  assert.equal(
    JSON.parse(String(db.sql.prepare('SELECT payload FROM metadata_facts').get()!.payload)).value,
    'Original introduction'
  )
})

test('cancelling the new authorization ignores old completed consumers and rejects stale cancel controls', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  const restored = requery(db, job)
  const work = db.metadataClaim(1200)!
  assert.throws(() => db.metadataCancel(job.id, 'requery', 1201, job.generation), /变化/)
  assert.equal(db.metadataCancel(job.id, 'requery', 1202, restored.generation), true)
  assert.equal(db.metadataFinish(work, completed('Cancelled late data'), 1203), false)
  assert.equal(state(db, job.id).state, 'cancelled')
  assert.deepEqual(
    db.metadataTaskDemands({ jobId: job.id }).items.map((demand) => demand.batchId),
    ['original']
  )
})

test('requery preserves a saved retry time, personal values, explicit clearing and useful old facts', (t) => {
  const { db, entities } = fixture(t)
  const [a, b] = entities
  const job = initial(db, a.id)
  db.metadataOverride(
    {
      entityId: a.id,
      revision: db.metadataDetail(a.id, 'en').revision,
      mode: 'value',
      value: 'My introduction',
      language: 'en'
    },
    1150
  )
  db.metadataOverride(
    {
      entityId: b.id,
      revision: db.metadataDetail(b.id, 'en').revision,
      mode: 'clear',
      language: 'en'
    },
    1150
  )
  forceState(db, job, 'failed', 60000)
  const restored = requery(db, state(db, job.id), 'after-cooldown', a.id)
  assert.equal(restored.nextAttemptAt, 60000)
  assert.equal(db.metadataClaim(59999), null)
  const work = db.metadataClaim(60000)!
  assert.equal(
    db.metadataFinish(work, { state: 'completed', outcome: 'not_found', facts: [] }, 60001),
    true
  )
  assert.equal(db.metadataDetail(a.id, 'en').introduction!.value, 'My introduction')
  assert.equal(db.metadataDetail(b.id, 'en').introduction, null)
  assert.equal(db.metadataDetail(a.id, 'en').facts[0].value, 'Original introduction')
})

test('invalid explicit consumer falls back to another real automatic consumer and current automation is a commit fence', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  drain(db)
  requery(db, job, 'new-human', entities[0].id)
  detach(db, entities[0].id)
  const work = db.metadataClaim(1200)!
  assert.ok(work)
  assert.equal(work.job.id, job.id)
  assert.equal(work.automatic!.origin, 'new')
  assert.equal(
    db.metadataFinish(work, completed('Disabled automatic reply'), 1301, configuration(false)),
    false
  )
  assert.equal(state(db, job.id).state, 'cancelled')
  assert.equal(db.metadataDetail(entities[1].id, 'en').introduction!.value, 'Original introduction')
})

test('a live explicit requery is independent of automatic switches', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  drain(db, configuration(false))
  requery(db, job, 'explicit-with-automatic-off', entities[0].id)
  const work = db.metadataClaim(1200)!
  assert.ok(work)
  assert.equal(work.automatic, undefined)
  assert.equal(
    db.metadataFinish(work, completed('Explicitly refreshed'), 1201, configuration(false)),
    true
  )
  assert.equal(db.metadataDetail(entities[0].id, 'en').introduction!.value, 'Explicitly refreshed')
})

test('cancelling an explicit requery leaves another currently authorized automatic consumer running', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  drain(db)
  const restored = requery(db, job, 'cancel-only-new-consumer', entities[0].id)
  const work = db.metadataClaim(1200)!
  assert.equal(
    db.metadataCancel(job.id, 'cancel-only-new-consumer', 1201, restored.generation),
    true
  )
  assert.equal(state(db, job.id).state, 'running')
  assert.equal(
    db.metadataFinish(work, completed('Shared automatic result'), 1202, configuration()),
    true
  )
  assert.equal(
    db.metadataDetail(entities[1].id, 'en').introduction!.value,
    'Shared automatic result'
  )
})

test('the established explicit enrichment entry point remains usable after an earlier requery consumer becomes invalid', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  requery(db, job, 'old-requery', entities[0].id)
  detach(db, entities[0].id)
  const explicit = db.metadataEnqueue(
    {
      entityId: entities[1].id,
      type: 'enrich',
      language: 'en',
      provider: PROVIDER,
      providerContext: CONTEXT,
      batchId: 'established-explicit-entry'
    },
    1301
  )
  assert.equal(explicit.id, job.id)
  assert.equal(explicit.requeryConsumers, undefined)
  const work = db.metadataClaim(1301)!
  assert.ok(work)
  assert.equal(db.metadataFinish(work, completed('Original entry still works'), 1302), true)
  assert.equal(
    db.metadataDetail(entities[1].id, 'en').introduction!.value,
    'Original entry still works'
  )
})

test('an automatic enqueue cannot remove requery authorization fences or bypass disabled automation', (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  drain(db, configuration(false))
  const restored = requery(db, job, 'only-human-authorization', entities[0].id)
  detach(db, entities[0].id)
  const automatic = String(
    db.sql
      .prepare('SELECT demand_id FROM metadata_identification_schedule WHERE entity_id=?')
      .get(entities[1].id)!.demand_id
  )
  const attempted = db.metadataEnqueue(
    {
      entityId: entities[1].id,
      type: 'enrich',
      language: 'en',
      provider: PROVIDER,
      providerContext: CONTEXT,
      batchId: automatic
    },
    1301
  )
  assert.deepEqual(attempted.requeryConsumers, restored.requeryConsumers)
  assert.equal(db.metadataClaim(1301), null)
  assert.equal(state(db, job.id).state, 'cancelled')
})

test('Core rejects unavailable capability and stale provider context before changing a persisted job', async (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  let reason: string | null = 'platform_metadata_cache_not_approved'
  let context = CONTEXT
  const service = core(
    t,
    db,
    detailProvider({ blockedReason: () => reason, context: () => context })
  )
  const request = { items: [item(db, job)], demandId: 'not-authorized' }
  await assert.rejects(service.requery(request), /platform_metadata_cache_not_approved/)
  reason = null
  context = 'different-account'
  await assert.rejects(service.requery(request), /变化/)
  assert.equal(state(db, job.id).generation, job.generation)
  assert.equal(db.metadataTasks({ batchId: request.demandId }).total, 0)
})

test('Core fences account changes after enqueue but before execution', async (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  let context = CONTEXT,
    calls = 0
  const service = core(
    t,
    db,
    detailProvider({
      context: () => context,
      enrich: async () => {
        calls++
        return { facts: [fact('Wrong account')], availability: 'available' }
      }
    })
  )
  await service.requery({ items: [item(db, job)], demandId: 'before-account-change' })
  context = 'different-account'
  service.activate()
  await until(() => state(db, job.id).state === 'blocked')
  assert.equal(calls, 0)
  assert.equal(state(db, job.id).reason, 'provider_configuration_changed')
  assert.equal(db.metadataDetail(entities[0].id, 'en').introduction!.value, 'Original introduction')
})

test('Core fences account changes during a real asynchronous provider call', async (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  let context = CONTEXT
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  const service = core(
    t,
    db,
    detailProvider({
      context: () => context,
      enrich: async () => {
        entered = true
        await waiting
        return { facts: [fact('Wrong account')], availability: 'available' }
      }
    })
  )
  t.after(() => release())
  await service.requery({ items: [item(db, job)], demandId: 'in-flight-account' })
  service.activate()
  await until(() => entered)
  context = 'different-account'
  release()
  await until(() => state(db, job.id).state === 'blocked')
  assert.equal(state(db, job.id).reason, 'provider_configuration_changed')
  assert.equal(db.metadataDetail(entities[0].id, 'en').introduction!.value, 'Original introduction')
})

test('cancelling the last new-generation consumer aborts its in-flight provider despite retained historical demands', async (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  let entered = false,
    aborted = false
  const service = core(
    t,
    db,
    detailProvider({
      enrich: async (_request, signal) => {
        entered = true
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true }
          )
        })
        return { facts: [], availability: 'not_found' }
      }
    })
  )
  const restored = await service.requery({
    items: [item(db, job)],
    demandId: 'cancel-live-generation'
  })
  service.activate()
  await until(() => entered)
  assert.equal(await service.cancel(job.id, restored.batchId, state(db, job.id).generation), true)
  assert.equal(state(db, job.id).state, 'cancelled')
  assert.equal(aborted, true)
  assert.deepEqual(
    db.metadataTaskDemands({ jobId: job.id }).items.map((demand) => demand.batchId),
    ['original']
  )
})

test('a lost requery acknowledgement is reconciled without replaying the accepted mutation', async (t) => {
  const { db, entities } = fixture(t)
  const job = initial(db, entities[0].id)
  const original = asyncDb(db),
    enqueue = original.metadataRequery.bind(original)
  let writes = 0
  const database = new Proxy(original, {
    get: (target, key: keyof EntityMetadataDatabaseApi) =>
      key === 'metadataRequery'
        ? async (...args: Parameters<EntityMetadataDatabaseApi['metadataRequery']>) => {
            writes++
            await enqueue(...args)
            throw new Error('Acknowledgement lost')
          }
        : target[key]
  })
  const service = core(t, db, detailProvider(), database)
  await assert.rejects(
    service.requery({ items: [item(db, job)], demandId: 'known-before-write' }),
    /Acknowledgement lost/
  )
  assert.equal(db.metadataTasks({ batchId: 'known-before-write' }).total, 1)
  service.activate()
  await until(() => state(db, job.id).state === 'completed')
  assert.equal(writes, 1)
  assert.equal(state(db, job.id).generation, job.generation + 1)
  assert.equal(db.metadataDetail(entities[0].id, 'en').introduction!.value, 'Refreshed')
})

test(
  'a newly requeued generation still observes the existing shared HTTP host Retry-After',
  { timeout: 5000 },
  async (t) => {
    const { db, entities } = fixture(t)
    const job = initial(db, entities[0].id)
    const calls: number[] = []
    const http = new MetadataHttp(async () => {
      calls.push(Date.now())
      return calls.length === 1
        ? new Response(null, { status: 429, headers: { 'Retry-After': '0.2' } })
        : new Response('{}')
    }, 1)
    const url = `https://musicbrainz.org/ws/2/artist/${MBID}?fmt=json`
    assert.equal((await http.fetch(url)).status, 429)
    let entered = false
    const service = core(
      t,
      db,
      detailProvider({
        enrich: async () => {
          entered = true
          assert.equal((await http.fetch(url)).status, 200)
          return { facts: [fact('After host cooldown')], availability: 'available' }
        }
      })
    )
    await service.requery({ items: [item(db, job)], demandId: 'respect-host-cooldown' })
    service.activate()
    await until(() => entered)
    assert.equal(calls.length, 1)
    await until(() => state(db, job.id).state === 'completed')
    assert.equal(calls.length, 2)
    assert.ok(calls[1] - calls[0] >= 175, 'fresh generation must not bypass host Retry-After')
  }
)

test(
  'real database worker replacement retains the new demand and fences the pre-recovery running generation',
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'metadata-requery-worker-'))
    const json = join(root, 'library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        {
          id: 'worker-track',
          source: 'local',
          filePath: join(root, 'one.flac'),
          title: 'Worker song',
          artist: 'Worker artist',
          album: 'Worker album'
        }
      ])
    )
    const create = () =>
      new LibraryDatabaseServiceClient({
        serviceEntry: fileURLToPath(
          new URL('../../main/library/libraryDatabaseService.ts', import.meta.url)
        ),
        libraryFilePath: json,
        fork: (entry) => {
          const child = fork(entry, [], {
            execArgv: ['--experimental-strip-types'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc']
          })
          children.push(child)
          Object.assign(child, {
            postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
          })
          return child as unknown as DatabaseUtilityProcess
        }
      })
    let client = create()
    t.after(async () => {
      client.destroy()
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      rmSync(root, { recursive: true, force: true })
    })
    await client.getMetadata()
    while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
    const entity = (await client.catalogQuery({ kind: 'artist' })).items[0]
    const [candidate] = await client.identificationPublish(
      await client.identificationInput(entity.id),
      [
        {
          provider: 'musicbrainz',
          name: 'Worker artist',
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
    await client.identificationDecide(
      {
        candidateId: candidate.id,
        revision: candidate.revision,
        linkRevision: candidate.linkRevision,
        decision: 'confirm'
      },
      1001
    )
    const job = await client.metadataEnqueue(
      {
        entityId: entity.id,
        provider: PROVIDER,
        providerContext: CONTEXT,
        type: 'enrich',
        language: 'en',
        batchId: 'worker-original'
      },
      1100
    )
    await client.metadataFinish((await client.metadataClaim(1100))!, completed(), 1101)
    const source = (await client.metadataTaskSources({ jobId: job.id })).items[0]
    const request: MetadataTaskRequery = {
      items: [
        {
          jobId: job.id,
          generation: job.generation,
          entityId: source.entity.id,
          inputVersion: source.inputVersion,
          linkRevision: source.linkRevision
        }
      ],
      demandId: 'worker-known-requery'
    }
    await client.metadataRequery(request, contexts, 1200)
    const beforeCrash = (await client.metadataClaim(1200))!
    const exited = once(children.at(-1)!, 'exit')
    client.destroy()
    await exited
    client = create()
    await client.getMetadata()
    await client.metadataRecover(1300)
    const recovered = (await client.metadataJobs({ jobId: job.id })).items[0]
    assert.equal(recovered.state, 'queued')
    assert.ok(recovered.generation > beforeCrash.job.generation)
    assert.deepEqual(recovered.requeryConsumers, beforeCrash.job.requeryConsumers)
    assert.equal((await client.metadataTasks({ batchId: request.demandId })).total, 1)
    assert.equal(
      await client.metadataFinish(beforeCrash, completed('Old worker reply'), 1301),
      false
    )
    const fresh = (await client.metadataClaim(1301))!
    assert.equal(
      await client.metadataFinish(fresh, completed('Replacement worker reply'), 1302),
      true
    )
    assert.equal(
      (await client.metadataDetail(entity.id, 'en')).introduction!.value,
      'Replacement worker reply'
    )
  }
)
