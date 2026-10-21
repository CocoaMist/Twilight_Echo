import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { LibraryQueueBuildService } from '../../../../main/library/libraryQueueBuildService.ts'
import { buildLibraryQueuePages } from './libraryQueueBuild.ts'
import type { LibraryQueueBuildCommand } from '../../../../shared/libraryQueueBuild.ts'

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      title: `T${index}`,
      filePath: `C:/Music/${index}.flac`
    }))
  })
  const service = new LibraryQueueBuildService({
    buildLibraryQueue: async (input) => db.buildLibraryQueue(input),
    deleteLibraryQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const calls: LibraryQueueBuildCommand[] = [],
    deleted: string[] = []
  const api = {
    buildQueue: async (input: LibraryQueueBuildCommand) => {
      calls.push(input)
      return service.handle(owner, input)
    },
    deleteQueue: async (id: string, revision: number) => {
      deleted.push(id)
      db.deleteLibraryQueue(id, revision)
    }
  }
  const start = { contentRevision: db.getMetadata().revision, order: 'original' as const }
  t.after(() => {
    service.destroy()
    db.close()
  })
  return { db, api, start, calls, deleted }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('sender bridge preserves the seed-only temporary-local snapshot without adding the file to the library', async (t) => {
  const f = fixture(t)
  const ready = await buildLibraryQueuePages(
    f.api,
    async (append) => {
      await append([
        {
          id: 'temporary',
          localSnapshot: {
            id: 'temporary',
            source: 'local',
            filePath: 'D:/Temporary/file.flac',
            cover: null,
            coverSource: null,
            streamUrl: 'twilight-media://temporary/secret',
            cueRange: { startSeconds: 0, endSeconds: 90 },
            cueEncoding: 'gb18030'
          }
        }
      ])
    },
    f.start
  )
  const row = f.db.readLibraryQueue(ready.id).items[0]
  assert.equal(row.track?.id, 'temporary')
  assert.equal(row.track?.cueEncoding, 'gb18030')
  assert.equal(row.track?.streamUrl, undefined)
  assert.equal(f.db.sql.prepare('SELECT 1 FROM tracks WHERE id=?').get('temporary'), undefined)
  assert.notEqual(ready.id, f.calls[0].id)
})

test('renderer seed streams 605 mixed duplicate occurrences through the sender bridge, preserving two orders and the selected occurrence', async (t) => {
  const f = fixture(t)
  const old = f.db.createLibraryQueue({ ids: ['0', '1', '0'], sort: 'playlist' })
  const original = Array.from({ length: 605 }, (_, index) =>
    index % 7
      ? { id: String(index % 5) }
      : {
          id: 'ncm:7',
          snapshot: {
            id: 'ncm:7',
            filePath: 'ncm:7',
            source: 'ncm',
            title: 'Remote',
            lyrics: 'omit',
            streamUrl: 'https://expired/'
          }
        }
  )
  const queue = await buildLibraryQueuePages(
    f.api,
    async (append) => {
      for (let offset = 0; offset < original.length; offset += 200) {
        await append(
          original.slice(offset, offset + 200).map((_, index) => {
            const originalPosition = (offset + index + 201) % original.length
            return { ...original[originalPosition], originalPosition }
          })
        )
        assert.deepEqual(
          f.db.getLibraryQueue(old.id),
          old,
          'staging does not change the old queue/cursor'
        )
      }
    },
    { ...f.start, order: 'shuffle', selectedIndex: 404 }
  )
  assert.equal(queue.total, 605)
  assert.equal(queue.index, 404)
  assert.equal(queue.order, 'shuffle')
  const page = f.db.readLibraryQueue(queue.id, 400)
  assert.equal(page.items[4].track?.id, original[0].id)
  const selected = queue.selectedEntryId
  const restored = f.db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'order',
    order: 'original'
  }).queue
  assert.equal(restored.index, 0)
  assert.equal(restored.selectedEntryId, selected)
  assert.equal(page.items[4].track?.lyrics, null)
  assert.equal(page.items[4].track?.streamUrl, undefined)
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['begin', 'append', 'append', 'append', 'append', 'commit']
  )
  assert.ok(f.calls.every((call) => call.kind !== 'append' || call.items.length <= 200))
})

test('empty seeds have no phantom selection and new suffixes need no original-position array', async (t) => {
  const f = fixture(t)
  const empty = await buildLibraryQueuePages(f.api, async () => {}, f.start)
  assert.equal(empty.total, 0)
  assert.equal(empty.index, -1)
  assert.equal(empty.selectedEntryId, null)
  const queue = await buildLibraryQueuePages(
    f.api,
    async (append) => {
      await append([{ id: '1' }, { id: '1' }])
    },
    f.start
  )
  assert.equal(queue.index, 0)
  assert.equal(
    new Set(f.db.readLibraryQueue(queue.id).items.map((row) => row.queueEntryId)).size,
    2
  )
})

test('retained producer callbacks cannot write after publication or resurrect a failed seed', async (t) => {
  const f = fixture(t)
  let retained!: (items: readonly { id: string }[]) => Promise<void>
  const queue = await buildLibraryQueuePages(
    f.api,
    async (append) => {
      retained = append
      await append([{ id: '0' }])
    },
    f.start
  )
  const count = f.calls.length
  await assert.rejects(retained([{ id: '1' }]), /已关闭/)
  assert.equal(f.calls.length, count)
  assert.deepEqual(f.db.getLibraryQueue(queue.id), queue)
})

