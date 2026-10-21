import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from '../../../../main/library/libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from '../../../../main/library/libraryDatabaseProtocol.ts'
import {
  PlaybackSessionStorage,
  isPlaybackQueueSnapshot
} from '../../../../main/persistence/playbackSessionStorage.ts'
import { VersionedDataStore } from '../../../../main/persistence/versionedDataStore.ts'
import { isPlaybackSession } from '../../../../shared/playbackSession.ts'
import type { PlaybackSession } from '../../../../main/core/types.ts'
import { libraryQueueTrack } from '../../utils/libraryQueuePlayback.ts'
import { LibrarySelectionService } from '../../../../main/library/librarySelectionService.ts'
import { openLibrarySelectionLease } from '../library/librarySelectionLease.ts'
import type { LibraryQueueApi } from './libraryQueueSource.ts'
import type { LibraryQueueInsertItem } from '../../../../shared/libraryDatabase.ts'
import { createLibraryPlaybackController } from './libraryPlaybackController.ts'

function fixture(t: test.TestContext, count = 605) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    exclusions: [],
    folders: [],
    tracks: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      title: `Track ${index}`,
      filePath: `D:/Music/${index}.flac`,
      duration: 180,
      ...(index === 199 || index === 200
        ? {
            cueRange: { startSeconds: index === 199 ? 0 : 90, endSeconds: index === 199 ? 90 : 180 }
          }
        : {})
    }))
  })
  const reads: number[] = []
  const api: LibraryQueueApi = {
    buildQueue: async (command) => db.buildLibraryQueue(command),
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => {
      reads.push(args[1] ?? 0)
      return db.readLibraryQueue(...args)
    },
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  }
  const player = createLibraryPlaybackController(api)
  t.after(() => {
    player.dispose()
    db.close()
  })
  return { db, api, player, reads }
}

test('staging retains an inactive source and exposes only a bounded window at synchronous adoption', async (t) => {
  const { db, player } = fixture(t)
  const old = db.createLibraryQueue({ ids: ['0', '1'], sort: 'playlist' })
  let adopted = false
  const result = await player.stagePages(
    async (append) => {
      for (let offset = 0; offset < 605; offset += 200)
        await append(
          Array.from({ length: Math.min(200, 605 - offset) }, (_, index) => ({
            id: String((offset + index) % 605)
          }))
        )
    },
    { contentRevision: db.getMetadata().revision, order: 'original', selectedIndex: 199 },
    'sequential',
    async (window, activate) => {
      assert.equal(player.active.value, false)
      assert.equal(player.snapshot.value, null)
      assert.equal(player.reference(), null)
      assert.deepEqual(
        window.items.map((row) => row.position),
        [199, 200]
      )
      assert.deepEqual(db.getLibraryQueue(old.id), old)
      activate()
      adopted = true
    }
  )
  assert.equal(adopted, true)
  assert.equal(player.active.value, true)
  assert.equal(player.reference()?.index, 199)
  assert.equal(result?.queue.total, 605)
  assert.ok(player.diagnostics.cachedTracks <= 400)
})

