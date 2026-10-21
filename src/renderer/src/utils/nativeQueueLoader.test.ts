import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeQueueLoader } from './nativeQueueLoader.ts'
import type { Track } from '../types/music'
import type { PreparePlayerNativeQueueOptions } from './nativeQueuePreparation.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function tracks(count: number): Track[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `local:${index}`,
        source: 'local',
        filePath: `D:/Music/${index}.flac`,
        duration: 240
      }) as Track
  )
}

test('conditional handoff derives native window slots from the committed occurrence and restores authority only on explicit refusal', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(3)
  queue.forEach((track, i) => {
    track.queueEntryId = `old-${i}`
  })
  loader.adopt(queue, { queueToken: 'old', queueIndex: 1, nativeQueueIndices: [2, 0] })
  const info = { queueToken: 'old', queueIndex: 0, source: queue[2].filePath }
  const expected = loader.arraySelection(info, queue, 2, queue[2])!
  assert.equal(expected.index, 0)
  assert.equal(loader.arraySelection({ ...info, queueToken: 'wrong' }, queue, 2, queue[2]), null)
  assert.equal(loader.arraySelection(info, queue, 0, queue[0]), null)
  assert.equal(
    loader.arraySelection(info, queue, 2, { ...queue[2], queueEntryId: 'another' }),
    null
  )
  const prepared = {
    items: [{ id: queue[2].id, source: queue[2].filePath, queueEntryId: 'sql-current' }],
    startIndex: 0,
    delegated: false,
    queueIndices: [299_999],
    libraryQueue: {
      id: 'sql',
      revision: 3,
      entries: [{ id: queue[2].id, queueEntryId: 'sql-current', index: 299_999 }]
    }
  }
  assert.deepEqual(await loader.rebindPrepared(prepared, expected, 'shuffle', {}), {
    applied: false,
    current: true
  })
  const refusal = await loader.rebindPrepared(prepared, expected, 'shuffle', {
    rebindQueue: async (request) => {
      assert.equal(request.playMode, 'sequential')
      assert.equal(request.expected.index, 0)
      assert.equal(loader.findLogicalIndex(info, queue), -1)
      return null
    }
  })
  assert.deepEqual(refusal, { applied: false, current: true })
  assert.equal(loader.findLogicalIndex(info, queue), 2)
  await loader.rebindPrepared(prepared, expected, 'repeat', {
    rebindQueue: async (request) => {
      assert.equal(request.playMode, 'repeat')
      return { queueToken: 'new' }
    }
  })
  assert.equal(loader.findLogicalIndex(info, queue), -1)
  assert.deepEqual(
    loader.findLibraryEntry({ queueToken: 'new', queueIndex: 0 }, { id: 'sql', revision: 3 }),
    { id: queue[2].id, queueEntryId: 'sql-current', index: 299_999 }
  )
})

test('late confirmed/refused/invalid handoff replies cannot overwrite or revoke a newer native mapping', async () => {
  for (const reply of [null, { queueToken: 'late' }, undefined]) {
    const loader = new NativeQueueLoader(),
      queue = tracks(1)
    queue[0].queueEntryId = 'old-entry'
    loader.adopt(queue, { queueToken: 'old', queueIndex: 0 })
    const pending = deferred<{ queueToken: string } | null | undefined>()
    const prepared = {
      items: [{ id: queue[0].id, source: queue[0].filePath, queueEntryId: 'sql-entry' }],
      startIndex: 0,
      delegated: false,
      queueIndices: [0],
      libraryQueue: {
        id: 'sql',
        revision: 0,
        entries: [{ id: queue[0].id, queueEntryId: 'sql-entry', index: 0 }]
      }
    }
    const request = loader.rebindPrepared(
      prepared,
      { queueToken: 'old', index: 0, id: queue[0].id, source: queue[0].filePath },
      'sequential',
      {
        rebindQueue: () => pending.promise as Promise<{ queueToken: string } | null>
      }
    )
    await loader.loadPrepared(prepared, { loadQueue: async () => ({ queueToken: 'newer' }) })
    pending.resolve(reply)
    if (reply === undefined) await assert.rejects(request, /结果未知/)
    else assert.equal((await request).current, false)
    assert.equal(
      loader.findLibraryEntry({ queueToken: 'newer', queueIndex: 0 }, { id: 'sql', revision: 0 })
        ?.queueEntryId,
      'sql-entry'
    )
  }
})

