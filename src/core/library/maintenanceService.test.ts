import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { File } from 'node-taglib-sharp'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreLibraryMaintenance } from './maintenanceService.ts'
import { runLibraryTagWorker } from './tagWorker.ts'
import { getTagWriteJournalPath, readTagWriteJournal, tagBackupPath } from './tagWriteService.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'core-library-mutations-'))
  const database = new LibraryDatabase(':memory:')
  const audio = join(root, 'song.wav'),
    backups = join(root, 'tag-backups')
  const wave = Buffer.alloc(44 + 16000)
  wave.write('RIFF')
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24)
  wave.writeUInt32LE(16000, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(16000, 40)
  writeFileSync(audio, wave)
  const records = [
    {
      id: 'cue-a',
      filePath: audio,
      title: 'A',
      artist: 'Artist',
      source: 'local',
      cueRange: { startSeconds: 0, endSeconds: 0.5 }
    },
    {
      id: 'cue-b',
      filePath: audio,
      title: 'B',
      artist: 'Artist',
      source: 'local',
      cueRange: { startSeconds: 0.5, endSeconds: 1 }
    }
  ]
  database.replaceDocument({
    version: 2,
    revision: 1,
    tracks: records,
    folders: [root],
    exclusions: []
  })
  const db = new Proxy(database, {
    get(target, name) {
      const value = Reflect.get(target, name)
      return typeof value === 'function'
        ? async (...args: unknown[]) => value.apply(target, args)
        : value
    }
  })
  let mutations = 0,
    trashCalls = 0,
    authorized = true,
    hold: ReturnType<typeof deferred<void>> | null = null
  const entered = deferred<void>(),
    reindexed: string[][] = []
  const service = new CoreLibraryMaintenance({
    database: db as unknown as ConstructorParameters<typeof CoreLibraryMaintenance>[0]['database'],
    scanner: {
      maintain: async (action) => action(),
      enqueueDirectories: async (roots) => {
        reindexed.push([...roots])
      }
    },
    maintainFiles: async (paths, action) => {
      assert.ok(paths.every((path) => path === audio))
      entered.resolve()
      if (hold) await hold.promise
      return action()
    },
    authorizeFile: async (path) => {
      if (!authorized) throw new Error('Path denied')
      return path
    },
    authorizeRemoval: async () => {
      if (!authorized) throw new Error('Path denied')
    },
    trash: async () => {
      trashCalls++
      rmSync(audio)
    },
    tagJournalExists: async () => existsSync(getTagWriteJournalPath(backups)),
    tags: (request) => runLibraryTagWorker(backups, request),
    pathKey: (path) => path.toLowerCase(),
    directoryOf: dirname,
    fileName: basename,
    newId: randomUUID,
    changed: () => {
      mutations++
    }
  })
  const selection = async () => {
    // SQL maintenance normally runs in its existing utility service.
    while (database.needsQueryMaintenance) database.maintainQueryState()
    const page = database.queryTracks({ sort: 'insertion', limit: 1 })
    return service.open({
      query: { sort: 'insertion', contentRevision: page.revision },
      total: page.total,
      ranges: [[0, page.total]]
    })
  }
  t.after(async () => {
    await service.shutdown()
    database.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    database,
    db,
    records,
    audio,
    backups,
    service,
    selection,
    entered,
    reindexed,
    wave,
    hold: () => {
      hold = deferred<void>()
      return hold
    },
    deny: () => {
      authorized = false
    },
    changes: () => mutations,
    trashCalls: () => trashCalls
  }
}

test('Core selections use projected metadata; one physical-file deletion preserves CUE identity and exclusions', async (t) => {
  const f = fixture(t),
    selection = await f.selection()
  assert.equal(selection.selectedCount, 2)
  assert.equal(selection.fileCount, 1)
  const page = await f.service.page(selection.id)
  assert.deepEqual(
    page.rows.map((row) => row.track.id),
    ['cue-a', 'cue-b']
  )
  assert.doesNotMatch(JSON.stringify(page), /filePath/)
  const result = await f.service.remove(selection.id, 'library')
  assert.deepEqual(result.removedTrackIds, ['cue-a', 'cue-b'])
  assert.equal(result.removedFileCount, 1)
  assert.equal(f.trashCalls(), 0)
  assert.equal(existsSync(f.audio), true)
  assert.equal(f.database.getMetadata().exclusions.length, 1)
  await assert.rejects(f.service.page(selection.id), /expired/)
  const before = f.database.getMetadata()
  await assert.rejects(f.service.clearExclusions(before.revision - 1, [f.audio]), /发生变化/)
  assert.equal(f.database.getMetadata().exclusions.length, 1)
  assert.equal((await f.service.clearExclusions(before.revision, [f.audio])).clearedFiles, 1)
})

test('stale row incarnation/version and denied paths cannot trash a replacement file', async (t) => {
  const f = fixture(t),
    first = await f.selection()
  const version = f.database.getTracksByIds(['cue-a']).versions['cue-a']
  f.database.patchTracks([{ id: 'cue-a', expectedVersion: version, patch: { title: 'New edit' } }])
  const result = await f.service.remove(first.id, 'trash')
  assert.equal(result.failures.length, 1)
  assert.equal(f.trashCalls(), 0)
  const second = await f.selection()
  f.deny()
  assert.equal((await f.service.remove(second.id, 'trash')).failures.length, 1)
  assert.equal(f.trashCalls(), 0)
  assert.equal(f.database.getMetadata().trackCount, 2)
})

test('accepted trash survives client cancellation and is not repeated on reinitialization', async (t) => {
  const f = fixture(t),
    selection = await f.selection(),
    gate = f.hold(),
    client = new AbortController()
  const work = f.service.remove(selection.id, 'trash', client.signal)
  await f.entered.promise
  client.abort(new Error('Renderer closed'))
  gate.resolve()
  const result = await work
  assert.equal(result.removedFileCount, 1)
  assert.equal(f.trashCalls(), 1)
  await f.service.initialize()
  assert.equal(f.trashCalls(), 1)
  assert.equal(f.database.getPendingRemoval(), null)
})

test('startup resolves a claimed trash with a lost reply without repeating its filesystem operation', async (t) => {
  const f = fixture(t)
  f.database.beginRemoval('lost-trash-reply', 'trash', [
    { id: 'cue-a', filePath: f.audio, title: 'A', artist: 'Artist' }
  ])
  f.database.markRemovalAttempting('lost-trash-reply', f.audio)
  rmSync(f.audio)
  await f.service.initialize()
  assert.equal(f.database.getPendingRemoval(), null)
  assert.equal(f.database.getMetadata().trackCount, 0)
  assert.equal(f.trashCalls(), 0)
})

test('tag worker writes a real WAV once per physical file and journal restore retains the previous file', async (t) => {
  const f = fixture(t),
    selection = await f.selection()
  const result = await f.service.writeTags({
    selectionId: selection.id,
    patch: { title: 'Tagged in Core', artist: 'Updated' }
  })
  assert.deepEqual(result.items, [{ id: 'cue-a', name: 'song.wav', status: 'success' }])
  const media = File.createFromPath(f.audio)
  try {
    assert.equal(media.tag.title, 'Tagged in Core')
    assert.equal(media.tag.performers[0], 'Updated')
  } finally {
    media.dispose()
  }
  assert.equal(readTagWriteJournal(f.backups).entries.length, 1)
  assert.deepEqual(f.reindexed, [[f.root]])
  assert.deepEqual((await f.service.restoreTags(undefined)).items, [
    { id: null, name: 'song.wav', status: 'success' }
  ])
  assert.deepEqual(readFileSync(f.audio), f.wave)
})

test('tag dispatch rechecks the frozen row after resource draining and rejects caller-invented targets', async (t) => {
  const f = fixture(t),
    selection = await f.selection(),
    gate = f.hold()
  const work = f.service.writeTags({ selectionId: selection.id, patch: { title: 'Stale edit' } })
  const rejected = assert.rejects(work, (error: any) => error.code === 'STALE_REVISION')
  await f.entered.promise
  const version = f.database.getTracksByIds(['cue-a']).versions['cue-a']
  f.database.patchTracks([{ id: 'cue-a', expectedVersion: version, patch: { title: 'New edit' } }])
  gate.resolve()
  await rejected
  assert.equal(existsSync(getTagWriteJournalPath(f.backups)), false)
  const next = await f.selection()
  await assert.rejects(
    f.service.writeTags({
      selectionId: next.id,
      items: [{ id: 'not-selected', patch: { title: 'Other' } }]
    }),
    /selected physical/
  )
  assert.deepEqual(readFileSync(f.audio), f.wave)
})

test('tag selection cannot authorize a deleted and re-added row with a recycled record version', async (t) => {
  const f = fixture(t),
    selection = await f.selection()
  const frozen = f.database.readTrackSelection(selection.id).rows[0]
  f.database.resetLibrary()
  f.database.replaceDocument({
    version: 2,
    revision: 3,
    tracks: f.records,
    folders: [f.root],
    exclusions: []
  })
  assert.equal(f.database.getTracksByIds(['cue-a']).versions['cue-a'], frozen.version)
  await assert.rejects(
    f.service.writeTags({ selectionId: selection.id, patch: { title: 'Old intent' } }),
    (error: any) => error.code === 'STALE_REVISION'
  )
  assert.equal(existsSync(getTagWriteJournalPath(f.backups)), false)
})

test('startup rolls back only interrupted tag writes, preserving completed edits and backup identity', async (t) => {
  const f = fixture(t),
    selection = await f.selection()
  await f.service.writeTags({ selectionId: selection.id, patch: { title: 'Complete' } })
  await f.service.initialize()
  let media = File.createFromPath(f.audio)
  try {
    assert.equal(media.tag.title, 'Complete')
  } finally {
    media.dispose()
  }
  copyFileSync(tagBackupPath(f.audio, f.backups), f.audio)
  const next = await f.selection()
  await f.service.writeTags({ selectionId: next.id, patch: { title: 'Interrupted' } })
  const journal = readTagWriteJournal(f.backups)
  journal.state = 'writing'
  writeFileSync(getTagWriteJournalPath(f.backups), JSON.stringify(journal))
  await f.service.initialize()
  media = File.createFromPath(f.audio)
  try {
    assert.equal(media.tag.title, undefined)
  } finally {
    media.dispose()
  }
  assert.equal(readTagWriteJournal(f.backups).state, 'rolledBack')
  assert.deepEqual(readFileSync(f.audio), f.wave)
})

test('reset keeps its SQL revision fence and never removes source files', async (t) => {
  const f = fixture(t),
    before = f.database.getMetadata()
  await assert.rejects(f.service.reset(before.revision - 1), /发生变化/)
  assert.equal(f.database.getMetadata().trackCount, 2)
  const result = await f.service.reset(before.revision)
  assert.equal(result.removedTracks, 2)
  assert.equal(result.removedFiles, 1)
  assert.equal(f.database.getMetadata().trackCount, 0)
  assert.equal(existsSync(f.audio), true)
})
