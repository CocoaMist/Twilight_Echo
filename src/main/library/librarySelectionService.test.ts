import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { LibrarySelectionService } from './librarySelectionService.ts'
import type {
  LibrarySelectionApi,
  LibrarySelectionSnapshot
} from '../../shared/librarySelection.ts'

class Owner extends EventEmitter {
  dead = false
  isDestroyed() {
    return this.dead
  }
  destroy() {
    this.dead = true
    this.emit('destroyed')
  }
}
const request = { query: { contentRevision: 7 }, total: 2, ranges: [[0, 2] as [number, number]] }
const snapshot = {
  id: 'worker-id',
  revision: 7,
  total: 2,
  selectedCount: 2,
  localTrackCount: 2,
  fileCount: 2
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(idleMs?: number) {
  const calls: string[] = []
  const api: LibrarySelectionApi = {
    createTrackSelection: async () => {
      calls.push('open')
      return snapshot
    },
    readTrackSelection: async () => {
      calls.push('read')
      return { snapshot, rows: [], nextCursor: null }
    },
    closeTrackSelection: async (id) => {
      calls.push(`close:${id}`)
    }
  }
  return { api, calls, service: new LibrarySelectionService(api, idleMs), owner: new Owner() }
}

test('selection leases bind to a window and hide worker identities from ready/page replies', async () => {
  const { service, owner, calls } = fixture(),
    other = new Owner()
  const ready = await service.handle(owner, { kind: 'open', id: 'view-1', request })
  assert.equal(ready.kind, 'ready')
  if (ready.kind === 'ready') assert.equal(ready.snapshot.id, 'view-1')
  await assert.rejects(service.handle(other, { kind: 'read', id: 'view-1' }), /不属于/)
  assert.deepEqual(await service.handle(other, { kind: 'close', id: 'view-1' }), {
    kind: 'closed',
    id: 'view-1'
  })
  const page = await service.handle(owner, { kind: 'read', id: 'view-1' })
  assert.equal(page.kind, 'page')
  if (page.kind === 'page') assert.equal(page.page.snapshot.id, 'view-1')
  await assert.rejects(service.handle(owner, { kind: 'open', id: 'second', request }), /请先/)
  await assert.rejects(service.handle(owner, { kind: 'close', id: 'wrong-id' }), /不属于/)
  await service.handle(owner, { kind: 'close', id: 'view-1' })
  assert.deepEqual(calls, ['open', 'read', 'close:worker-id'])
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('window destruction during open rejects late publication and releases the unknown-yet worker lease', async () => {
  const { api, calls, owner } = fixture()
  let resolve!: (snapshot: LibrarySelectionSnapshot) => void
  api.createTrackSelection = () => {
    calls.push('open')
    return new Promise((done) => {
      resolve = done
    })
  }
  const service = new LibrarySelectionService(api)
  const open = service.handle(owner, { kind: 'open', id: 'pending', request })
  const failed = assert.rejects(open, /取消/)
  await tick()
  owner.destroy()
  resolve(snapshot)
  await failed
  await tick()
  assert.deepEqual(calls, ['open', 'close:worker-id'])
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('explicit close during open is acknowledged only after cleanup and cannot replay creation', async () => {
  const { api, calls, owner } = fixture()
  let resolve!: (snapshot: LibrarySelectionSnapshot) => void
  api.createTrackSelection = () => {
    calls.push('open')
    return new Promise((done) => {
      resolve = done
    })
  }
  const service = new LibrarySelectionService(api),
    open = service.handle(owner, { kind: 'open', id: 'pending', request })
  const failed = assert.rejects(open, /取消/)
  await tick()
  const close = service.handle(owner, { kind: 'close', id: 'pending' })
  await assert.rejects(service.handle(owner, { kind: 'read', id: 'pending' }), /取消/)
  resolve(snapshot)
  await Promise.all([failed, close])
  assert.deepEqual(calls, ['open', 'close:worker-id'])
})

test('concurrent reads are bounded and a late read after close cannot publish stale rows', async () => {
  const { api, calls, owner } = fixture()
  let resolve!: (value: Awaited<ReturnType<LibrarySelectionApi['readTrackSelection']>>) => void
  api.readTrackSelection = () => {
    calls.push('read')
    return new Promise((done) => {
      resolve = done
    })
  }
  const service = new LibrarySelectionService(api)
  await service.handle(owner, { kind: 'open', id: 'active', request })
  const read = service.handle(owner, { kind: 'read', id: 'active' })
  const failed = assert.rejects(read, /取消/)
  await assert.rejects(service.handle(owner, { kind: 'read', id: 'active' }), /尚未完成/)
  await service.handle(owner, { kind: 'close', id: 'active' })
  resolve({ snapshot, rows: [], nextCursor: null })
  await failed
  assert.deepEqual(calls, ['open', 'read', 'close:worker-id'])
})

test('idle sender leases close automatically and failed creation is not retried', async () => {
  const { api, calls, owner } = fixture(),
    service = new LibrarySelectionService(api, 10)
  await service.handle(owner, { kind: 'open', id: 'idle', request })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await assert.rejects(service.handle(owner, { kind: 'read', id: 'idle' }), /失效/)
  assert.deepEqual(calls, ['open', 'close:worker-id'])
  api.createTrackSelection = async () => {
    calls.push('failed-open')
    throw new Error('unknown open outcome')
  }
  await assert.rejects(
    service.handle(owner, { kind: 'open', id: 'failed', request }),
    /unknown open outcome/
  )
  assert.equal(calls.filter((call) => call === 'failed-open').length, 1)
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('a lost cleanup reply can retry only idempotent cleanup, never the original creation', async () => {
  const { api, calls, owner } = fixture()
  let fails = true
  api.closeTrackSelection = async () => {
    calls.push('close')
    if (fails) throw new Error('lost close reply')
  }
  const service = new LibrarySelectionService(api)
  await service.handle(owner, { kind: 'open', id: 'first', request })
  await assert.rejects(service.handle(owner, { kind: 'close', id: 'first' }), /lost close reply/)
  fails = false
  await service.handle(owner, { kind: 'open', id: 'second', request })
  await service.handle(owner, { kind: 'close', id: 'second' })
  assert.deepEqual(calls, ['open', 'close', 'close', 'open', 'close'])
})

test('invalid sender requests and a fifth concurrent lease never reach database capabilities', async () => {
  const { api, calls, service, owner } = fixture()
  for (const input of [
    null,
    {},
    { kind: 'read', id: '' },
    { kind: 'read', id: 'x', cursor: -1 },
    { kind: 'read', id: 'x', projection: 'bad' },
    { kind: 'open', id: 'bad', request: { ...request, ranges: [[0, 3]] } }
  ])
    await assert.rejects(service.handle(owner, input))
  assert.deepEqual(calls, [])
  const owners = Array.from({ length: 4 }, () => new Owner())
  for (const [i, owner] of owners.entries())
    await service.handle(owner, { kind: 'open', id: `s${i}`, request })
  await assert.rejects(service.handle(owner, { kind: 'open', id: 'fifth', request }), /过多/)
  for (const [i, owner] of owners.entries())
    await service.handle(owner, { kind: 'close', id: `s${i}` })
  assert.equal(calls.filter((call) => call === 'open').length, 4)
  void api
})

test('runtime destruction fences pending opens, removes owner listeners and closes without replay', async () => {
  const { api, calls, owner } = fixture()
  let resolve!: (snapshot: LibrarySelectionSnapshot) => void
  api.createTrackSelection = () => {
    calls.push('open')
    return new Promise((done) => {
      resolve = done
    })
  }
  const service = new LibrarySelectionService(api)
  const open = service.handle(owner, { kind: 'open', id: 'shutdown', request })
  const failed = assert.rejects(open, /取消/)
  await tick()
  service.destroy()
  service.destroy()
  assert.equal(owner.listenerCount('destroyed'), 0)
  await assert.rejects(service.handle(owner, { kind: 'open', id: 'later', request }), /服务已关闭/)
  resolve(snapshot)
  await failed
  assert.deepEqual(calls, ['open', 'close:worker-id'])
})

test('shutdown while an open waits for old cleanup cannot recreate a lease afterward', async () => {
  const { api, calls, owner } = fixture()
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  api.closeTrackSelection = async () => {
    calls.push('close')
    await wait
  }
  const service = new LibrarySelectionService(api)
  await service.handle(owner, { kind: 'open', id: 'old', request })
  const close = service.handle(owner, { kind: 'close', id: 'old' })
  const open = service.handle(owner, { kind: 'open', id: 'new', request })
  const failed = assert.rejects(open, /已关闭/)
  service.destroy()
  release()
  await Promise.all([close, failed])
  assert.deepEqual(calls, ['open', 'close'])
  assert.equal(owner.listenerCount('destroyed'), 0)
})