test('the existing command lane stays owned through staging and asynchronous player handoff', async (t) => {
  const { db, player } = fixture(t)
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const staging = player.stagePages(
    async (append) => {
      await append([{ id: '0' }, { id: '1' }])
    },
    { contentRevision: db.getMetadata().revision, order: 'original' },
    'sequential',
    async (_window, activate) => {
      entered()
      await held
      activate()
    }
  )
  await entering
  let navigated = false
  const next = player.navigate(1, true, 'sequential').then((result) => {
    navigated = true
    return result
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(player.busy.value, true)
  assert.equal(navigated, false)
  release()
  await staging
  assert.equal((await next)?.window?.queue.index, 1)
})

test('detach during staging fences a late page without activating or replacing a later source', async (t) => {
  const { db, player, api } = fixture(t)
  const build = api.buildQueue!
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  api.buildQueue = async (command) => {
    const reply = await build(command)
    if (command.kind === 'append') {
      entered()
      await held
    }
    return reply
  }
  const staging = player.stagePages(
    async (append) => {
      await append([{ id: '0' }])
    },
    { contentRevision: db.getMetadata().revision, order: 'original' },
    'sequential',
    async () => {
      assert.fail('stale adoption')
    }
  )
  const failed = assert.rejects(staging, /来源已变化/)
  await entering
  player.detach()
  const replacement = player.create({ ids: ['1'], sort: 'playlist' }, '1', 'sequential')
  release()
  await failed
  await replacement
  assert.equal(player.track()?.id, '1')
  assert.equal(player.active.value, true)
})

test('failed/cancelled player handoff releases the staged result, with retained activation fenced', async (t) => {
  const { db, player } = fixture(t)
  let retained!: () => void,
    id = ''
  const abort = new AbortController()
  await assert.rejects(
    player.stagePages(
      async (append) => {
        await append([{ id: '0' }])
      },
      { contentRevision: db.getMetadata().revision, order: 'original' },
      'sequential',
      async (result, activate) => {
        id = result.queue.id
        retained = activate
        abort.abort()
        activate()
      },
      { signal: abort.signal }
    ),
    /取消/
  )
  assert.equal(player.active.value, false)
  assert.equal(player.reference(), null)
  assert.throws(() => db.getLibraryQueue(id), /does not exist/)
  assert.throws(retained, /来源已变化/)
})

test('empty streams do not activate a phantom source and a missing selected occurrence is not skipped', async (t) => {
  const { db, player, api } = fixture(t)
  const start = { contentRevision: db.getMetadata().revision, order: 'original' as const }
  let adopted = false
  assert.equal(
    await player.stagePages(
      async () => {},
      start,
      'sequential',
      async () => {
        adopted = true
      }
    ),
    null
  )
  assert.equal(adopted, false)
  assert.equal(player.active.value, false)
  const get = api.getQueue
  api.getQueue = async (id) => {
    const result = await get(id)
    db.replaceDocument({ version: 2, revision: 0, tracks: [], folders: [], exclusions: [] })
    return result
  }
  await assert.rejects(
    player.stagePages(
      async (append) => {
        await append([{ id: '0' }, { id: '1' }])
      },
      start,
      'sequential',
      async () => {
        adopted = true
      }
    ),
    /原选中歌曲/
  )
  assert.equal(adopted, false)
  assert.equal(player.active.value, false)
})

test('a library notification during player handoff rejects final activation without adopting newer details', async (t) => {
  const { db, player } = fixture(t)
  await assert.rejects(
    player.stagePages(
      async (append) => {
        await append([{ id: '0' }])
      },
      { contentRevision: db.getMetadata().revision, order: 'original' },
      'sequential',
      async (_result, activate) => {
        const changed = db.patchTracks([
          { id: '0', expectedVersion: 1, patch: { title: 'Changed' } }
        ])
        player.invalidateLibrary(changed.revision)
        activate()
      }
    ),
    /曲库已变化/
  )
  assert.equal(player.active.value, false)
  assert.equal(player.reference(), null)
})

test('query playback reads only current+next details across CUE page boundaries', async (t) => {
  const { player, reads } = fixture(t)
  const result = await player.create({ sort: 'playlist' }, '199', 'sequential')
  assert.deepEqual(
    result?.items.map((entry) => entry.position),
    [199, 200]
  )
  assert.deepEqual(reads, [0, 200])
  assert.equal(player.track()?.cueRange?.endSeconds, 90)
  assert.equal(player.reference()?.index, 199)
  assert.equal(player.diagnostics.cachedTracks, 400)
  assert.equal((await player.playbackWindow(player.track()!, 'repeat'))?.items.length, 1)
})

test('shuffle-all can start beyond the first page without exporting the complete detail queue', async (t) => {
  const { player, reads } = fixture(t)
  const random = Math.random
  Math.random = () => 0.9
  try {
    await player.create({ sort: 'playlist' }, undefined, 'shuffle', true)
    assert.equal(player.track()?.id, String(Math.floor(605 * 0.9)))
    assert.equal(player.snapshot.value?.index, 0, 'shuffle pins the randomly chosen occurrence')
    assert.equal(player.snapshot.value?.total, 605)
    assert.ok(reads.includes(400), 'the random selection must not be limited to the visible page')
    assert.ok(player.diagnostics.cachedTracks <= 2000)
  } finally {
    Math.random = random
  }
})

test('streaming queue pages visits the complete order without materializing a renderer queue', async (t) => {
  const { player, reads } = fixture(t, 605)
  await player.create({ sort: 'playlist' }, '0', 'sequential')
  const pages: number[] = []
  const ids: string[] = []
  const result = await player.forEachPage((page) => {
    pages.push(page.offset)
    ids.push(...page.items.filter((item) => item.track).map((item) => item.track!.id))
    assert.ok(page.items.length <= 200)
    assert.ok(player.diagnostics.cachedTracks <= 2_000)
  })
  assert.equal(result?.queue.total, 605)
  assert.equal(result?.visited, 4)
  assert.equal(result?.tracks, 605)
  assert.deepEqual(pages, [0, 200, 400, 600])
  assert.deepEqual(ids.slice(0, 2), ['0', '1'])
  assert.deepEqual(ids.slice(-2), ['603', '604'])
  assert.ok(reads.includes(600))
})

test('streaming queue pages is fenced when the database source detaches', async (t) => {
  const { player, api } = fixture(t, 405)
  await player.create({ sort: 'playlist' }, '0', 'sequential')
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = api.readQueue
  let blockedOnce = false
  api.readQueue = async (...args) => {
    if (!blockedOnce && args[1] === 200) {
      blockedOnce = true
      await blocked
    }
    return read(...args)
  }
  const visited: number[] = []
  const pending = player.forEachPage((page) => {
    visited.push(page.offset)
  })
  await new Promise((resolve) => setImmediate(resolve))
  player.detach()
  release()
  assert.equal(await pending, null)
  assert.deepEqual(visited, [0])
})

test('rapid navigation serializes durable cursor changes and manual wrap differs from EOF', async (t) => {
  const { player, db } = fixture(t, 5)
  await player.create({ sort: 'playlist' }, '2', 'sequential')
  const results = await Promise.all([
    player.navigate(1, true, 'sequential'),
    player.navigate(1, true, 'sequential'),
    player.navigate(1, true, 'sequential')
  ])
  assert.deepEqual(
    results.map((result) => result?.window?.queue.index),
    [3, 4, 0]
  )
  assert.equal(db.getLibraryQueue(player.reference()!.id).index, 0)
  await player.select(4, 'sequential')
  assert.equal((await player.navigate(1, false, 'sequential'))?.reachedEnd, true)
  assert.equal(player.reference()?.index, 4)
  assert.equal((await player.navigate(1, true, 'listLoop'))?.window?.queue.index, 0)
  assert.equal(player.busy.value, false)
})

test('native handoff commits occurrence identity, rejects stale events and preserves following window', async (t) => {
  const { player, db } = fixture(t)
  const result = (await player.create({ sort: 'playlist' }, '199', 'sequential'))!
  const previous = player.reference()!
  const incoming = result.items[1].queueEntryId
  await player.acceptNative(incoming, previous, 'sequential')
  assert.equal(player.track()?.id, '200')
  assert.equal(player.reference()?.entryId, incoming)
  assert.equal(db.getLibraryQueue(previous.id).selectedEntryId, incoming)
  assert.deepEqual(
    player.window.value?.items.map((item) => item.position),
    [200, 201]
  )
  assert.equal(
    await player.acceptNative(result.items[0].queueEntryId, previous, 'sequential'),
    null
  )
  assert.equal(player.reference()?.entryId, incoming)
})

test('restart restores committed cursor rather than rewinding an older session, with missing-track SQL skip', async (t) => {
  const { player, db } = fixture(t)
  await player.create({ sort: 'playlist' }, '199', 'sequential')
  const saved = player.reference()!
  await player.navigate(1, true, 'sequential')
  player.detach()
  await player.restore(saved, 'sequential', () => true)
  assert.equal(player.track()?.id, '200')
  db.sql.exec("DELETE FROM tracks WHERE id IN ('200','201','202')")
  player.detach()
  await player.restore(saved, 'sequential', () => true)
  assert.equal(player.track()?.id, '203')
})

test('legacy resume follows the committed order without reordering, while explicit named restore applies its saved mode', async (t) => {
  const { player, db, api } = fixture(t, 3)
  let queue = db.createLibraryQueue({ ids: ['0', '1', '0'], sort: 'playlist' })
  const initial = db.readLibraryQueue(queue.id).items
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: initial[2].queueEntryId
  }).queue
  const reference = {
    id: queue.id,
    revision: queue.revision,
    index: queue.index,
    entryId: queue.selectedEntryId!
  }
  queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' }).queue
  const edit = api.editQueue
  let edits = 0
  api.editQueue = async (...args) => {
    edits++
    return edit(...args)
  }
  const shuffle = await player.restore(reference, 'sequential', () => true)
  assert.deepEqual(shuffle?.queue, queue)
  assert.equal(shuffle?.items[0].queueEntryId, reference.entryId)
  assert.equal(edits, 0)
  queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'original' }).queue
  const original = await player.restore(reference, 'shuffle', () => true)
  assert.deepEqual(original?.queue, queue)
  assert.equal(edits, 0)
  const named = await player.restore(reference, 'repeat', () => true, true)
  assert.equal(named?.queue.playMode, 'repeat')
  assert.equal(named?.queue.order, 'original')
  assert.equal(named?.items.length, 1)
  assert.equal(edits, 1)
  await assert.rejects(
    player.adoptLive(player.reference()!, 'shuffle', () => true),
    /已变化/
  )
})

