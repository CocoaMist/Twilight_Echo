import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PlaybackSession } from '../core/types.ts'
import { PlaybackSessionStorage, isPlaybackQueueSnapshot } from './playbackSessionStorage.ts'
import { VersionedDataStore } from './versionedDataStore.ts'

const track = {
  id: 'local:one',
  queueEntryId: 'first',
  title: 'One',
  artist: 'Artist',
  album: 'Album',
  filePath: 'D:/Music/one.flac',
  fileName: 'one.flac',
  duration: 120,
  size: 1,
  cover: null,
  lyrics: null
}

function fixture(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-playback-session-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'playback-session.json')
  const queueFile = join(directory, 'playback-queue.json')
  const isSession = (value: unknown): value is PlaybackSession | null =>
    value === null ||
    (!!value && typeof value === 'object' && (value as PlaybackSession).version === 1)
  const stateStore = new VersionedDataStore<PlaybackSession | null>({
    filePath: stateFile,
    label: 'playback session',
    maxBytes: 2 * 1024 * 1024,
    isData: isSession,
    isLegacy: isSession
  })
  const queueStore = new VersionedDataStore<unknown[]>({
    filePath: queueFile,
    label: 'playback queue',
    maxBytes: 32 * 1024 * 1024,
    isData: isPlaybackQueueSnapshot,
    isLegacy: isPlaybackQueueSnapshot
  })
  return {
    stateFile,
    queueFile,
    stateStore,
    queueStore,
    storage: new PlaybackSessionStorage(stateStore, queueStore)
  }
}

test('large queues live outside the small state file and position writes leave the queue untouched', async (t) => {
  const { stateFile, queueFile, storage } = fixture(t)
  const queue = Array.from({ length: 7_000 }, (_, index) => ({
    ...track,
    id: `local:${index}`,
    queueEntryId: `entry:${index}`,
    title: `Track ${index} ${'x'.repeat(300)}`
  }))
  const session: PlaybackSession = {
    version: 1,
    savedAt: '2026-09-28T00:00:00.000Z',
    mode: 'trackAndPosition',
    track: queue[3],
    queue,
    queueIndex: 3,
    position: 12
  }
  assert.ok(Buffer.byteLength(JSON.stringify(session), 'utf8') > 2 * 1024 * 1024)

  const first = await storage.save(session, 0)
  assert.equal(first.data.queue, undefined)
  assert.ok(Buffer.byteLength(readFileSync(stateFile)) < 2 * 1024 * 1024)
  const firstQueueFile = readFileSync(queueFile, 'utf8')
  const second = await storage.save({ ...session, queue: undefined, position: 48 }, 1)
  assert.equal(second.data.position, 48)
  assert.equal(readFileSync(queueFile, 'utf8'), firstQueueFile)
  const restored = await storage.load()
  assert.equal(restored?.data?.position, 48)
  assert.equal(restored?.data?.queue?.length, 7_000)
  assert.equal((restored?.data?.queue?.[3] as typeof track).queueEntryId, 'entry:3')
})

test('the first state-only write migrates a legacy embedded queue', async (t) => {
  const { stateStore, storage } = fixture(t)
  const cue = { ...track, cueRange: { startSeconds: 0, endSeconds: 120, pregapSeconds: 0 } }
  const legacy: PlaybackSession = {
    version: 1,
    savedAt: '2026-09-28T00:00:00.000Z',
    mode: 'trackAndPosition',
    track: cue,
    queue: [cue],
    queueIndex: 0,
    position: 12
  }
  await stateStore.save(legacy, 0)
  const restoredLegacy = await storage.load()
  assert.deepEqual(restoredLegacy?.data?.queue, [cue])
  const migrated = await storage.save({ ...legacy, queue: undefined, position: 20 }, 1)
  assert.equal(migrated.data.queue, undefined)
  assert.equal(migrated.data.queueRevision, 1)
  assert.deepEqual((await storage.load())?.data?.queue, [cue])
})

test('an interrupted queue write restores the queue matching the committed state from backup', async (t) => {
  const { storage, queueStore } = fixture(t)
  const session: PlaybackSession = {
    version: 1,
    savedAt: '2026-09-28T00:00:00.000Z',
    mode: 'trackAndPosition',
    track,
    queue: [track],
    queueIndex: 0,
    position: 12
  }
  await storage.save(session, 0)
  await queueStore.save([{ ...track, id: 'local:other' }], 1)
  const restored = await storage.load()
  assert.deepEqual(restored?.data?.track, track)
  assert.deepEqual(restored?.data?.queue, [track])
  assert.equal(restored?.data?.queueRevision, 1)
  assert.equal(restored?.data?.queueIndex, 0)
  await storage.save({ ...session, queue: undefined, position: 20 }, 1)
  assert.deepEqual((await storage.load())?.data?.queue, [track])
})

