import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createCoreListeningStats } from './coreListeningStats.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreStatisticsOverview } from '../../../shared/coreStatistics.ts'

const stateAt = (epoch = 'first', revision = 3) =>
  ({ epoch, phase: 'ready', statisticsRevision: revision }) as CoreSnapshot
const summary = (revision = 3): CoreStatisticsOverview => ({
  revision, trackCount: 450, days: { '2026-10-23': 4500 },
  persistence: { dirty: false, failureCount: 0, error: null },
  recorded: { seconds: 4500, plays: 450, trackCount: 450, formats: [] },
  artists: [], history: { mode: 'sqlite', ready: true, pending: false, revision: 1, error: '' }
})
const tick = () => new Promise<void>((done) => setImmediate(done))

test('statistics projection uses bounded ranking pages and exact all-history totals; snapshots are immutable', async () => {
  const state = shallowRef<CoreSnapshot | null>(stateAt())
  const queries: unknown[] = [], clears: unknown[] = []
  const projection = createCoreListeningStats({
    state, overview: async () => summary(),
    page: async (query) => { queries.push(query); return { revision: 3, total: 450, offset: 0, items: [] } },
    clear: async (...args) => { clears.push(args) }
  })
  await projection.ensure()
  assert.deepEqual(queries, ['recent', 'plays', 'seconds'].map((sort) => ({ sort, limit: 200, revision: 3 })))
  assert.equal(projection.overview.value?.recorded.trackCount, 450)
  assert.throws(() => { projection.overview.value!.days['2026-10-23'] = 0 }, TypeError)
  await projection.clear(null, 2)
  assert.deepEqual(clears, [[null, 2]], 'preview revision is forwarded unchanged, not silently replaced')
  projection.dispose()
  assert.equal(clears.length, 1)
})

test('epoch changes cancel old reads without cancelling Core work or publishing stale results', async () => {
  const state = shallowRef<CoreSnapshot | null>(stateAt())
  const requests: Array<{ signal: AbortSignal; resolve(value: CoreStatisticsOverview): void }> = []
  const projection = createCoreListeningStats({ state,
    overview: (signal) => new Promise((resolve) => { requests.push({ signal, resolve }) }),
    page: async (query) => ({ revision: query.revision!, total: 0, offset: 0, items: [] }),
    clear: async () => { throw Error('no writes expected') }
  })
  state.value = stateAt('second', 4)
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve(summary(4))
  await tick()
  requests[0].resolve(summary(3))
  await tick()
  assert.equal(projection.overview.value?.revision, 4)
  projection.dispose()
  assert.equal(requests[1].signal.aborted, true)
})