test(
  'killed SQL worker plus stale disk sessions resume all committed logical modes and exact duplicate CUE occurrences without order edits',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'library-mode-restart-'))
    const json = join(root, 'music-library.json')
    const database = new LibraryDatabase(join(root, 'music-library.sqlite'))
    database.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: [
        {
          id: 'cue',
          title: 'Cue',
          filePath: join(root, 'disc.flac'),
          duration: 90,
          cueRange: { startSeconds: 90, endSeconds: 180, pregapSeconds: 0, virtualPregapSeconds: 1 }
        }
      ]
    })
    database.close()
    const children: ChildProcess[] = []
    const clients: LibraryDatabaseServiceClient[] = []
    const makeClient = () => {
      const client = new LibraryDatabaseServiceClient({
        serviceEntry: fileURLToPath(
          new URL('../../../../main/library/libraryDatabaseService.ts', import.meta.url)
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
      clients.push(client)
      return client
    }
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exit = once(child, 'exit')
          child.kill()
          await exit
        }
      for (const client of clients) client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    const storage = (mode: string) =>
      new PlaybackSessionStorage(
        new VersionedDataStore<PlaybackSession | null>({
          filePath: join(root, `${mode}-session.json`),
          label: 'session',
          maxBytes: 2 * 1024 * 1024,
          isData: (value): value is PlaybackSession | null =>
            value === null || isPlaybackSession(value),
          isLegacy: isPlaybackSession
        }),
        new VersionedDataStore<unknown[]>({
          filePath: join(root, `${mode}-queue.json`),
          label: 'queue',
          maxBytes: 32 * 1024 * 1024,
          isData: isPlaybackQueueSnapshot,
          isLegacy: isPlaybackQueueSnapshot
        })
      )
    const first = makeClient()
    const cases = [] as Array<{
      mode: 'shuffle' | 'repeat' | 'listLoop' | 'sequential'
      queue: Awaited<ReturnType<LibraryQueueApi['getQueue']>>
      tail: Awaited<ReturnType<LibraryQueueApi['readQueue']>>
    }>
    for (const [mode, oldMode] of [
      ['shuffle', 'repeat'],
      ['repeat', 'shuffle'],
      ['listLoop', 'sequential'],
      ['sequential', 'listLoop']
    ] as const) {
      let queue = await first.createLibraryQueue({ ids: Array(605).fill('cue'), sort: 'playlist' })
      const selected = (await first.readLibraryQueue(queue.id, 399, 1)).items[0]
      queue = (
        await first.editLibraryQueue(queue.id, queue.revision, {
          kind: 'select',
          entryId: selected.queueEntryId
        })
      ).queue
      queue = (
        await first.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode: oldMode })
      ).queue
      await storage(mode).save(
        {
          version: 1,
          savedAt: new Date().toISOString(),
          mode: 'trackAndPosition',
          playMode: oldMode,
          track: libraryQueueTrack(selected.track!, selected.queueEntryId),
          position: 12,
          libraryQueue: {
            id: queue.id,
            revision: queue.revision,
            entryId: selected.queueEntryId,
            index: queue.index
          }
        },
        0
      )
      // SQL commits but the session is intentionally never updated before kill.
      queue = (await first.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode })).queue
      cases.push({ mode, queue, tail: await first.readLibraryQueue(queue.id, 595, 10) })
    }
    const exited = once(children[0], 'exit')
    children[0].kill()
    await exited
    const restarted = makeClient()
    let edits = 0
    const reads: number[] = []
    const player = createLibraryPlaybackController({
      createQueue: (...args) => restarted.createLibraryQueue(...args),
      getQueue: (...args) => restarted.getLibraryQueue(...args),
      readQueue: (...args) => {
        reads.push(args[2] ?? 200)
        return restarted.readLibraryQueue(...args)
      },
      editQueue: (...args) => {
        edits++
        return restarted.editLibraryQueue(...args)
      },
      deleteQueue: (...args) => restarted.deleteLibraryQueue(...args)
    })
    try {
      for (const { mode, queue, tail } of cases) {
        const saved = await storage(mode).load()
        assert.ok(saved?.data?.libraryQueue)
        assert.notEqual(saved.data.playMode, mode)
        const result = await player.restore(
          saved.data.libraryQueue,
          saved.data.playMode!,
          () => true
        )
        assert.deepEqual(result?.queue, queue)
        assert.equal(result?.queue.playMode, mode)
        assert.equal(result?.items[0].queueEntryId, saved.data.libraryQueue.entryId)
        assert.deepEqual(result?.items[0].track?.cueRange, {
          startSeconds: 90,
          endSeconds: 180,
          pregapSeconds: 0,
          virtualPregapSeconds: 1
        })
        assert.equal(result?.items.length, mode === 'repeat' ? 1 : 2)
        assert.deepEqual(await restarted.readLibraryQueue(queue.id, 595, 10), tail)
        assert.equal(edits, 0, 'crash resume must not edit/replay an acknowledged SQL mode/order')
        await storage(mode).save(
          {
            ...saved.data,
            track: player.track()!,
            libraryQueue: player.reference()!,
            playMode: result!.queue.playMode
          },
          saved.revision
        )
        assert.equal((await storage(mode).load())?.data?.playMode, mode)
        assert.equal(existsSync(join(root, `${mode}-queue.json`)), false)
      }
      assert.ok(reads.every((size) => size <= 200))
      assert.ok(player.diagnostics.cachedTracks <= 400)
    } finally {
      player.dispose()
    }
  }
)

