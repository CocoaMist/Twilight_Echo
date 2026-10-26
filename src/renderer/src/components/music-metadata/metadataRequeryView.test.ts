import assert from 'node:assert/strict'
import test from 'node:test'
import { createMetadataRequeryView } from './metadataRequeryView.ts'
import type {
  MetadataTaskItem,
  MetadataTaskSource,
  MetadataTaskSourcesPage,
  MetadataTaskRequery
} from '../../../../shared/entityMetadataTasks.ts'

const job = (id = 'job'): MetadataTaskItem => ({
  id,
  title: 'Artist',
  type: 'enrich',
  provider: 'platform.ncm',
  kind: 'artist',
  language: 'en',
  state: 'failed',
  generation: 2,
  attempts: 5,
  nextAttemptAt: 1000,
  outcome: null,
  reason: 'failed',
  updatedAt: 1000,
  entity: null,
  demandCount: 1
})
const source = (id = 'local'): MetadataTaskSource => ({
  entity: { id, title: 'Artist', artist: '', kind: 'artist' },
  inputVersion: 'original-input',
  linkRevision: 3,
  providers: [id]
})
const page = (jobId = 'job', offset = 0): MetadataTaskSourcesPage => ({
  jobId,
  generation: 2,
  offset,
  total: 7,
  items: [source(offset ? 'ncm' : 'local')]
})

test('requery source browsing is read-only and never picks the first source; batch selection keeps exact saved fences', async () => {
  const writes: MetadataTaskRequery[] = [],
    queries: unknown[] = []
  let changes = 0
  const view = createMetadataRequeryView({
    sources: async (q) => {
      queries.push(q)
      return page(q.jobId, q.offset)
    },
    requery: async (q) => {
      writes.push(q)
    },
    status: async () => ({ total: 1 }),
    demandId: () => 'new-explicit',
    changed: () => changes++
  })
  view.context([job()], 'old-batch', 'epoch')
  await view.sources('job')
  assert.equal(Object.keys(view.state.value.selected).length, 0)
  await view.submit()
  assert.equal(writes.length, 0)
  view.select('job', 'local')
  await view.sources('job', 6)
  assert.equal(view.state.value.selected.job.entity.id, 'local')
  await view.submit()
  assert.deepEqual(queries, [
    { jobId: 'job', offset: 0, limit: 6 },
    { jobId: 'job', offset: 6, limit: 6 }
  ])
  assert.deepEqual(writes, [
    {
      demandId: 'new-explicit',
      batchId: 'old-batch',
      items: [
        {
          jobId: 'job',
          generation: 2,
          entityId: 'local',
          inputVersion: 'original-input',
          linkRevision: 3
        }
      ]
    }
  ])
  assert.equal(changes, 1)
  assert.deepEqual(view.state.value.selected, {})
  view.dispose()
})

test('requery is single-flight and a lost receipt reconciles the known demand without replay', async () => {
  let reject!: (error: Error) => void,
    writes = 0
  const statuses: string[] = []
  const view = createMetadataRequeryView({
    sources: async () => page(),
    requery: () => {
      writes++
      return new Promise((_resolve, no) => {
        reject = no
      })
    },
    status: async (id) => {
      statuses.push(id)
      return { total: 1 }
    },
    demandId: () => 'known-batch',
    changed() {}
  })
  view.context([job()], null, 'epoch')
  await view.sources('job')
  view.select('job', 'local')
  const operation = view.submit()
  await view.submit()
  assert.equal(writes, 1)
  reject(new Error('lost acknowledgement'))
  await operation
  assert.deepEqual(statuses, ['known-batch'])
  assert.match(view.state.value.message, /新需求已保存/)
  await view.submit()
  assert.equal(writes, 1)
  view.dispose()
})

test('source and submit responses cannot cross epoch, page or generation changes', async () => {
  let resolve!: (page: MetadataTaskSourcesPage) => void, signal: AbortSignal | undefined
  const view = createMetadataRequeryView({
    sources: (_q, s) => {
      signal = s
      return new Promise((yes) => {
        resolve = yes
      })
    },
    requery: async () => assert.fail('stale selection'),
    status: async () => ({ total: 0 }),
    demandId: () => 'id',
    changed() {}
  })
  view.context([job()], null, 'one')
  const reading = view.sources('job')
  view.context([job()], null, 'two')
  assert.equal(signal!.aborted, true)
  resolve(page())
  await reading
  assert.deepEqual(view.state.value.sources, {})
  view.dispose()
})

test('active, review and legacy tasks cannot be retried; stale source pages cannot be selected', async () => {
  let calls = 0
  const view = createMetadataRequeryView({
    sources: async () => {
      calls++
      return { ...page(), generation: 1 }
    },
    requery: async () => assert.fail('ineligible'),
    status: async () => ({ total: 0 }),
    demandId: () => 'id',
    changed() {}
  })
  for (const task of [
    { ...job(), state: 'retry_wait' as const },
    { ...job(), state: 'needs_review' as const },
    { ...job(), type: 'legacy' as const }
  ]) {
    view.context([task], null, task.state + task.type)
    await view.sources('job')
  }
  assert.equal(calls, 0)
  view.context([job()], null, 'enrich')
  await view.sources('job')
  assert.match(view.state.value.errors.job, /已变化/)
  view.select('job', 'local')
  await view.submit()
  assert.deepEqual(view.state.value.selected, {})
  view.dispose()
})

test('a read failure in one selected source cannot silently shrink the confirmed batch', async () => {
  let fail = false,
    writes = 0
  const view = createMetadataRequeryView({
    sources: async (query) => {
      if (fail && query.jobId === 'a') throw new Error('source read failed')
      return page(query.jobId)
    },
    requery: async () => {
      writes++
    },
    status: async () => ({ total: 0 }),
    demandId: () => 'id',
    changed() {}
  })
  view.context([job('a'), job('b')], 'batch', 'epoch')
  for (const id of ['a', 'b']) {
    await view.sources(id)
    view.select(id, 'local')
  }
  fail = true
  await view.sources('a')
  await view.submit()
  assert.equal(writes, 0)
  assert.equal(Object.keys(view.state.value.selected).length, 2)
  assert.match(view.state.value.message, /所选条目存在读取错误/)
  fail = false
  await view.sources('a')
  await view.submit()
  assert.equal(writes, 1)
  view.dispose()
})
