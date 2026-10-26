import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  EntityMetadataJob,
  EntityMetadataPolicyView
} from '../../../../shared/entityMetadata.ts'
import type { MetadataTaskSourcesPage } from '../../../../shared/entityMetadataTasks.ts'
import { artistUpdateProviders, createArtistMetadataUpdate } from './artistMetadataUpdate.ts'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'

const policy: EntityMetadataPolicyView = {
  enabled: false,
  identity: true,
  introduction: true,
  reason: null,
  sources: [
    {
      provider: 'musicbrainz',
      identification: [],
      enrichment: [
        { provider: 'musicbrainz-details', kind: 'artist', reason: null },
        { provider: 'public-artwork', kind: 'artist', reason: null }
      ]
    }
  ]
}
const job: EntityMetadataJob = {
  id: 'job',
  entityId: 'shared-target',
  type: 'enrich',
  provider: 'musicbrainz-details',
  language: 'en',
  externalId: 'mbid',
  state: 'queued',
  generation: 2,
  attempts: 0,
  nextAttemptAt: 0,
  outcome: null,
  reason: null,
  candidate: null,
  updatedAt: 0
}
const source = (id: string) => ({
  entity: { id, kind: 'artist' as const, title: id, artist: '' },
  inputVersion: `version:${id}`,
  linkRevision: 3,
  providers: ['local']
})
const fixture = () => {
  const calls: Array<{ name: string; request: unknown }> = []
  let nextId = 0
  const api: Parameters<typeof createArtistMetadataUpdate>[0] = {
    policy: async () => policy,
    jobs: async () => ({ items: [job] }),
    enrich: async (request) => {
      calls.push({ name: 'enrich', request })
      return job
    },
    sources: async (query) => ({
      ...query,
      generation: 2,
      offset: query.offset ?? 0,
      total: 1,
      items: [source('selected')]
    }),
    requery: async (request) => {
      calls.push({ name: 'requery', request })
    },
    newId: () => `artist-page:test-${++nextId}`
  }
  return { api, calls }
}

test('opening is read-only; explicit providers ignore automatic history/import switches', async () => {
  const f = fixture(),
    view = createArtistMetadataUpdate(f.api)
  await view.setContext({ entityId: 'selected', language: 'en' })
  assert.equal(f.calls.length, 0)
  assert.deepEqual(artistUpdateProviders(policy), ['musicbrainz-details', 'public-artwork'])
  assert.deepEqual(
    artistUpdateProviders({
      ...policy,
      sources: [
        {
          provider: 'musicbrainz',
          identification: [],
          enrichment: [
            { provider: 'musicbrainz-details', kind: 'artist', reason: 'permission_denied' }
          ]
        }
      ]
    }),
    []
  )
  await view.submit()
  assert.deepEqual(
    f.calls.map((c) => c.request),
    [
      {
        entityId: 'selected',
        language: 'en',
        batchId: 'artist-page:test-1',
        provider: 'musicbrainz-details'
      },
      {
        entityId: 'selected',
        language: 'en',
        batchId: 'artist-page:test-1',
        provider: 'public-artwork'
      }
    ]
  )
  assert.match(view.state.value.notice, /2/)
  assert.deepEqual(
    artistUpdateProviders({ ...policy, identity: false, introduction: false, sources: [] }),
    []
  )
  view.dispose()
})

test('a recently completed shared job is explicitly requeried for the exact selected source across pages', async () => {
  const f = fixture(),
    offsets: number[] = []
  f.api.enrich = async (request) => ({ ...job, id: request.provider!, state: 'completed' })
  f.api.sources = async (query) => {
    offsets.push(query.offset ?? 0)
    return {
      jobId: query.jobId,
      generation: 2,
      offset: query.offset ?? 0,
      total: 101,
      items: query.offset
        ? [source('selected')]
        : Array.from({ length: 100 }, (_, i) => source(String(i)))
    }
  }
  const view = createArtistMetadataUpdate(f.api)
  await view.setContext({ entityId: 'selected', language: 'en' })
  await view.submit()
  assert.deepEqual(offsets, [0, 100, 0, 100])
  assert.deepEqual(f.calls[0], {
    name: 'requery',
    request: {
      demandId: 'artist-page:test-2',
      items: [
        {
          jobId: 'musicbrainz-details',
          generation: 2,
          entityId: 'selected',
          inputVersion: 'version:selected',
          linkRevision: 3
        }
      ]
    }
  })
  assert.equal((f.calls[1].request as { demandId: string }).demandId, 'artist-page:test-3')
  view.dispose()
})

test('stale generation and missing source are errors, while accepted partial work stays visible', async () => {
  for (const stale of [true, false]) {
    const f = fixture()
    f.api.enrich = async (request) =>
      request.provider === 'public-artwork' ? { ...job, state: 'completed' } : job
    f.api.sources = async (query) => ({
      jobId: query.jobId,
      generation: stale ? 3 : 2,
      offset: 0,
      total: 0,
      items: []
    })
    const view = createArtistMetadataUpdate(f.api)
    await view.setContext({ entityId: 'selected', language: 'en' })
    await view.submit()
    assert.match(view.state.value.notice, /1/)
    assert.match(view.state.value.error, stale ? /任务已变化/ : /不属于此人物/)
    assert.equal(f.calls.length, 0)
    view.dispose()
  }
})

