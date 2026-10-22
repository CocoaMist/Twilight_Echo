import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { LibraryQueueBuildService } from './libraryQueueBuildService.ts'
import { LibraryDatabase } from './libraryDatabase.ts'
import type {
  LibraryQueueBuildCommand,
  LibraryQueueBuildReply
} from '../../shared/libraryQueueBuild.ts'

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
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(t: test.TestContext, idleMs?: number) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', title: 'One', artist: 'A', filePath: 'C:/Music/one.flac' }]
  })
  const calls: LibraryQueueBuildCommand[] = []
  const api = {
    buildLibraryQueue: async (
      command: LibraryQueueBuildCommand
    ): Promise<LibraryQueueBuildReply> => {
      calls.push(command)
      return db.buildLibraryQueue(command)
    },
    deleteLibraryQueue: async (id: string, revision: number) => db.deleteLibraryQueue(id, revision)
  }
  const service = new LibraryQueueBuildService(api, idleMs)
  t.after(() => {
    service.destroy()
    db.close()
  })
  const owner = new Owner()
  const begin = (id = 'seed', sender = owner) =>
    service.handle(sender, {
      kind: 'begin',
      id,
      contentRevision: db.getMetadata().revision,
      order: 'original'
    })
  return { db, api, service, owner, calls, begin }
}

test('queue seeds hide worker identities and bind continuations to the sender, not the client ID', async (t) => {
  const { service, db, owner, calls, begin } = fixture(t),
    other = new Owner()
  assert.deepEqual(await begin(), { kind: 'building', id: 'seed', sequence: 0, total: 0 })
  assert.notEqual(calls[0].id, 'seed')
  assert.throws(() => db.getLibraryQueue(calls[0].id), /does not exist/)
  await assert.rejects(
    service.handle(other, { kind: 'append', id: 'seed', sequence: 1, items: [] }),
    /不属于/
  )
  await begin('seed', other)
  assert.notEqual(calls[0].id, calls[1].id)
  await assert.rejects(begin('duplicate'), /请先/)
  await service.handle(owner, {
    kind: 'append',
    id: 'seed',
    sequence: 1,
    items: [{ id: 'one' }, { id: 'one' }]
  })
  const ready = await service.handle(owner, {
    kind: 'commit',
    id: 'seed',
    sequence: 2,
    selectedIndex: 1
  })
  assert.equal(ready.kind, 'ready')
  if (ready.kind !== 'ready') throw new Error('missing queue')
  assert.equal(ready.id, 'seed')
  assert.equal(ready.queue.id, calls[0].id)
  assert.equal(ready.queue.index, 1)
  assert.equal(
    new Set(db.readLibraryQueue(ready.queue.id).items.map((row) => row.queueEntryId)).size,
    2
  )
  assert.equal(owner.listenerCount('destroyed'), 0)
  await service.handle(owner, { kind: 'abort', id: 'seed' })
  assert.deepEqual(
    db.getLibraryQueue(ready.queue.id),
    ready.queue,
    'post-transfer abort cannot delete ready queue'
  )
  await service.handle(other, { kind: 'abort', id: 'seed' })
})

test('invalid/oversized and replayed continuations retire only their own seed before reaching worker', async (t) => {
  const { service, owner, calls, begin, db } = fixture(t)
  for (const continuation of [
    { kind: 'append', id: 'seed', sequence: 1, items: Array(201).fill({ id: 'one' }) },
    { kind: 'append', id: 'seed', sequence: 1, items: [{ id: 'one', originalPosition: -1 }] },
    {
      kind: 'append',
      id: 'seed',
      sequence: 1,
      items: [{ id: 'one', snapshot: { id: 'one', source: 'playlist-import', filePath: 'one' } }]
    },
    { kind: 'append', id: 'seed', sequence: 2, items: [] },
    { kind: 'commit', id: 'seed', sequence: 1, selectedIndex: 0 }
  ]) {
    db.maintainQueryState()
    await begin()
    const before = calls.length
    await assert.rejects(service.handle(owner, continuation), /Invalid|oversized|批次/)
    assert.deepEqual(
      calls.slice(before).map((call) => call.kind),
      ['abort']
    )
    await assert.rejects(
      service.handle(owner, { kind: 'commit', id: 'seed', sequence: 1, selectedIndex: -1 }),
      /不属于/
    )
  }
  await begin()
  await assert.rejects(
    service.handle(owner, {
      kind: 'append',
      id: 'another',
      sequence: 1,
      items: Array(201).fill({ id: 'one' })
    })
  )
  await service.handle(owner, { kind: 'append', id: 'seed', sequence: 1, items: [{ id: 'one' }] })
  await assert.rejects(
    service.handle(owner, { kind: 'append', id: 'seed', sequence: 1, items: [{ id: 'one' }] }),
    /不要重放/
  )
})

test('abort joins a pending begin and fences its late success without exposing a queue', async (t) => {
  const f = fixture(t),
    original = f.api.buildLibraryQueue
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.buildLibraryQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'begin') await held
    return reply
  }
  const opening = f.begin(),
    failed = assert.rejects(opening, /取消/)
  await tick()
  let closed = false
  const abort = f.service.handle(f.owner, { kind: 'abort', id: 'seed' }).then(() => {
    closed = true
  })
  await tick()
  assert.equal(closed, false)
  release()
  await Promise.all([failed, abort])
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['begin', 'abort']
  )
  assert.equal(f.owner.listenerCount('destroyed'), 0)
})