test('swallowed validation and unknown append failures poison the seed, never publishing or replaying', async (t) => {
  for (const fail of ['validation', 'unknown']) {
    const f = fixture(t),
      original = f.api.buildQueue
    f.api.buildQueue = async (command) => {
      const reply = await original(command)
      if (command.kind === 'append' && fail === 'unknown') throw new Error('unknown page reply')
      return reply
    }
    await assert.rejects(
      buildLibraryQueuePages(
        f.api,
        async (append) => {
          await append(
            Array.from({ length: fail === 'validation' ? 201 : 1 }, () => ({ id: '0' }))
          ).catch(() => {})
          await append([{ id: '1' }]).catch(() => {})
        },
        f.start
      ),
      /最多|unknown/
    )
    assert.equal(
      f.calls.filter((call) => call.kind === 'append').length,
      fail === 'validation' ? 0 : 1
    )
    assert.equal(
      f.calls.some((call) => call.kind === 'commit'),
      false
    )
    assert.equal(f.calls.at(-1)?.kind, 'abort')
  }
})

test('overlapping appends abort the whole hidden seed even when the producer swallows both errors', async (t) => {
  const f = fixture(t),
    original = f.api.buildQueue
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.buildQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'append') await held
    return reply
  }
  const building = buildLibraryQueuePages(
    f.api,
    async (append) => {
      const first = append([{ id: '0' }]).catch(() => {})
      await append([{ id: '1' }]).catch(() => {})
      release()
      await first
    },
    f.start
  )
  await assert.rejects(building, /上一批/)
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['begin', 'append', 'abort']
  )
})

test('an unawaited issued page is joined before aborting, so it cannot overtake cleanup', async (t) => {
  const f = fixture(t),
    original = f.api.buildQueue
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.buildQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'append') await held
    return reply
  }
  const failed = assert.rejects(
    buildLibraryQueuePages(
      f.api,
      async (append) => {
        void append([{ id: '0' }])
      },
      f.start
    ),
    /每批/
  )
  await tick()
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['begin', 'append']
  )
  release()
  await failed
  assert.equal(f.calls.at(-1)?.kind, 'abort')
})

test('mutating the producer page during an outstanding write cannot change the copied records or acknowledged count', async (t) => {
  const f = fixture(t),
    original = f.api.buildQueue
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.buildQueue = async (command) => {
    if (command.kind === 'append') await held
    return original(command)
  }
  const batch = [{ id: '0' }]
  const building = buildLibraryQueuePages(
    f.api,
    async (append) => {
      const write = append(batch)
      batch[0].id = 'missing'
      batch.length = 0
      release()
      await write
    },
    f.start
  )
  const queue = await building
  assert.equal(queue.total, 1)
  assert.equal(f.db.readLibraryQueue(queue.id).items[0].track?.id, '0')
})

test('cancellation before begin performs no IPC, and cancellation after a page prevents commit', async (t) => {
  const f = fixture(t),
    abort = new AbortController()
  abort.abort()
  await assert.rejects(
    buildLibraryQueuePages(f.api, async () => {}, f.start, { signal: abort.signal }),
    /取消/
  )
  assert.equal(f.calls.length, 0)
  const during = new AbortController()
  await assert.rejects(
    buildLibraryQueuePages(
      f.api,
      async (append) => {
        await append([{ id: '0' }])
        during.abort()
      },
      f.start,
      { signal: during.signal }
    ),
    /取消/
  )
  assert.equal(
    f.calls.some((call) => call.kind === 'commit'),
    false
  )
  assert.equal(f.calls.at(-1)?.kind, 'abort')
})

test('final guard failure after a successful publication discards only the unadopted ready result', async (t) => {
  const f = fixture(t),
    original = f.api.buildQueue
  const previous = f.db.createLibraryQueue({ ids: ['1'] })
  let valid = true
  f.api.buildQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'commit') valid = false
    return reply
  }
  await assert.rejects(
    buildLibraryQueuePages(
      f.api,
      async (append) => {
        await append([{ id: '0' }])
      },
      f.start,
      {
        guard: () => {
          if (!valid) throw new Error('source changed')
        }
      }
    ),
    /source changed/
  )
  assert.equal(f.deleted.length, 1)
  assert.throws(() => f.db.getLibraryQueue(f.deleted[0]), /does not exist/)
  assert.deepEqual(f.db.getLibraryQueue(previous.id), previous)
})

test('unknown commit results do not retry publication or change the previous live queue', async (t) => {
  const f = fixture(t),
    original = f.api.buildQueue
  const previous = f.db.createLibraryQueue({ ids: ['1'] })
  f.api.buildQueue = async (command) => {
    const reply = await original(command)
    if (command.kind === 'commit') throw new Error('unknown publication')
    return reply
  }
  await assert.rejects(
    buildLibraryQueuePages(
      f.api,
      async (append) => {
        await append([{ id: '0' }])
      },
      f.start
    ),
    /unknown publication/
  )
  assert.equal(f.calls.filter((call) => call.kind === 'commit').length, 1)
  assert.deepEqual(f.db.getLibraryQueue(previous.id), previous)
  assert.deepEqual(f.deleted, [])
})