test('unconfirmed handoff revokes old authority and never retries; prepared identities are captured before IPC', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(1)
  queue[0].queueEntryId = 'old-entry'
  loader.adopt(queue, { queueToken: 'old', queueIndex: 0 })
  const prepared = {
    items: [{ id: queue[0].id, source: queue[0].filePath, queueEntryId: 'sql-entry' }],
    startIndex: 0,
    delegated: false,
    queueIndices: [0],
    libraryQueue: {
      id: 'sql',
      revision: 0,
      entries: [{ id: queue[0].id, queueEntryId: 'sql-entry', index: 0 }]
    }
  }
  let calls = 0
  await assert.rejects(
    loader.rebindPrepared(
      prepared,
      { queueToken: 'old', index: 0, id: queue[0].id, source: queue[0].filePath },
      'sequential',
      {
        rebindQueue: async () => {
          calls++
          throw new Error('lost reply')
        }
      }
    ),
    /lost reply/
  )
  assert.equal(calls, 1)
  assert.equal(loader.findLogicalIndex({ queueToken: 'old', queueIndex: 0 }, queue), -1)
  loader.adopt(queue, { queueToken: 'old', queueIndex: 0 })
  const held = deferred<{ queueToken: string }>()
  const request = loader.rebindPrepared(
    prepared,
    { queueToken: 'old', index: 0, id: queue[0].id, source: queue[0].filePath },
    'sequential',
    { rebindQueue: () => held.promise }
  )
  prepared.libraryQueue.entries[0].queueEntryId = 'mutated'
  held.resolve({ queueToken: 'new' })
  await request
  assert.equal(
    loader.findLibraryEntry({ queueToken: 'new', queueIndex: 0 }, { id: 'sql', revision: 0 })
      ?.queueEntryId,
    'sql-entry'
  )
})

test('database native slots resolve without a full Track array and require matching queue and native versions', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(2)
  queue[0].id = queue[1].id = 'same'
  queue[0].queueEntryId = 'last'
  queue[1].queueEntryId = 'first'
  const options: PreparePlayerNativeQueueOptions = {
    queue,
    currentTrack: queue[0],
    currentTarget: queue[0].filePath,
    currentIndex: 0,
    libraryQueue: { id: 'db', revision: 7, positions: [299_999, 0] },
    playMode: 'shuffle'
  }
  const prepared = await loader.prepareAndLoad(
    options,
    { isAudioFileAuthorized: async () => true },
    { loadQueue: async () => ({ queueToken: 'native' }) }
  )
  assert.equal(prepared?.items.length, 2)
  assert.deepEqual(loader.getLibraryQueueReference(), { id: 'db', revision: 7 })
  assert.deepEqual(
    loader.findLibraryEntry({ queueIndex: 1, queueToken: 'native' }, { id: 'db', revision: 7 }),
    { id: 'same', queueEntryId: 'first', index: 0 }
  )
  for (const reference of [
    { id: 'other', revision: 7 },
    { id: 'db', revision: 8 }
  ])
    assert.equal(loader.findLibraryEntry({ queueIndex: 1, queueToken: 'native' }, reference), null)
  assert.equal(
    loader.findLibraryEntry({ queueIndex: 1, queueToken: 'old' }, { id: 'db', revision: 7 }),
    null
  )
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'native' }, queue), -1)
  assert.equal(loader.playMode('shuffle'), 'sequential')
  assert.equal(loader.playMode('repeat'), 'repeat')
})

test('identical media from a different occurrence or database queue cannot reuse old queue authority', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(1)
  queue[0].queueEntryId = 'first'
  let loads = 0,
    selections = 0
  const api = {
    loadQueue: async () => ({ queueToken: `token-${++loads}` }),
    selectQueueItem: async () => {
      selections++
      return true
    }
  }
  const select = (id: string, revision = 0) =>
    loader.prepareAndLoad(
      {
        queue,
        currentTrack: queue[0],
        currentTarget: queue[0].filePath,
        currentIndex: 0,
        libraryQueue: { id, revision, positions: [0] }
      },
      { isAudioFileAuthorized: async () => true },
      api
    )
  await select('db')
  await select('db')
  assert.equal(selections, 1)
  await select('other')
  assert.equal(loads, 2)
  await select('other', 1)
  assert.equal(loads, 3)
  queue[0] = { ...queue[0], queueEntryId: 'replacement' }
  await select('other', 1)
  assert.equal(loads, 4)
  assert.equal(selections, 1)
})