test('cancelled restore cannot attach late details after the user chooses another source', async (t) => {
  const { player, api } = fixture(t, 5)
  await player.create({}, '0', 'sequential')
  const saved = player.reference()!
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = api.readQueue
  api.readQueue = async (...args) => {
    await blocked
    return read(...args)
  }
  let current = true
  const restore = player.restore(saved, 'sequential', () => current)
  await new Promise((resolve) => setImmediate(resolve))
  current = false
  release()
  assert.equal(await restore, null)
  assert.equal(player.active.value, false)
  assert.equal(player.reference(), null)
})

test('array switch fences an in-flight database command and retains the saved queue', async (t) => {
  const { player, api, db } = fixture(t, 5)
  await player.create({}, '0', 'sequential')
  const saved = player.reference()!
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const edit = api.editQueue
  api.editQueue = async (...args) => {
    await blocked
    return edit(...args)
  }
  const navigation = player.navigate(1, true, 'sequential')
  await new Promise((resolve) => setImmediate(resolve))
  player.detach()
  release()
  assert.equal(await navigation, null)
  assert.equal(player.reference(), null)
  assert.equal(player.window.value, null)
  assert.equal(db.getLibraryQueue(saved.id).index, 1)
})

test('shuffle, restore order, duplicate remove/move and clear stay in SQLite', async (t) => {
  const { player } = fixture(t, 5)
  await player.create({ ids: ['0', '1', '0', '2', '3'], sort: 'playlist' }, '1', 'shuffle')
  assert.equal(player.window.value?.queue.order, 'shuffle')
  assert.equal(player.reference()?.index, 0)
  await player.edit({ kind: 'order', order: 'original' }, 'sequential')
  const originalEntry = player.reference()!.entryId
  await player.editPositions({ kind: 'move', from: 1, to: 3 }, 'sequential')
  assert.equal(player.reference()?.index, 3)
  assert.equal(player.reference()?.entryId, originalEntry)
  await player.editPositions({ kind: 'remove', index: 0 }, 'sequential')
  assert.equal(player.reference()?.index, 2)
  assert.equal(player.reference()?.entryId, originalEntry)
  await player.edit({ kind: 'clear' }, 'sequential')
  assert.equal(player.window.value, null)
  assert.equal(player.reference(), null)
})

test('database edits expose bounded CAS undo without materializing the queue', async (t) => {
  const { player } = fixture(t, 605)
  await player.create({ sort: 'playlist' }, '0', 'sequential')
  const before = player.snapshot.value!
  await player.edit({ kind: 'insert', trackIds: ['3'] }, 'sequential', before)
  assert.equal(player.canUndo(), true)
  assert.equal((await player.undo('sequential', player.snapshot.value!))?.queue.total, 605)
  assert.equal(player.canUndo(), false)
  assert.equal(player.diagnostics.cachedTracks <= 2_000, true)
})

