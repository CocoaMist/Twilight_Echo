import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createCoreCloudTransfers } from './coreCloudTransfers.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { NcmCloudTransferProgress } from '../../../shared/ncmCloud.ts'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const state = (revision: number, epoch = 'core') =>
  ({ epoch, phase: 'ready', cloudTransfers: { revision, total: 201, active: 1 } }) as CoreSnapshot
const task = (id: string, stage: NcmCloudTransferProgress['stage'] = 'uploading') =>
  ({ transferId: id, kind: 'upload', stage }) as NcmCloudTransferProgress

test('cloud projection reattaches paged Core tasks without resubmitting or cancelling work', async () => {
  const snapshot = shallowRef<CoreSnapshot | null>(null)
  const reads: number[] = [],
    completions: string[] = []
  let aborted = 0
  const projection = createCoreCloudTransfers({
    state: snapshot,
    page: async (revision, offset, signal) => {
      reads.push(offset)
      signal.addEventListener('abort', () => aborted++)
      return {
        revision,
        active: 1,
        total: 201,
        offset,
        items:
          offset === 0
            ? Array.from({ length: 200 }, (_, id) =>
                task(String(id), revision > 1 && id === 0 ? 'completed' : 'uploading')
              )
            : [task('200')]
      }
    },
    completed: (value) => completions.push(value.transferId),
    failed: (error) => {
      throw error
    }
  })
  snapshot.value = state(1)
  await tick()
  assert.equal(Object.keys(projection.tasks.value).length, 201)
  assert.deepEqual(reads, [0, 200])
  snapshot.value = state(2)
  await tick()
  assert.deepEqual(completions, ['0'])
  projection.dispose()
  assert.equal(aborted, 4)
  assert.equal(projection.tasks.value['200'].stage, 'uploading')
})

test('late cloud pages from a retired epoch cannot replace new Core tasks', async () => {
  const snapshot = shallowRef<CoreSnapshot | null>(null)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const projection = createCoreCloudTransfers({
    state: snapshot,
    page: async (revision, offset) => {
      if (revision === 1) await gate
      return { revision, active: 0, total: 1, offset, items: [task(String(revision))] }
    },
    completed: () => {},
    failed: (error) => {
      throw error
    }
  })
  snapshot.value = state(1, 'old')
  snapshot.value = state(2, 'new')
  await tick()
  release()
  await tick()
  assert.deepEqual(Object.keys(projection.tasks.value), ['2'])
  projection.dispose()
})