test('a queue revision absent from both files falls back to the selected track', async (t) => {
  const { storage, queueStore } = fixture(t)
  const session: PlaybackSession = {
    version: 1,
    savedAt: '2026-09-28T00:00:00.000Z',
    mode: 'track',
    track,
    queue: [track],
    queueIndex: 0,
    position: 0
  }
  await storage.save(session, 0)
  await queueStore.save([{ ...track, id: 'local:other' }], 1)
  await queueStore.save([{ ...track, id: 'local:latest' }], 2)
  const restored = await storage.load()
  assert.deepEqual(restored?.data?.track, track)
  assert.equal(restored?.data?.queue, undefined)
  assert.equal(restored?.data?.queueRevision, undefined)
  assert.equal(restored?.data?.queueIndex, undefined)
})

test('clearing the session removes its queue and backup', async (t) => {
  const { storage, queueStore, queueFile } = fixture(t)
  const session: PlaybackSession = {
    version: 1,
    savedAt: '2026-09-28T00:00:00.000Z',
    mode: 'track',
    track,
    queue: [track],
    queueIndex: 0,
    position: 0
  }
  await storage.save(session, 0)
  await storage.clear(1)
  assert.equal((await storage.load())?.data, null)
  assert.equal(await queueStore.load(), null)
  assert.equal(existsSync(`${queueFile}.bak`), false)
})

test('clearing a session succeeds even if both queue copies are corrupt', async (t) => {
  const { storage, queueStore, queueFile } = fixture(t)
  const session: PlaybackSession = {
    version: 1,
    savedAt: '2026-09-28T00:00:00.000Z',
    mode: 'track',
    track,
    queue: [track],
    queueIndex: 0,
    position: 0
  }
  await storage.save(session, 0)
  writeFileSync(queueFile, '{')
  writeFileSync(`${queueFile}.bak`, '{')
  await storage.clear(1)
  assert.equal((await storage.load())?.data, null)
  assert.equal(await queueStore.load(), null)
})

test('switching arrays to a database session never inherits or reads the old queue file', async (t) => {
  const { storage, stateStore, queueFile } = fixture(t)
  const array: PlaybackSession = {
    version: 1,
    savedAt: '',
    mode: 'trackAndPosition',
    track,
    position: 15,
    queue: [track],
    queueIndex: 0
  }
  await storage.save(array, 0)
  const before = readFileSync(queueFile, 'utf8')
  const database: PlaybackSession = {
    version: 1,
    savedAt: '',
    mode: 'trackAndPosition',
    track,
    position: 40,
    libraryQueue: { id: 'database', revision: 6, entryId: 'first', index: 299_999 }
  }
  const saved = await storage.save(database, 1)
  assert.deepEqual(saved.data, database)
  assert.equal(readFileSync(queueFile, 'utf8'), before)
  writeFileSync(queueFile, '{corrupt old queue')
  assert.deepEqual((await storage.load())?.data, database)
  assert.equal((await stateStore.loadBackup())?.data?.queueRevision, 1)
  await storage.save({ ...database, position: 50 }, 2)
  assert.equal((await storage.load())?.data?.position, 50)
  await storage.save(array, 3)
  const restored = (await storage.load())!.data!
  assert.deepEqual(restored.queue, [track])
  assert.equal(restored.libraryQueue, undefined)
})

test('failed reference commits leave the prior array session and queue recoverable', async (t) => {
  const { storage, stateStore } = fixture(t)
  const array: PlaybackSession = {
    version: 1,
    savedAt: '',
    mode: 'track',
    track,
    position: 0,
    queue: [track]
  }
  await storage.save(array, 0)
  const save = stateStore.save.bind(stateStore)
  stateStore.save = async () => {
    throw new Error('disk full')
  }
  await assert.rejects(
    storage.save(
      {
        version: 1,
        savedAt: '',
        mode: 'track',
        track,
        position: 0,
        libraryQueue: { id: 'database', revision: 0, entryId: 'first', index: 0 }
      },
      1
    ),
    /disk full/
  )
  stateStore.save = save
  assert.deepEqual((await storage.load())?.data?.queue, [track])
  await assert.rejects(
    storage.save(
      { ...array, libraryQueue: { id: 'database', revision: 0, entryId: 'first', index: 0 } },
      1
    ),
    /Invalid playback session/
  )
  assert.deepEqual((await storage.load())?.data?.queue, [track])
})