test('cross-page insertions use bounded serialized batches, preserve duplicate order and support batch undo', async (t) => {
  const { player, api, db } = fixture(t, 5)
  await player.create({}, '0', 'sequential')
  const calls: number[] = []
  const original = api.editQueue
  api.editQueue = async (...args) => {
    if (args[2].kind === 'insert') {
      calls.push(args[2].items!.length)
      assert.ok(args[2].items!.length <= 1000)
    }
    return original(...args)
  }
  const items = Array.from({ length: 2105 }, (_, index) => ({ id: String(index % 5) }))
  const result = await player.edit({ kind: 'insert', items }, 'sequential')
  assert.deepEqual(calls, [1000, 1000, 105])
  assert.equal(result?.queue.total, 2110)
  const ids = db.sql
    .prepare('SELECT track_id FROM queue_entries WHERE queue_id=? ORDER BY position')
    .all(result!.queue.id)
    .map((row) => row.track_id)
  assert.deepEqual(
    ids.slice(5),
    items.map((item) => item.id)
  )
  assert.equal(player.reference()?.index, 0)
  assert.ok(player.diagnostics.cachedTracks <= 2000)
  for (const total of [2005, 1005, 5]) {
    assert.equal((await player.undo('sequential', player.snapshot.value!))?.queue.total, total)
  }
  assert.equal(player.canUndo(), false)
})

test('frozen query selection streams into the existing player lane without interleaved navigation', async (t) => {
  const { player, api, db } = fixture(t, 605)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const service = new LibrarySelectionService({
    createTrackSelection: async (request) => db.createTrackSelection(request),
    readTrackSelection: async (...args) => db.readTrackSelection(...args),
    closeTrackSelection: async (id) => db.closeTrackSelection(id)
  })
  t.after(() => service.destroy())
  const lease = await openLibrarySelectionLease(
    { selection: (command) => service.handle(owner, command) },
    {
      query: { contentRevision: db.getMetadata().revision, sort: 'insertion' },
      total: 605,
      ranges: [[0, 605]]
    }
  )
  const edits: string[] = [],
    edit = api.editQueue
  api.editQueue = async (...args) => {
    edits.push(args[2].kind)
    if (args[2].kind === 'insert') assert.ok(args[2].items!.length <= 200)
    return edit(...args)
  }
  let release!: () => void, entered!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const began = new Promise<void>((resolve) => {
    entered = resolve
  })
  const sizes: number[] = []
  const inserting = player.appendPages(async (append) => {
    try {
      await lease.forEachPage(async (page) => {
        await append(page.rows.map((row) => ({ id: row.track.id })))
        sizes.push(page.rows.length)
        if (sizes.length === 1) {
          entered()
          await paused
        }
      })
    } finally {
      await lease.close()
    }
  }, 'sequential')
  await began
  const navigate = player.navigate(1, false, 'sequential')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(edits, ['insert'])
  release()
  const result = await inserting
  await navigate
  assert.equal(result?.inserted, 605)
  assert.equal(result?.window?.queue.total, 606)
  assert.deepEqual(sizes, [200, 200, 200, 5])
  assert.deepEqual(edits, ['insert', 'insert', 'insert', 'insert', 'step'])
  assert.deepEqual(
    db.sql
      .prepare('SELECT track_id FROM queue_entries WHERE queue_id=? ORDER BY position')
      .all(player.snapshot.value!.id)
      .map((row) => row.track_id),
    ['0', ...Array.from({ length: 605 }, (_, i) => String(i))]
  )
  assert.ok(player.diagnostics.cachedTracks <= 2000)
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('streamed producer failure reports confirmed work and never repeats a read or a write', async (t) => {
  const { player, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  let requested = 0
  await assert.rejects(
    player.appendPages(async (append) => {
      requested++
      await append([{ id: '1' }, { id: '1' }])
      requested++
      throw new Error('selection read lost')
    }, 'sequential'),
    /已确认添加 2 首.*selection read lost/
  )
  assert.equal(requested, 2)
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).total, 3)
  await player.refresh('sequential')
  assert.equal(player.window.value?.queue.total, 3)
})

test('unknown streamed insertion stops the producer and requires refresh without replaying committed rows', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const edit = api.editQueue
  let writes = 0,
    reads = 0
  api.editQueue = async (...args) => {
    const result = await edit(...args)
    if (++writes === 2) throw new Error('unknown insertion reply')
    return result
  }
  await assert.rejects(
    player.appendPages(async (append) => {
      for (let i = 0; i < 4; i++) {
        reads++
        await append([{ id: '1' }])
      }
    }, 'sequential'),
    /已确认添加 1 首.*unknown insertion reply/
  )
  assert.equal(reads, 2)
  assert.equal(writes, 2)
  await assert.rejects(
    player.edit({ kind: 'insert', items: [{ id: '2' }] }, 'sequential'),
    /Refresh/
  )
  assert.equal(writes, 2)
  api.editQueue = edit
  await player.refresh('sequential')
  assert.equal(player.snapshot.value?.total, 3)
})

