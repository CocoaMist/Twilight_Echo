import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LibraryDatabaseScanSession,
  LibraryScanInterruptedError
} from './libraryDatabaseScanSession.ts'
import type {
  LibraryScanDatabaseApi,
  LibraryScanProgressSnapshot
} from '../../shared/libraryDatabase.ts'
import type {
  LocalLibraryScanWorkerMessage,
  LocalLibraryScanWorkerRequest
} from '../../shared/localLibraryScan.ts'

const snapshot: LibraryScanProgressSnapshot = {
  jobId: 'job',
  state: 'running',
  checkedFiles: 1,
  parsedFiles: 0,
  committedFiles: 0,
  failedFiles: 0,
  trackCount: 0,
  revision: 0
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('cancellation waits for an already-dispatched commit and returns its authoritative counters', async () => {
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const progress = { ...snapshot }
  const sent: LocalLibraryScanWorkerRequest[] = []
  let killed = 0
  const db = {
    commitScanBatch: async () => {
      entered()
      await gate
      progress.trackCount = progress.committedFiles = progress.parsedFiles = 1
      progress.revision = 1
    },
    getScanProgress: async () => progress
  } as unknown as LibraryScanDatabaseApi
  const session = new LibraryDatabaseScanSession(
    'job',
    db,
    (message) => sent.push(message),
    () => {
      killed++
    },
    60_000
  )
  session.handle({
    kind: 'database-call',
    requestId: 'job',
    callId: 1,
    call: {
      method: 'commitScanBatch',
      args: [{ jobId: 'job', sequence: 1, files: [] }]
    }
  })
  await started
  session.cancel()
  assert.equal(killed, 1)
  release()
  const result = await session.result
  assert.equal(result.cancelled, true)
  assert.equal(result.progress.trackCount, 1)
  assert.equal(sent.length, 0, 'a dead scan process receives no acknowledgement')
})

test('the scan bridge rejects another job and never forwards privileged database methods', async () => {
  let calls = 0
  const db = {
    getScanProgress: async () => {
      calls++
      return snapshot
    }
  } as unknown as LibraryScanDatabaseApi
  for (const call of [
    { method: 'getScanProgress', args: ['other'] },
    { method: 'replaceDocument', args: [{ tracks: [] }] }
  ]) {
    const session = new LibraryDatabaseScanSession(
      'job',
      db,
      () => {},
      () => {},
      60_000
    )
    const rejected = assert.rejects(session.result, LibraryScanInterruptedError)
    session.handle({
      kind: 'database-call',
      requestId: 'job',
      callId: 1,
      call
    } as LocalLibraryScanWorkerMessage)
    await rejected
  }
  assert.equal(calls, 0)
})

test('slow SQLite acknowledgements and deliberate pauses cannot trigger the metadata watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: () => void,
    killed = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const db = {
    getScanProgress: async () => {
      await gate
      return snapshot
    }
  } as unknown as LibraryScanDatabaseApi
  const session = new LibraryDatabaseScanSession(
    'job',
    db,
    () => {},
    () => {
      killed++
    },
    100
  )
  const rejected = assert.rejects(session.result, /stopped responding/)
  session.handle({
    kind: 'database-call',
    requestId: 'job',
    callId: 1,
    call: { method: 'getScanProgress', args: ['job'] }
  })
  t.mock.timers.tick(10_000)
  assert.equal(killed, 0)
  release()
  await tick()
  session.pause()
  t.mock.timers.tick(10_000)
  assert.equal(killed, 0)
  session.resume()
  t.mock.timers.tick(101)
  await rejected
  assert.equal(killed, 1)
})