test('late loads cannot overwrite a newer committed database window or resurrect a cleared one', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(2)
  queue.forEach((track, i) => {
    track.queueEntryId = `entry-${i}`
  })
  const old = deferred<{ queueToken: string }>()
  const options = (i: number): PreparePlayerNativeQueueOptions => ({
    queue: [queue[i]],
    currentTrack: queue[i],
    currentTarget: queue[i].filePath,
    currentIndex: 0,
    libraryQueue: { id: `db-${i}`, revision: 0, positions: [299_998 + i] }
  })
  const stale = loader.prepareAndLoad(
    options(0),
    { isAudioFileAuthorized: async () => true },
    { loadQueue: () => old.promise }
  )
  await new Promise((resolve) => setImmediate(resolve))
  await loader.prepareAndLoad(
    options(1),
    { isAudioFileAuthorized: async () => true },
    { loadQueue: async () => ({ queueToken: 'new' }) }
  )
  old.resolve({ queueToken: 'old' })
  assert.equal(await stale, null)
  assert.equal(
    loader.findLibraryEntry({ queueIndex: 0, queueToken: 'new' }, { id: 'db-1', revision: 0 })
      ?.index,
    299_999
  )
  const pending = deferred<{ queueToken: string }>()
  const cleared = loader.prepareAndLoad(
    options(0),
    { isAudioFileAuthorized: async () => true },
    { loadQueue: () => pending.promise }
  )
  await new Promise((resolve) => setImmediate(resolve))
  loader.clear()
  pending.resolve({ queueToken: 'cleared' })
  assert.equal(await cleared, null)
  assert.equal(loader.getLibraryQueueReference(), null)
})

test('late cursor selection cannot clear a newer queue mapping', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(1),
    selection = deferred<boolean>()
  const options = {
    queue,
    currentTrack: queue[0],
    currentTarget: queue[0].filePath,
    currentIndex: 0
  }
  const boundary = { isAudioFileAuthorized: async () => true }
  await loader.prepareAndLoad(options, boundary, { loadQueue: async () => ({ queueToken: 'old' }) })
  const stale = loader.prepareAndLoad(options, boundary, {
    loadQueue: async () => {
      throw new Error('reuse expected')
    },
    selectQueueItem: () => selection.promise
  })
  await new Promise((resolve) => setImmediate(resolve))
  await loader.loadPrepared(
    { items: [{ id: queue[0].id, source: 'different.flac' }], startIndex: 0, delegated: true },
    { loadQueue: async () => ({ queueToken: 'new' }) },
    queue
  )
  selection.resolve(true)
  assert.equal(await stale, null)
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'new' }, queue), 0)
})

test('load commit captures occurrence identities before IPC instead of rebinding mutated caller rows', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(1),
    pending = deferred<{ queueToken: string }>()
  queue[0].queueEntryId = 'before'
  const load = loader.loadPrepared(
    { items: [{ id: queue[0].id, source: queue[0].filePath }], startIndex: 0, delegated: true },
    { loadQueue: () => pending.promise },
    queue
  )
  queue[0] = { ...queue[0], queueEntryId: 'after' }
  pending.resolve({ queueToken: 'token' })
  await load
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'token' }, queue), -1)
})