test('source replacement while a selection page is being read cannot append into either new or array queues', async (t) => {
  const { player, api, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const original = player.snapshot.value!.id
  const edit = api.editQueue
  let writes = 0,
    release!: () => void,
    entered!: () => void
  api.editQueue = async (...args) => {
    if (args[2].kind === 'insert') writes++
    return edit(...args)
  }
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const inserting = player.appendPages(async (append) => {
    await append([{ id: '1' }])
    entered()
    await wait
    await append([{ id: '2' }])
  }, 'sequential')
  const failed = assert.rejects(inserting, /已确认添加 1 首.*播放来源已变化/)
  await started
  const replacing = player.create({ ids: ['2'] }, '2', 'sequential')
  release()
  await failed
  await replacing
  assert.equal(writes, 1)
  assert.equal(db.getLibraryQueue(original).total, 2)
  assert.equal(player.snapshot.value?.total, 1)
  assert.equal(player.track()?.id, '2')
})

test('streaming append bounds each page and retains mixed/duplicate occurrence order including an empty queue', async (t) => {
  const { player, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  await player.edit({ kind: 'clear' }, 'sequential')
  await assert.rejects(
    player.appendPages(async (append) => {
      await append(Array(201).fill({ id: '1' }))
    }, 'sequential'),
    /每批最多添加 200/
  )
  assert.equal(player.snapshot.value?.total, 0)
  const result = await player.appendPages(async (append) => {
    await append([])
    await append([
      { id: '1' },
      {
        id: 'remote',
        snapshot: { id: 'remote', source: 'ncm', filePath: 'ncm:7', title: 'Remote' }
      }
    ])
    await append([{ id: '1' }])
  }, 'sequential')
  assert.equal(result?.inserted, 3)
  assert.equal(player.track()?.id, '1')
  const rows = db.readLibraryQueue(player.snapshot.value!.id).items
  assert.deepEqual(
    rows.map((row) => row.track?.id),
    ['1', 'remote', '1']
  )
  assert.notEqual(rows[0].queueEntryId, rows[2].queueEntryId)
})

test('a retained append callback cannot write after its producer succeeds or fails', async (t) => {
  const { player, api, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const edit = api.editQueue
  let writes = 0
  api.editQueue = async (...args) => {
    writes++
    return edit(...args)
  }
  for (const fails of [false, true]) {
    let retained!: (items: readonly LibraryQueueInsertItem[]) => Promise<void>
    const command = player.appendPages(async (append) => {
      retained = append
      await append([{ id: '1' }])
      if (fails) throw new Error('producer failed')
    }, 'sequential')
    if (fails) await assert.rejects(command, /已确认添加 1 首.*producer failed/)
    else assert.equal((await command)?.inserted, 1)
    await assert.rejects(retained([{ id: '2' }]), /已关闭|producer failed/)
    await assert.rejects(retained([]), /已关闭|producer failed/)
  }
  assert.equal(writes, 2)
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).total, 3)
})

test('a swallowed invalid page poisons the stream instead of allowing subsequent writes or success', async (t) => {
  const { player, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  await assert.rejects(
    player.appendPages(async (append) => {
      await append(Array(201).fill({ id: '1' })).catch(() => {})
      await append([{ id: '2' }]).catch(() => {})
    }, 'sequential'),
    /已确认添加 0 首.*每批最多添加 200/
  )
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).total, 1)
  assert.equal(player.diagnostics.requiresRefresh, false, 'no uncertain RPC was issued')
})

test('swallowing an unknown insertion reply cannot resume the producer or report success', async (t) => {
  const { player, api, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const edit = api.editQueue
  let writes = 0
  api.editQueue = async (...args) => {
    writes++
    await edit(...args)
    throw new Error('lost append acknowledgement')
  }
  await assert.rejects(
    player.appendPages(async (append) => {
      await append([{ id: '1' }]).catch(() => {})
      await append([{ id: '2' }]).catch(() => {})
    }, 'sequential'),
    /已确认添加 0 首.*lost append acknowledgement/
  )
  assert.equal(writes, 1)
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).total, 2)
  assert.equal(player.diagnostics.requiresRefresh, true)
})

function holdQueueWrite(api: LibraryQueueApi) {
  const edit = api.editQueue
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const edits: string[] = []
  api.editQueue = async (...args) => {
    edits.push(args[2].kind)
    if (args[2].kind === 'insert') {
      entered()
      await held
    }
    return edit(...args)
  }
  return { started, release, edits }
}

test('overlapping append callbacks reject the stream and join the already-issued write before releasing the lane', async (t) => {
  const { player, api, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const gate = holdQueueWrite(api)
  const command = player.appendPages(async (append) => {
    const first = append([{ id: '1' }])
    await gate.started
    await assert.rejects(append([{ id: '2' }]), /请等待上一批/)
    await first.catch(() => {})
  }, 'sequential')
  const failed = assert.rejects(command, /已确认添加 1 首.*请等待上一批/)
  await gate.started
  const next = player.navigate(1, false, 'sequential')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(gate.edits, ['insert'])
  gate.release()
  await failed
  await next
  assert.deepEqual(gate.edits, ['insert', 'step'])
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).total, 2)
})

test('an unawaited append cannot outlive its command or make its producer appear successful', async (t) => {
  const { player, api, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const gate = holdQueueWrite(api)
  const command = player.appendPages(async (append) => {
    void append([{ id: '1' }])
  }, 'sequential')
  const failed = assert.rejects(command, /已确认添加 1 首.*每批队列添加完成/)
  await gate.started
  const next = player.navigate(1, false, 'sequential')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(gate.edits, ['insert'])
  assert.equal(player.busy.value, true)
  gate.release()
  await failed
  await next
  assert.deepEqual(gate.edits, ['insert', 'step'])
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).total, 2)
})

