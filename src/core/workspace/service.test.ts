import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreWorkspaceService, type CoreWorkspaceOptions } from './service.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import { captureQueueSession } from './tracks.ts'
import {
  isQueueWorkspaceDocument,
  type QueueWorkspaceDocument
} from '../../shared/queueWorkspace.ts'
import type { TrackData } from '../../shared/track.ts'
import { createDefaultPlaybackInfo } from '../../main/audio/audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../../shared/audioOutputConfig.ts'

const track = (occurrence = 'first'): TrackData => ({
  id: 'cue',
  queueEntryId: occurrence,
  source: 'local',
  title: 'CUE',
  artist: 'Artist',
  album: 'Disc',
  filePath: 'D:/Music/disc.flac',
  fileName: 'disc.flac',
  duration: 30,
  size: 1000,
  cueRange: { startSeconds: 30, endSeconds: 60, pregapSeconds: 0 },
  cover: null,
  lyrics: null
})
const runtime = { now: () => Date.parse('2026-10-22T00:00:00Z'), newId: () => 'session' }
const info = (state: 'playing' | 'paused' | 'stopped', position = 0, serial = 0) => ({
  ...createDefaultPlaybackInfo('wasapi', '', false, normalizeOutputConfig()),
  state,
  position,
  naturalBoundaries: { trackSerial: serial, queueSerial: 0, trackTimeMs: 0, queueTimeMs: 0 }
})
async function fixture(
  t: test.TestContext,
  options: {
    legacy?: QueueWorkspaceDocument
    sync?: (owner: string, ids: string[]) => Promise<void>
    capture?: CoreWorkspaceOptions['capture']
    save?: CoreWorkspaceOptions['repository']['saveQueueWorkspace']
    restore?: CoreWorkspaceOptions['restore']
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-workspace-'))
  const file = join(root, 'queue-workspace.json')
  if (options.legacy) await writeFile(file, JSON.stringify(options.legacy))
  const repository = new VersionedDataStore<QueueWorkspaceDocument>({
    filePath: file,
    label: 'workspace',
    maxBytes: 32 * 1024 * 1024,
    isData: isQueueWorkspaceDocument,
    isLegacy: isQueueWorkspaceDocument
  })
  let serial = 0
  const service = new CoreWorkspaceService({
    repository: {
      loadQueueWorkspace: () => repository.load(),
      saveQueueWorkspace:
        options.save ?? ((document, revision) => repository.save(document, revision)),
      syncQueueReferences: options.sync
    },
    capture:
      options.capture ??
      (async () => ({
        reference: { id: 'queue', revision: 3, index: 10, entryId: 'duplicate:second' },
        position: 42,
        mode: 'shuffle'
      })),
    restore:
      options.restore ??
      (async () => {
        throw new Error('Not used by this fixture')
      }),
    now: runtime.now,
    newId: () => `id:${++serial}`,
    timers: {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    changed() {},
    failed: (error) => {
      throw error
    }
  })
  await service.initialize()
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  const history = () =>
    service.history({
      revision: service.getRevision(),
      contentRevision: service.getContentRevision()
    })
  const sessions = () =>
    service.sessions({
      revision: service.getRevision(),
      contentRevision: service.getContentRevision()
    })
  return { service, history, sessions, repository, file }
}

test('one observer records actual starts, duplicate occurrences, natural repeats and explicit attempts but not pause/resume or queries', async (t) => {
  const f = await fixture(t)
  f.service.observe(track(), info('paused', 20))
  assert.equal(f.history().total, 0)
  f.service.observe(track(), info('playing'))
  f.service.observe(track(), info('playing', 10))
  f.service.observe(track(), info('paused', 10))
  f.service.observe(track(), info('playing', 10))
  f.service.observe(track('second'), info('playing'))
  f.service.observe(track('second'), info('playing', 0, 1))
  f.service.observe(track('second'), info('playing', 1, 1))
  f.service.beginAttempt()
  f.service.observe(track('second'), info('playing', 0, 1))
  f.service.observe(track('second'), info('stopped', 0, 1))
  f.service.observe(track('second'), info('playing', 0, 1))
  assert.deepEqual(
    f.history().items.map((item) => item.track.queueEntryId),
    ['first', 'second', 'second', 'second', 'second']
  )
  f.service.history({
    revision: f.service.getRevision(),
    contentRevision: f.service.getContentRevision()
  })
  await f.service.flush()
  const disk = (await f.repository.load())!
  assert.equal(disk.data.history.length, 5)
  assert.equal(disk.data.history[0].track.filePath, 'D:/Music/disc.flac')
  assert.deepEqual(disk.data.history[0].track.cueRange, track().cueRange)
  assert.doesNotMatch(JSON.stringify(f.history()), /filePath|streamUrl|networkSource/)
})

test('queue-only occurrence rebind keeps the actual listening attempt; the next real occurrence still records', async (t) => {
  const f = await fixture(t)
  f.service.observe(track('recommendation'), info('playing', 15))
  f.service.rebindOccurrence(track('recommendation'), track('base'))
  f.service.observe(track('base'), info('playing', 15))
  assert.equal(f.history().total, 1)
  f.service.observe(track('next'), info('playing'))
  assert.equal(f.history().total, 2)
  f.service.beginAttempt()
  f.service.rebindOccurrence(track('next'), track('other'))
  f.service.observe(track('other'), info('playing'))
  assert.equal(f.history().total, 3)
})

test('legacy array sessions and actual order keep complete identities on disk while public queries stay bounded', async (t) => {
  const session = captureQueueSession(
    runtime,
    'Before',
    [track('second'), track()],
    [track(), track('second')],
    track('second'),
    12,
    'shuffle'
  )
  const legacy: QueueWorkspaceDocument = { version: 1, sessions: [session], history: [] }
  const f = await fixture(t, { legacy })
  assert.deepEqual((await f.repository.load())!.data, legacy)
  assert.equal(f.sessions().items[0].count, 2)
  assert.equal(f.sessions().items[0].storage, 'entries')
  assert.doesNotMatch(JSON.stringify(f.sessions()), /filePath|originalEntryIds|"entries":/)
  await f.service.edit({ revision: 0, edit: { kind: 'rename', id: session.id, name: 'After' } })
  const disk = (await f.repository.load())!.data.sessions[0]
  assert.equal(disk.name, 'After')
  assert.deepEqual(disk.entries, session.entries)
  assert.deepEqual(disk.originalEntryIds, session.originalEntryIds)
  assert.equal(disk.createdAt, session.createdAt)
})

test('capture saves the authoritative queue reference and position, protecting GC ownership before disk publication', async (t) => {
  const syncs: string[][] = []
  const f = await fixture(t, {
    sync: async (owner, ids) => {
      assert.equal(owner, 'workspace')
      syncs.push([...ids])
    }
  })
  await f.service.edit({ revision: 0, edit: { kind: 'saveCurrent', name: 'Captured' } })
  const disk = (await f.repository.load())!.data.sessions[0]
  assert.deepEqual(disk.libraryQueue, {
    id: 'queue',
    revision: 3,
    index: 10,
    entryId: 'duplicate:second'
  })
  assert.equal(disk.position, 42)
  assert.equal(disk.playMode, 'shuffle')
  assert.deepEqual(disk.entries, [])
  assert.deepEqual(syncs, [[], ['queue'], ['queue']])
  assert.equal(f.sessions().items[0].storage, 'libraryQueue')
  await assert.rejects(
    f.service.edit({ revision: 0, edit: { kind: 'rename', id: disk.id, name: 'stale' } }),
    (e: { code: string }) => e.code === 'STALE_REVISION'
  )
  await f.service.edit({ revision: f.service.getRevision(), edit: { kind: 'remove', id: disk.id } })
  assert.equal(f.sessions().total, 0)
  assert.deepEqual(syncs.at(-1), [])
})

test('cancelled capture and concurrent old-revision edits do not publish extra sessions', async (t) => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const f = await fixture(t, {
    capture: async () => {
      await wait
      return {
        reference: { id: 'q', revision: 1, index: 0, entryId: 'one' },
        mode: 'sequential',
        position: 10
      }
    }
  })
  const controller = new AbortController()
  const cancelled = f.service.edit(
    { revision: 0, edit: { kind: 'saveCurrent', name: 'cancelled' } },
    controller.signal
  )
  controller.abort()
  finish()
  await assert.rejects(cancelled)
  assert.equal(await f.repository.load(), null)
  const results = await Promise.allSettled([
    f.service.edit({ revision: 0, edit: { kind: 'saveCurrent', name: 'one' } }),
    f.service.edit({ revision: 0, edit: { kind: 'saveCurrent', name: 'two' } })
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'STALE_REVISION')
  assert.equal(f.sessions().total, 1)
})

test('actual order keeps the original 200-entry cap and compact source identity; stale page windows are rejected', async (t) => {
  const f = await fixture(t)
  const old = f.service.state()
  for (let index = 0; index < 210; index++) {
    f.service.recordStart(
      {
        ...track(`q:${index}`),
        id: 'ncm:7',
        source: 'ncm',
        ncmSongId: 7,
        filePath: 'D:/Cache/expired.flac',
        streamUrl: 'https://private.invalid/?token=secret',
        lyrics: 'heavy'
      },
      'heart'
    )
  }
  assert.equal(f.history().total, 200)
  assert.equal(f.history().items[0].track.queueEntryId, 'q:10')
  assert.throws(
    () => f.service.history(old),
    (error: { code: string }) => error.code === 'STALE_REVISION'
  )
  await f.service.flush()
  const disk = JSON.parse(await readFile(f.file, 'utf8'))
  assert.equal(disk.data.history.at(-1).playMode, 'heart')
  assert.doesNotMatch(JSON.stringify(disk), /expired|streamUrl|secret|heavy/)
  assert.equal(disk.data.history.at(-1).track.ncmSongId, 7)
})

test('a failed session save retains its old owner and does not retry an unknown mutation', async (t) => {
  const syncs: string[][] = []
  let writes = 0
  const legacy: QueueWorkspaceDocument = {
    version: 1,
    history: [],
    sessions: [
      {
        id: 'old',
        name: 'Old',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        entries: [],
        originalEntryIds: [],
        currentEntryId: 'old-entry',
        position: 20,
        playMode: 'sequential',
        libraryQueue: { id: 'old-queue', revision: 1, index: 0, entryId: 'old-entry' }
      }
    ]
  }
  const f = await fixture(t, {
    legacy,
    sync: async (_owner, ids) => {
      syncs.push([...ids])
    },
    save: async () => {
      writes++
      throw Error('disk unavailable')
    }
  })
  await assert.rejects(
    f.service.edit({ revision: 0, edit: { kind: 'saveCurrent', name: 'New' } }),
    /disk unavailable/
  )
  assert.deepEqual(syncs, [['old-queue'], ['old-queue', 'queue']])
  assert.deepEqual((await f.repository.load())!.data, legacy)
  assert.equal(f.sessions().total, 1)
  await f.service.flush()
  assert.equal(writes, 1)
})

test('restore is revision fenced, returns bounded private-free issues, and history flushes do not cancel a pending selection', async (t) => {
  const saved = captureQueueSession(runtime, 'Legacy', [track()], [track()], track(), 12, 'repeat')
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let guard!: () => void
  const f = await fixture(t, {
    legacy: { version: 1, sessions: [saved], history: [] },
    restore: async (session, play, check) => {
      assert.equal(session.position, 12)
      assert.equal(play, false)
      guard = check
      await wait
      check()
      return {
        restored: 1,
        deferred: 0,
        missing: Array.from({ length: 250 }, () => ({ entry: saved.entries[0], reason: 'missing' }))
      }
    }
  })
  await assert.rejects(
    f.service.restore({ revision: 9, id: saved.id }),
    (error: { code: string }) => error.code === 'STALE_REVISION'
  )
  const restore = f.service.restore({ revision: f.service.getRevision(), id: saved.id })
  f.service.recordStart(track(), 'sequential')
  await f.service.flush()
  guard()
  release()
  const result = await restore
  assert.equal(result.unavailable, 250)
  assert.equal(result.issues.length, 200)
  assert.doesNotMatch(JSON.stringify(result), /filePath|cueRange/)
  await f.service.edit({
    revision: f.service.getRevision(),
    edit: { kind: 'rename', id: saved.id, name: 'Changed' }
  })
  assert.throws(guard, (error: { code: string }) => error.code === 'STALE_REVISION')
})