test('manual selections reuse one committed 5000-item queue with fresh current-file checks', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(5000)
  let batches = 0,
    targets = 0,
    singles = 0,
    loads = 0,
    selections = 0
  const boundary = {
    isAudioFileAuthorized: async () => {
      singles++
      return true
    },
    areAudioFilesAuthorized: async (paths: string[]) => {
      batches++
      targets += paths.length
      return paths.map(() => true)
    }
  }
  const api = {
    loadQueue: async () => {
      loads++
      return { queueToken: 'main-owned-version' }
    },
    selectQueueItem: async ({ queueToken, index }: { queueToken: string; index: number }) => {
      assert.equal(queueToken, 'main-owned-version')
      assert.equal(index, ++selections)
      return true
    }
  }
  for (let index = 0; index < 13; ++index) {
    const prepared = await loader.prepareAndLoad(
      {
        queue,
        currentTrack: queue[index],
        currentTarget: queue[index].filePath,
        currentIndex: index
      },
      boundary,
      api
    )
    assert.equal(prepared?.delegated, true)
  }
  assert.deepEqual(
    { batches, targets, singles, loads, selections },
    { batches: 1, targets: 5000, singles: 13, loads: 1, selections: 12 }
  )
  queue[4].replayGainTrackGainDb = -4
  await loader.prepareAndLoad(
    { queue, currentTrack: queue[0], currentTarget: queue[0].filePath, currentIndex: 0 },
    boundary,
    api
  )
  assert.equal(loads, 2)
  assert.equal(batches, 2)
})

test('stale queue authority repeats availability checks and degrades an unavailable companion', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(2)
  let available = true,
    loads = 0,
    lastItems = 0,
    batches = 0
  const api = {
    loadQueue: async (items: unknown[]) => {
      loads++
      lastItems = items.length
      return { queueToken: 'version' }
    },
    selectQueueItem: async () => false
  }
  const boundary = {
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async () => {
      batches++
      return [true, available]
    }
  }
  const options = {
    queue,
    currentTrack: queue[0],
    currentTarget: queue[0].filePath,
    currentIndex: 0
  }
  await loader.prepareAndLoad(options, boundary, api)
  available = false
  const prepared = await loader.prepareAndLoad(options, boundary, api)
  assert.equal(prepared?.delegated, false)
  assert.deepEqual({ loads, lastItems, batches }, { loads: 2, lastItems: 1, batches: 2 })
})

test('duplicate sources preserve selected CUE index and range; changes invalidate content', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(2)
  queue[1].filePath = queue[0].filePath
  queue[0].cueRange = { startSeconds: 0, endSeconds: 10 } as Track['cueRange']
  queue[1].cueRange = { startSeconds: 10, endSeconds: 20 } as Track['cueRange']
  let loads = 0
  const api = {
    loadQueue: async () => {
      loads++
      return { queueToken: 'cue-version' }
    },
    selectQueueItem: async ({ index, id }: { index: number; id: string }) => {
      assert.equal(index, 1)
      assert.equal(id, queue[1].id)
      return true
    }
  }
  const boundary = { isAudioFileAuthorized: async () => true }
  const select = (index: number) =>
    loader.prepareAndLoad(
      {
        queue,
        currentTrack: queue[index],
        currentTarget: queue[index].filePath,
        currentIndex: index
      },
      boundary,
      api
    )
  await select(0)
  await select(1)
  assert.equal(loads, 1)
  queue[1].cueRange!.endSeconds = 21
  await select(1)
  assert.equal(loads, 2)
})

test('superseded preparation never commits a queue', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(2)
  let current = true,
    loads = 0
  const prepared = await loader.prepareAndLoad(
    {
      queue,
      currentTrack: queue[0],
      currentTarget: queue[0].filePath,
      currentIndex: 0,
      isCurrent: () => current
    },
    {
      isAudioFileAuthorized: async () => true,
      areAudioFilesAuthorized: async () => {
        current = false
        return [true, true]
      }
    },
    {
      loadQueue: async () => {
        loads++
      }
    }
  )
  assert.equal(prepared, null)
  assert.equal(loads, 0)
})

test('legacy APIs without cursor selection retain full availability checks', async () => {
  const loader = new NativeQueueLoader(),
    queue = tracks(2)
  let batches = 0,
    available = true
  const boundary = {
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async () => {
      batches++
      return [available, true]
    }
  }
  const api = { loadQueue: async () => ({ queueToken: 'legacy' }) }
  const options = {
    queue,
    currentTrack: queue[1],
    currentTarget: queue[1].filePath,
    currentIndex: 1
  }
  assert.equal((await loader.prepareAndLoad(options, boundary, api))?.delegated, true)
  available = false
  assert.equal((await loader.prepareAndLoad(options, boundary, api))?.delegated, false)
  assert.equal(batches, 2)
})