test('switching context or disposing during a source read never issues a subsequent requery', async () => {
  for (const dispose of [true, false]) {
    const f = fixture()
    let finish!: (page: MetadataTaskSourcesPage) => void
    f.api.enrich = async () => ({ ...job, state: 'completed' })
    f.api.sources = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const view = createArtistMetadataUpdate(f.api)
    await view.setContext({ entityId: 'selected', language: 'en' })
    const submitted = view.submit()
    await Promise.resolve()
    if (dispose) view.dispose()
    else await view.setContext({ entityId: 'new-person', language: 'en' })
    finish({ jobId: job.id, generation: 2, offset: 0, total: 1, items: [source('selected')] })
    await submitted
    assert.deepEqual(f.calls, [])
    assert.equal(view.state.value.submitting, false)
    view.dispose()
  }
})

test('read and submit failures remain actionable rather than reporting success', async () => {
  const f = fixture()
  f.api.policy = async () => {
    throw Error('read failed')
  }
  const view = createArtistMetadataUpdate(f.api)
  await view.setContext({ entityId: 'selected', language: 'en' })
  assert.equal(view.state.value.error, 'read failed')
  await view.submit()
  assert.deepEqual(f.calls, [])
  f.api.policy = async () => policy
  await view.refresh()
  f.api.enrich = async () => {
    throw Error('permission withdrawn')
  }
  await view.submit()
  assert.match(view.state.value.error, /permission withdrawn/)
  assert.equal(view.state.value.notice, '')
  view.dispose()
})

test('completed typed jobs requeue through the real database with fresh demand IDs and read back new text', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'track',
        source: 'local',
        filePath: 'D:/fixture/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entityId = db.catalogQuery({ kind: 'artist' }).items[0].id
  const [candidate] = db.identificationPublish(
    db.identificationInput(entityId),
    [
      {
        provider: 'musicbrainz',
        name: 'Artist',
        summary: '',
        matcherVersion: 'fixture',
        references: [
          {
            provider: 'musicbrainz',
            kind: 'artist',
            idType: 'mbid',
            value: '151bb385-1af0-40b6-9269-bf2ed982311f'
          }
        ],
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
  const contexts: Record<string, string> = {
    'musicbrainz-details': 'text-context',
    'public-artwork': 'image-context'
  }
  for (const provider of Object.keys(contexts)) {
    db.metadataEnqueue(
      {
        entityId,
        language: 'en',
        type: 'enrich',
        provider,
        providerContext: contexts[provider],
        batchId: 'original'
      },
      2000
    )
    const work = db.metadataClaim(2000)!
    assert.equal(
      db.metadataFinish(work, { state: 'completed', outcome: 'not_found', facts: [] }, 2001),
      true
    )
  }
  let id = 0
  const view = createArtistMetadataUpdate({
    policy: async () => policy,
    jobs: async () => db.metadataJobs({ entityId }),
    enrich: async (request) =>
      db.metadataEnqueue(
        { ...request, type: 'enrich', providerContext: contexts[request.provider!] },
        3000
      ),
    sources: async (query) => db.metadataTaskSources(query),
    requery: async (request) => db.metadataRequery(request, contexts, 3001),
    newId: () => `real-db-update:${++id}`
  })
  t.after(() => view.dispose())
  await view.setContext({ entityId, language: 'en' })
  await view.submit()
  assert.equal(view.state.value.error, '')
  assert.match(view.state.value.notice, /2/)
  const jobs = db.metadataJobs({ entityId }).items
  assert.equal(jobs.length, 2)
  assert.ok(jobs.every((job) => job.state === 'queued' && job.generation === 2))
  assert.equal(new Set(jobs.map((job) => job.requeryConsumers![0].batchId)).size, 2)
  for (let i = 0; i < 2; i++) {
    const work = db.metadataClaim(3002)!
    assert.ok(work)
    assert.equal(
      db.metadataFinish(
        work,
        {
          state: 'completed',
          outcome: 'matched',
          facts:
            work.job.provider === 'musicbrainz-details'
              ? [
                  {
                    field: 'introduction',
                    value: 'Complete refreshed introduction',
                    language: 'en',
                    attribution: {
                      provider: 'wikipedia',
                      externalId: 'Artist',
                      url: 'https://en.wikipedia.org/wiki/Artist',
                      license: 'CC-BY-SA-4.0',
                      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
                      attribution: 'Wikipedia contributors',
                      revision: '2',
                      retrievedAt: 3003
                    }
                  }
                ]
              : []
        },
        3003
      ),
      true
    )
  }
  assert.equal(
    db.metadataDetail(entityId, 'en').introduction?.value,
    'Complete refreshed introduction'
  )
})
