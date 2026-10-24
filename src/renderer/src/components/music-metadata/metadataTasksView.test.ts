import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  MetadataTasksPage,
  MetadataTaskDemandsPage,
  MetadataTasksQuery
} from '../../../../shared/entityMetadataTasks.ts'
import {
  createMetadataTasksView,
  METADATA_TASK_PAGE_SIZE,
  METADATA_DEMAND_PAGE_SIZE
} from './metadataTasksView.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const page = (offset = 0): MetadataTasksPage => ({
  offset,
  total: 11,
  counts: {
    queued: 1,
    running: 0,
    retry_wait: 0,
    needs_review: 1,
    blocked: 0,
    failed: 0,
    completed: 0,
    cancelled: 0
  },
  items: [
    {
      id: 'a',
      type: 'identify',
      provider: 'platform.ncm',
      language: 'en',
      state: 'queued',
      generation: 1,
      attempts: 0,
      nextAttemptAt: 1000,
      outcome: null,
      reason: null,
      updatedAt: 1000,
      title: 'Artist',
      kind: 'artist',
      entity: { id: 'catalog', title: 'Artist', kind: 'artist', artist: 'Artist' },
      demandCount: 2
    }
  ]
})
const demands = (offset = 0): MetadataTaskDemandsPage => ({
  jobId: 'a',
  offset,
  total: 7,
  items: [{ batchId: 'explicit', automatic: false, origin: null, canCancel: true }]
})

test('task view pages and filters persisted jobs and demands without creating tasks', async () => {
  const lists: MetadataTasksQuery[] = [],
    demandCalls: unknown[] = []
  const view = createMetadataTasksView({
    tasks: async (query) => {
      lists.push(query)
      return page(query.offset)
    },
    demands: async (query) => {
      demandCalls.push(query)
      return demands(query.offset)
    },
    cancel: async () => assert.fail('read-only path')
  })
  await view.refresh()
  view.select('a')
  await tick()
  await view.demandsPage(6)
  assert.deepEqual(demandCalls, [
    { jobId: 'a', offset: 0, limit: METADATA_DEMAND_PAGE_SIZE },
    { jobId: 'a', offset: 6, limit: METADATA_DEMAND_PAGE_SIZE }
  ])
  await view.page(10)
  assert.equal(view.state.value.selectedId, null)
  await view.filter('attention', 'batch')
  assert.deepEqual(lists, [
    { filter: 'all', offset: 0, limit: METADATA_TASK_PAGE_SIZE },
    { filter: 'all', offset: 10, limit: METADATA_TASK_PAGE_SIZE },
    { filter: 'attention', batchId: 'batch', offset: 0, limit: METADATA_TASK_PAGE_SIZE }
  ])
  view.dispose()
})

test('cancellation is single-flight and scoped to one persisted consumer; uncertain replies trigger reads, never replay', async () => {
  let resolve!: () => void,
    writes = 0,
    reads = 0,
    uncertain = false
  const view = createMetadataTasksView({
    tasks: async () => {
      reads++
      return page()
    },
    demands: async () => demands(),
    cancel: async (jobId, batchId) => {
      assert.equal(jobId, 'a')
      assert.equal(batchId, 'explicit')
      writes++
      if (uncertain) throw new Error('connection lost after write')
      return new Promise<void>((r) => {
        resolve = r
      })
    }
  })
  await view.refresh()
  view.select('a')
  await tick()
  const saving = view.cancel('explicit')
  await view.cancel('explicit')
  assert.equal(writes, 1)
  resolve()
  await saving
  assert.equal(view.state.value.cancelling, false)
  assert.equal(reads, 2)
  uncertain = true
  await view.cancel('explicit')
  assert.equal(writes, 2)
  assert.equal(reads, 3)
  assert.match(view.state.value.actionError, /结果尚未确认/)
  await view.cancel('other-consumer')
  assert.equal(writes, 2)
  view.dispose()
})

test('an old list, consumer page, cancel receipt and post-unmount response cannot cross an epoch', async () => {
  let listReply!: (value: MetadataTasksPage) => void,
    demandReply!: (value: MetadataTaskDemandsPage) => void,
    cancelReply!: () => void
  const signals: AbortSignal[] = []
  let delayedList = false,
    delayedDemands = false
  const view = createMetadataTasksView({
    tasks: async (_query, signal) => {
      signals.push(signal)
      return delayedList
        ? new Promise((r) => {
            listReply = r
          })
        : page()
    },
    demands: async (_query, signal) => {
      signals.push(signal)
      return delayedDemands
        ? new Promise((r) => {
            demandReply = r
          })
        : demands()
    },
    cancel: async () =>
      new Promise<void>((r) => {
        cancelReply = r
      })
  })
  await view.refresh()
  view.select('a')
  await tick()
  const saving = view.cancel('explicit')
  delayedList = delayedDemands = true
  const loading = view.refresh()
  view.reset()
  listReply(page())
  demandReply(demands())
  cancelReply()
  await Promise.all([loading, saving])
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.demands, null)
  assert.equal(view.state.value.cancelling, false)
  assert.equal(view.state.value.actionError, '')
  assert.ok(signals.slice(-2).every((signal) => signal.aborted))
  const last = view.refresh()
  view.dispose()
  listReply(page())
  await last
  assert.equal(view.state.value.page, null)
})

test('new filters defeat late responses and shrinking totals reset an out-of-range page', async () => {
  let reply!: (value: MetadataTasksPage) => void
  const offsets: number[] = []
  const view = createMetadataTasksView({
    tasks: async (query) => {
      offsets.push(query.offset!)
      if (query.filter === 'all')
        return new Promise((r) => {
          reply = r
        })
      return { ...page(query.offset), total: 1, items: query.offset ? [] : page().items }
    },
    demands: async () => demands(),
    cancel: async () => {}
  })
  const old = view.refresh()
  await view.filter('active')
  reply({ ...page(), total: 100 })
  await old
  assert.equal(view.state.value.page!.total, 1)
  await view.page(10)
  assert.equal(view.state.value.page!.offset, 0)
  assert.deepEqual(offsets, [0, 0, 10, 0])
  view.dispose()
})

test('failed list and consumer reads remain recoverable without enabling a stale cancellation', async () => {
  let fail = false,
    writes = 0
  const view = createMetadataTasksView({
    tasks: async () => {
      if (fail) throw new Error('database unavailable')
      return page()
    },
    demands: async () => {
      if (fail) throw new Error('consumer read failed')
      return demands()
    },
    cancel: async () => {
      writes++
    }
  })
  await view.refresh()
  view.select('a')
  await tick()
  fail = true
  await view.refresh()
  assert.match(view.state.value.error, /database unavailable/)
  assert.equal(view.state.value.demands, null)
  await view.cancel('explicit')
  assert.equal(writes, 0)
  fail = false
  await view.refresh()
  assert.equal(view.state.value.error, '')
  view.dispose()
})