test('adopted engine identity maps indices without reloading the native queue', () => {
  const loader = new NativeQueueLoader()
  const queue = tracks(3)
  loader.adopt(queue, { queueIndex: 1, queueToken: 'engine-token' })
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'engine-token' }, queue), 1)
  assert.equal(loader.findLogicalIndex({ queueIndex: 2, queueToken: 'engine-token' }, queue), 2)
  // A different token belongs to another queue version; adoption must not lie.
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'other' }, queue), -1)
  assert.equal(loader.hasWindow(), false)
  assert.deepEqual(loader.getCommittedIndices(), [0, 1, 2])
})

test('windowed adoption maps native slots onto their logical queue indices', () => {
  const loader = new NativeQueueLoader()
  const queue = tracks(5)
  loader.adopt(queue, {
    queueIndex: 3,
    queueToken: 'window-token',
    nativeQueueIndices: [3, 4]
  })
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'window-token' }, queue), 3)
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'window-token' }, queue), 4)
  // Outside the loaded window there is nothing to map.
  assert.equal(loader.findLogicalIndex({ queueIndex: 2, queueToken: 'window-token' }, queue), -1)
  assert.equal(loader.hasWindow(), true)
  assert.deepEqual(loader.getCommittedIndices(), [3, 4])
  // An unmapped (-1) slot must stay unmapped instead of shifting later entries.
  loader.adopt(queue, { queueToken: 'gap-token', queueIndex: 0, nativeQueueIndices: [-1, 2] })
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'gap-token' }, queue), -1)
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'gap-token' }, queue), 2)
})

test('partial native queues map versioned indices to duplicate logical occurrences', async () => {
  const loader = new NativeQueueLoader()
  const queue = tracks(4)
  queue[0].id = queue[3].id = 'ncm:same'
  queue.forEach((track, index) => {
    track.queueEntryId = `entry:${index}`
  })
  const prepared = {
    items: [
      { id: queue[3].id, source: 'twilight-media://audio/last' },
      { id: queue[0].id, source: 'twilight-media://audio/first' }
    ],
    startIndex: 0,
    delegated: false,
    queueIndices: [3, 0]
  }
  await loader.loadPrepared(prepared, { loadQueue: async () => ({ queueToken: 'window' }) }, queue)
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'window' }, queue), 3)
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'window' }, queue), 0)
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'old-window' }, queue), -1)
  assert.equal(loader.findLogicalIndex({ queueIndex: 1 }, queue), -1)
  queue[0] = { ...queue[0], queueEntryId: 'replacement' }
  assert.equal(loader.findLogicalIndex({ queueIndex: 1, queueToken: 'window' }, queue), -1)
  assert.equal(loader.playMode('listLoop'), 'sequential')
  loader.clear()
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'window' }, queue), -1)
})

test('cursor-only database rebases retain token authority but cannot cross queue identities or revisions', async () => {
  const loader = new NativeQueueLoader()
  const entry = { id: 'same', queueEntryId: 'occurrence', index: 199 }
  await loader.loadPrepared(
    {
      items: [{ id: 'same', source: 'D:/Music/same.flac', queueEntryId: 'occurrence' }],
      startIndex: 0,
      delegated: false,
      queueIndices: [199],
      libraryQueue: { id: 'database-queue', revision: 2, entries: [entry] }
    },
    { loadQueue: async () => ({ queueToken: 'native-token' }) }
  )
  const previous = { id: 'database-queue', revision: 2 }
  const next = { id: 'database-queue', revision: 3 }
  assert.equal(loader.rebaseLibraryCursor(previous, { id: 'another', revision: 3 }), false)
  assert.equal(loader.rebaseLibraryCursor({ ...previous, revision: 1 }, next), false)
  assert.equal(loader.rebaseLibraryCursor(previous, next), true)
  const info = { queueIndex: 0, queueToken: 'native-token' }
  assert.equal(loader.findLibraryEntry(info, previous), null)
  assert.deepEqual(loader.findLibraryEntry(info, next), entry)
  assert.equal(loader.findLibraryEntry({ ...info, queueToken: 'old' }, next), null)
})