test('overlap poisons a build and waits for the issued page before cleanup', async (t) => {
  const f = fixture(t),
    original = f.api.buildLibraryQueue
  await f.begin()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.buildLibraryQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'append') await held
    return reply
  }
  const page = f.service.handle(f.owner, {
    kind: 'append',
    id: 'seed',
    sequence: 1,
    items: [{ id: 'one' }]
  })
  const failed = assert.rejects(page, /取消/)
  await tick()
  const overlap = assert.rejects(
    f.service.handle(f.owner, { kind: 'commit', id: 'seed', sequence: 2, selectedIndex: 0 }),
    /批次完成/
  )
  await tick()
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['begin', 'append']
  )
  release()
  await Promise.all([failed, overlap])
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['begin', 'append', 'abort']
  )
})

test('window destruction during commit deletes only the known untransferred result', async (t) => {
  const f = fixture(t),
    original = f.api.buildLibraryQueue
  const previous = f.db.createLibraryQueue({ ids: ['one'] })
  await f.begin()
  await f.service.handle(f.owner, {
    kind: 'append',
    id: 'seed',
    sequence: 1,
    items: [{ id: 'one' }]
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.buildLibraryQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'commit') await held
    return reply
  }
  const committing = f.service.handle(f.owner, {
    kind: 'commit',
    id: 'seed',
    sequence: 2,
    selectedIndex: 0
  })
  const failed = assert.rejects(committing, /取消/)
  await tick()
  f.owner.destroy()
  release()
  await failed
  assert.throws(() => f.db.getLibraryQueue(f.calls[0].id), /does not exist/)
  assert.deepEqual(f.db.getLibraryQueue(previous.id), previous)
  assert.equal(f.owner.listenerCount('destroyed'), 0)
})

test('unknown commit replies are never replayed and the prior live queue remains unchanged', async (t) => {
  const f = fixture(t),
    original = f.api.buildLibraryQueue
  const previous = f.db.createLibraryQueue({ ids: ['one'] })
  await f.begin()
  await f.service.handle(f.owner, {
    kind: 'append',
    id: 'seed',
    sequence: 1,
    items: [{ id: 'one' }]
  })
  f.api.buildLibraryQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'commit') throw new Error('unknown commit reply')
    return reply
  }
  await assert.rejects(
    f.service.handle(f.owner, { kind: 'commit', id: 'seed', sequence: 2, selectedIndex: 0 }),
    /unknown/
  )
  await assert.rejects(
    f.service.handle(f.owner, { kind: 'commit', id: 'seed', sequence: 2, selectedIndex: 0 }),
    /不属于/
  )
  assert.equal(f.calls.filter((call) => call.kind === 'commit').length, 1)
  assert.deepEqual(f.db.getLibraryQueue(previous.id), previous)
  assert.equal(
    f.db.getLibraryQueue(f.calls[0].id).total,
    1,
    'unreferenced ready result is left for existing GC'
  )
})

test('idle expiry and runtime shutdown release listeners, retire seeds and reject late calls', async (t) => {
  const f = fixture(t, 10)
  await f.begin()
  await new Promise<void>((resolve) => setTimeout(resolve, 35))
  await tick()
  assert.equal(f.owner.listenerCount('destroyed'), 0)
  await assert.rejects(
    f.service.handle(f.owner, { kind: 'append', id: 'seed', sequence: 1, items: [] }),
    /不属于/
  )
  await f.begin()
  f.service.destroy()
  await tick()
  assert.equal(f.owner.listenerCount('destroyed'), 0)
  await assert.rejects(f.begin(), /关闭/)
})

test('cleanup failure retains its slot and can be retried without replaying any page', async (t) => {
  const f = fixture(t),
    original = f.api.buildLibraryQueue
  await f.begin()
  let fail = true
  f.api.buildLibraryQueue = async (command) => {
    if (command.kind === 'abort' && fail) throw new Error('cleanup unavailable')
    return original(command)
  }
  await assert.rejects(f.service.handle(f.owner, { kind: 'abort', id: 'seed' }), /unavailable/)
  await assert.rejects(f.begin('replacement'), /unavailable/)
  fail = false
  await f.service.handle(f.owner, { kind: 'abort', id: 'seed' })
  await f.begin('replacement')
})

test('four window leases bound construction; a client cannot choose an existing persistent queue ID', async (t) => {
  const f = fixture(t)
  const previous = f.db.createLibraryQueue({ ids: ['one'] })
  const owners = Array.from({ length: 5 }, () => new Owner())
  for (const owner of owners.slice(0, 4)) await f.begin(previous.id, owner)
  assert.equal(new Set(f.calls.map((call) => call.id)).size, 4)
  await assert.rejects(f.begin('fifth', owners[4]), /构建过多/)
  for (const owner of owners.slice(0, 4))
    await f.service.handle(owner, { kind: 'abort', id: previous.id })
  assert.deepEqual(f.db.getLibraryQueue(previous.id), previous)
  f.db.maintainQueryState()
  await f.begin('fifth', owners[4])
  await f.service.handle(owners[4], { kind: 'abort', id: 'fifth' })
})

test('an invalid ready reply cannot cause cleanup to delete an unrelated persistent queue', async (t) => {
  const f = fixture(t),
    original = f.api.buildLibraryQueue
  const previous = f.db.createLibraryQueue({ ids: ['one'] })
  await f.begin()
  f.api.buildLibraryQueue = async (command) => {
    if (command.kind === 'commit') return { kind: 'ready', id: command.id, queue: previous }
    return original(command)
  }
  await assert.rejects(
    f.service.handle(f.owner, {
      kind: 'commit',
      id: 'seed',
      sequence: 1,
      selectedIndex: -1
    }),
    /返回无效/
  )
  assert.deepEqual(f.db.getLibraryQueue(previous.id), previous)
  assert.equal(f.calls.at(-1)?.kind, 'abort')
})
