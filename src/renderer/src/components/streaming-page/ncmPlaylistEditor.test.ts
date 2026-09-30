import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendNcmPlaylistTracks,
  createNcmPlaylistEditor,
  uniqueNcmTracks
} from './ncmPlaylistEditor.ts'
import type { Track } from '../../types/music.ts'

const track = (id: number): Track => ({
  id: `ncm:${id}`,
  ncmSongId: id,
  title: `${id}`,
  artist: '',
  album: '',
  duration: 0,
  filePath: '',
  fileName: '',
  size: 0,
  cover: null,
  lyrics: null
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(overrides: Partial<Parameters<typeof createNcmPlaylistEditor>[0]> = {}) {
  let context = 1
  const created: string[] = []
  const added: Array<{ id: string | number; tracks: number[] }> = []
  const editor = createNcmPlaylistEditor({
    canManage: () => true,
    captureContext: () => {
      const generation = context
      return () => generation === context
    },
    create: async (name) => {
      created.push(name)
      return { id: 123 }
    },
    add: async (id, tracks) => {
      added.push({ id, tracks: [...tracks] })
    },
    describeError: (error, fallback) => (error instanceof Error ? error.message : fallback),
    ...overrides
  })
  return {
    editor,
    created,
    added,
    changeContext: () => {
      context++
    }
  }
}

test('NCM IDs are positive safe integers and deduplicated once in input order', () => {
  assert.deepEqual(
    uniqueNcmTracks([
      track(2),
      track(1),
      track(2),
      track(0),
      track(-1),
      track(1.5),
      track(NaN),
      track(Infinity),
      track(Number.MAX_SAFE_INTEGER + 1)
    ]).map((item) => item.ncmSongId),
    [2, 1]
  )
})

test('cached playlist snapshots add each NCM song once and preserve untouched array identity', () => {
  const existing = [track(1)]
  assert.equal(appendNcmPlaylistTracks(existing, [track(1)]), existing)
  const result = appendNcmPlaylistTracks(existing, [track(2), track(2), track(1)])
  assert.notEqual(result, existing)
  assert.deepEqual(
    result.map((item) => item.ncmSongId),
    [1, 2]
  )
  assert.deepEqual(
    existing.map((item) => item.ncmSongId),
    [1]
  )
})

test('create snapshots name and seed IDs before I/O and creates one playlist', async () => {
  const pending = deferred<{ id: number }>()
  const f = fixture({ create: () => pending.promise })
  const original = track(1)
  f.editor.openCreate([original, track(1), track(2)])
  f.editor.name.value = '  Songs  '
  const request = f.editor.confirmCreate()
  original.ncmSongId = 99
  f.editor.name.value = 'changed during await'
  assert.equal(await f.editor.confirmCreate(), false)
  f.editor.closeCreate()
  assert.equal(f.editor.showCreate.value, true)
  pending.resolve({ id: 123 })
  assert.equal(await request, true)
  assert.deepEqual(f.added, [{ id: 123, tracks: [1, 2] }])
  assert.equal(f.editor.showCreate.value, false)
  assert.equal(f.editor.createBusy.value, false)
})

test('create acknowledged then add failed retains that playlist; retry only adds songs', async () => {
  let attempts = 0
  const f = fixture({
    add: async () => {
      if (++attempts === 1) throw new Error('offline')
    }
  })
  f.editor.openCreate([track(1)])
  f.editor.name.value = 'Songs'
  assert.equal(await f.editor.confirmCreate(), false)
  assert.equal(f.editor.created.value, true)
  assert.match(f.editor.createError.value, /歌单已创建/)
  assert.equal(f.editor.createBusy.value, false)
  assert.equal(await f.editor.confirmCreate(), true)
  assert.deepEqual(f.created, ['Songs'])
  assert.equal(attempts, 2)
})

test('a context change after creation prevents the second write into a new account/provider', async () => {
  const pending = deferred<{ id: number }>()
  const f = fixture({ create: () => pending.promise })
  f.editor.openCreate([track(1)])
  f.editor.name.value = 'Songs'
  const request = f.editor.confirmCreate()
  f.changeContext()
  pending.resolve({ id: 123 })
  assert.equal(await request, false)
  assert.deepEqual(f.added, [])
  assert.equal(f.editor.createBusy.value, false)
})

test('partial creation from an old account is never reused by a retry in a new context', async () => {
  const f = fixture({
    add: async () => {
      throw new Error('offline')
    }
  })
  f.editor.openCreate([track(1)])
  f.editor.name.value = 'Songs'
  await f.editor.confirmCreate()
  f.changeContext()
  assert.equal(await f.editor.confirmCreate(), false)
  assert.deepEqual(f.created, ['Songs'])
  assert.equal(f.editor.showCreate.value, false)
  assert.equal(f.editor.created.value, false)
})

test('reset invalidates an old add without closing or clearing the newer dialog', async () => {
  const pending = deferred<void>()
  const calls: number[][] = []
  const f = fixture({
    add: async (_id, ids) => {
      calls.push([...ids])
      await pending.promise
    }
  })
  assert.equal(f.editor.openAdd([track(1), track(1), track(2)]), true)
  const request = f.editor.confirmAdd('A')
  f.editor.reset()
  f.editor.openAdd([track(3)])
  pending.resolve()
  assert.equal(await request, false)
  assert.deepEqual(calls, [[1, 2]])
  assert.equal(f.editor.showAdd.value, true)
  assert.equal(f.editor.addTracks.value[0].ncmSongId, 3)
  assert.equal(f.editor.addBusy.value, false)
})

test('late failures after dispose cannot publish errors and disposal releases selected rows', async () => {
  const pending = deferred<void>()
  const f = fixture({ add: () => pending.promise })
  f.editor.openAdd([track(1)])
  const request = f.editor.confirmAdd('A')
  f.editor.dispose()
  pending.reject(new Error('offline'))
  assert.equal(await request, false)
  assert.equal(f.editor.addError.value, '')
  assert.deepEqual(f.editor.addTracks.value, [])
  assert.equal(f.editor.openAdd([track(2)]), false)
})

test('add fixes its target ID and song snapshot; failures permit retry without losing selection', async () => {
  let calls = 0
  const f = fixture({
    add: async () => {
      if (++calls === 1) throw new Error('offline')
    }
  })
  f.editor.openAdd([track(1)])
  assert.equal(await f.editor.confirmAdd('A'), false)
  assert.equal(f.editor.addError.value, 'offline')
  assert.equal(f.editor.showAdd.value, true)
  assert.equal(f.editor.addBusy.value, false)
  assert.equal(await f.editor.confirmAdd('A'), true)
  assert.equal(f.editor.showAdd.value, false)
  assert.deepEqual(f.editor.addTracks.value, [])
})

test('unsupported management and invalid selection cannot start writes; add-to-create preserves selected IDs', async () => {
  const blocked = fixture({ canManage: () => false })
  assert.equal(blocked.editor.openCreate(), false)
  assert.equal(blocked.editor.openAdd([track(1)]), false)
  assert.equal(await blocked.editor.confirmCreate(), false)
  const f = fixture()
  assert.equal(f.editor.openAdd([track(0)]), false)
  f.editor.openAdd([track(2), track(1)])
  f.editor.convertAddToCreate()
  assert.equal(f.editor.showAdd.value, false)
  assert.equal(f.editor.showCreate.value, true)
  f.editor.name.value = 'Songs'
  assert.equal(await f.editor.confirmCreate(), true)
  assert.deepEqual(f.added, [{ id: 123, tracks: [2, 1] }])
})

test('context-menu add executes without opening the playlist picker', async () => {
  const f = fixture()
  assert.equal(f.editor.openAdd([track(1)], false), true)
  assert.equal(f.editor.showAdd.value, false)
  assert.equal(await f.editor.confirmAdd('A'), true)
  assert.deepEqual(f.added, [{ id: 'A', tracks: [1] }])
})