test('producer failure waits for an in-flight acknowledgement and reports that confirmed page', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const gate = holdQueueWrite(api)
  const command = player.appendPages(async (append) => {
    void append([{ id: '1' }])
    throw new Error('selection read failed while writing')
  }, 'sequential')
  const failed = assert.rejects(command, /已确认添加 1 首.*selection read failed while writing/)
  await gate.started
  assert.equal(player.busy.value, true)
  gate.release()
  await failed
  assert.equal(player.snapshot.value?.total, 2)
  assert.equal(player.busy.value, false)
})

test('abort before production reads nothing; abort during a write retains its acknowledgement and stops further pages', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const before = new AbortController()
  before.abort()
  let reads = 0
  await assert.rejects(
    player.appendPages(
      async () => {
        reads++
      },
      'sequential',
      { signal: before.signal }
    ),
    /已确认添加 0 首.*已取消/
  )
  assert.equal(reads, 0)
  const during = new AbortController()
  const gate = holdQueueWrite(api)
  const command = player.appendPages(
    async (append) => {
      await append([{ id: '1' }]).catch(() => {})
      await append([{ id: '2' }]).catch(() => {})
    },
    'sequential',
    { signal: during.signal }
  )
  const failed = assert.rejects(command, /已确认添加 1 首.*已取消/)
  await gate.started
  during.abort()
  gate.release()
  await failed
  assert.deepEqual(gate.edits, ['insert'])
  assert.equal(player.snapshot.value?.total, 2)
})

test('the selection guard runs before production and after the final playback detail read', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  let valid = false,
    reads = 0
  const options = {
    guard: () => {
      if (!valid) throw new Error('selection epoch changed')
    }
  }
  await assert.rejects(
    player.appendPages(
      async () => {
        reads++
      },
      'sequential',
      options
    ),
    /已确认添加 0 首.*selection epoch changed/
  )
  assert.equal(reads, 0)
  valid = true
  const read = api.readQueue
  api.readQueue = async (...args) => {
    const result = await read(...args)
    valid = false
    return result
  }
  await assert.rejects(
    player.appendPages(
      async (append) => {
        await append([{ id: '1' }])
      },
      'sequential',
      options
    ),
    /已确认添加 1 首.*selection epoch changed/
  )
  assert.equal(player.snapshot.value?.total, 2)
  assert.equal(
    player.window.value?.queue.total,
    1,
    'invalid details cannot publish a new playback window'
  )
})

test('acknowledged counts use the copied bounded page, not later producer mutations', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const gate = holdQueueWrite(api)
  const command = player.appendPages(async (append) => {
    const page = [{ id: '1' }]
    const pending = append(page)
    page.push({ id: '2' })
    await pending
  }, 'sequential')
  await gate.started
  gate.release()
  assert.equal((await command)?.inserted, 1)
  assert.equal(player.snapshot.value?.total, 2)
})

test('cancellation during final hole resolution cannot issue a later cursor write', async (t) => {
  const { player, api, db } = fixture(t, 3)
  await player.create({ ids: ['0'] }, '0', 'sequential')
  const selected = player.reference()!.entryId
  const controller = new AbortController()
  const edits: string[] = []
  const edit = api.editQueue,
    read = api.readQueue
  api.editQueue = async (...args) => {
    edits.push(args[2].kind)
    return edit(...args)
  }
  api.readQueue = async (...args) => {
    const page = await read(...args)
    controller.abort()
    return page
  }
  await assert.rejects(
    player.appendPages(
      async (append) => {
        await append([{ id: '1' }])
        db.replaceDocument({
          version: 2,
          revision: 0,
          exclusions: [],
          folders: [],
          tracks: [{ id: '1', filePath: 'D:/Music/1.flac' }]
        })
        player.invalidateLibrary(db.getMetadata().revision)
      },
      'sequential',
      { signal: controller.signal }
    ),
    /已确认添加 1 首.*已取消/
  )
  assert.deepEqual(edits, ['insert'])
  assert.equal(db.getLibraryQueue(player.snapshot.value!.id).selectedEntryId, selected)
})

test('large anchored insertions retain source order on both sides of an occurrence', async (t) => {
  for (const position of ['afterEntryId', 'beforeEntryId'] as const) {
    const { player, db } = fixture(t, 3)
    await player.create({}, '1', 'sequential')
    const anchor = player.reference()!.entryId
    const ids = Array.from({ length: 2005 }, (_, i) => String(i % 3))
    await player.edit({ kind: 'insert', trackIds: ids, [position]: anchor }, 'sequential')
    const rows = db.sql
      .prepare('SELECT track_id FROM queue_entries WHERE queue_id=? ORDER BY position')
      .all(player.snapshot.value!.id)
      .map((row) => row.track_id)
    const start = position === 'afterEntryId' ? 2 : 1
    assert.deepEqual(rows.slice(start, start + ids.length), ids)
    assert.equal(player.track()?.id, '1')
  }
})

test('batched insertions stop after an unknown reply, block later edits until refresh and never replay', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({}, '0', 'sequential')
  const original = api.editQueue
  let calls = 0
  api.editQueue = async (...args) => {
    const result = await original(...args)
    if (++calls === 2) throw new Error('reply lost')
    return result
  }
  await assert.rejects(
    player.edit({ kind: 'insert', trackIds: Array(2100).fill('0') }, 'sequential'),
    /已确认添加 1000 首.*reply lost/
  )
  assert.equal(calls, 2)
  await assert.rejects(player.edit({ kind: 'insert', trackIds: ['1'] }, 'sequential'), /Refresh/)
  assert.equal(calls, 2)
  api.editQueue = original
  await player.refresh('sequential')
  assert.equal(player.snapshot.value?.total, 2003)
})

test('source replacement during a batched insertion prevents all later batches and queued cursor edits', async (t) => {
  const { player, api } = fixture(t, 3)
  await player.create({}, '0', 'sequential')
  const original = api.editQueue
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  api.editQueue = async (...args) => {
    calls++
    const result = await original(...args)
    started()
    await wait
    return result
  }
  const operation = player.edit({ kind: 'insert', trackIds: Array(2100).fill('0') }, 'sequential')
  const cursor = player.navigate(1, false, 'sequential')
  await began
  player.detach()
  release()
  assert.equal(await operation, null)
  assert.equal(await cursor, null)
  assert.equal(calls, 1)
})

test('ambiguous committed edit requires authoritative refresh, never replays next', async (t) => {
  const { player, api } = fixture(t, 5)
  await player.create({ sort: 'playlist' }, '0', 'sequential')
  const edit = api.editQueue
  api.editQueue = async (...args) => {
    await edit(...args)
    throw new Error('worker reply lost')
  }
  await assert.rejects(player.navigate(1, true, 'sequential'), /reply lost/)
  await assert.rejects(player.navigate(1, true, 'sequential'), /Refresh/)
  api.editQueue = edit
  await player.refresh('sequential')
  assert.equal(player.reference()?.index, 1)
})

test('invalid positions leave cursor and order unchanged and a missing saved queue detaches', async (t) => {
  const { player } = fixture(t, 5)
  await player.create({ sort: 'playlist' }, '1', 'sequential')
  const previous = player.reference()!
  assert.equal(await player.editPositions({ kind: 'move', from: 0, to: 9000 }, 'sequential'), null)
  assert.equal(await player.select(Number.MAX_SAFE_INTEGER, 'sequential'), null)
  assert.deepEqual(player.reference(), previous)
  await assert.rejects(
    player.restore({ ...previous, id: 'missing' }, 'sequential', () => true),
    /does not exist/
  )
  assert.equal(player.active.value, false)
})

test('library changes during a cross-page read retry details without skipping a valid selected track', async (t) => {
  const { player, api, db } = fixture(t)
  const read = api.readQueue
  let changed = false
  api.readQueue = async (...args) => {
    if (!changed && args[1] === 200) {
      changed = true
      db.patchTracks([{ id: '200', expectedVersion: 1, patch: { title: 'Updated' } }])
      player.invalidateLibrary(db.getMetadata().revision)
    }
    return read(...args)
  }
  await player.create({ sort: 'playlist' }, '199', 'sequential')
  assert.equal(changed, true)
  assert.equal(player.reference()?.index, 199)
  assert.equal(player.reference()?.revision, 1, 'initial logical mode was committed before reading')
  assert.equal(player.window.value?.items[1].track?.title, 'Updated')
})

test('drawer selects a duplicate occurrence and rejects stale-version edits before mutating SQL', async (t) => {
  const { player, db } = fixture(t, 5)
  await player.create({ ids: ['0', '1', '0', '2'], sort: 'playlist' }, '0', 'sequential')
  const expected = { ...player.snapshot.value! }
  const duplicate = (await player.loadPage(0))!.items[2]
  await player.selectEntry(duplicate.queueEntryId, expected, 'sequential')
  assert.equal(player.reference()?.index, 2)
  assert.equal(player.reference()?.entryId, duplicate.queueEntryId)
  assert.equal(player.snapshot.value?.selectedEntryId, duplicate.queueEntryId)
  const current = player.reference()!
  await assert.rejects(player.edit({ kind: 'clear' }, 'sequential', expected), /播放队列已变化/)
  await assert.rejects(
    player.selectEntry(duplicate.queueEntryId, expected, 'sequential'),
    /播放队列已变化/
  )
  assert.equal(db.getLibraryQueue(current.id).total, 4)
  assert.deepEqual(player.reference(), current)
})

test('empty queue keeps authoritative snapshot for drawer refresh and subsequent insertion', async (t) => {
  const { player } = fixture(t, 5)
  await player.create({}, '0', 'sequential')
  const original = player.snapshot.value!
  await player.edit({ kind: 'clear' }, 'sequential', original)
  assert.equal(player.snapshot.value?.total, 0)
  assert.equal(player.snapshot.value?.selectedEntryId, null)
  assert.equal(player.window.value, null)
  assert.equal(await player.refresh('sequential'), null)
  const empty = player.snapshot.value!
  assert.equal(empty.id, original.id)
  await player.edit({ kind: 'insert', trackIds: ['2'] }, 'sequential', empty)
  assert.equal(player.snapshot.value?.total, 1)
  assert.equal(player.track()?.id, '2')
  player.detach()
  assert.equal(player.snapshot.value, null)
})

test('drawer content invalidation is monotonic and stale detached edits cannot publish a snapshot', async (t) => {
  const { player, api } = fixture(t, 5)
  await player.create({}, '0', 'sequential')
  const revision = player.contentRevision.value
  player.invalidateLibrary(revision + 5)
  player.invalidateLibrary(revision + 1)
  assert.equal(player.contentRevision.value, revision + 5)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const edit = api.editQueue
  api.editQueue = async (...args) => {
    await blocked
    return edit(...args)
  }
  const pending = player.edit({ kind: 'clear' }, 'sequential', player.snapshot.value!)
  await new Promise((resolve) => setImmediate(resolve))
  player.detach()
  release()
  assert.equal(await pending, null)
  assert.equal(player.snapshot.value, null)
})
