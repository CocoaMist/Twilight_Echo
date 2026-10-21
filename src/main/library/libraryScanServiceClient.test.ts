import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'
import type {
  LocalLibraryScanWorkerMessage,
  LocalLibraryWorkerScanRequest
} from '../../shared/localLibraryScan.ts'

class ManualUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = []
  killCount = 0

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  kill(): void {
    this.killCount += 1
    this.emit('exit', 0)
  }
}

const scanRequest: LocalLibraryWorkerScanRequest = {
  mode: 'startup',
  roots: ['C:\\Music'],
  knownIdentities: [],
  knownTrackPaths: [],
  excludedPaths: [],
  coverCacheDir: 'C:\\Covers'
}

test('database pause during worker startup is delivered after the scan request and suspends its watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = new ManualUtilityProcess()
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: { utilityProcess: { fork: () => child } }
  })
  t.after(() => client.destroy())
  const pending = client.scanDatabase(
    'starting-database',
    'C:/Covers',
    {} as Parameters<typeof client.scanDatabase>[2]
  )
  const rejected = assert.rejects(pending, /stopped/)
  client.pause('starting-database')
  child.emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(child.messages, [
    {
      kind: 'scan-database',
      requestId: 'starting-database',
      coverCacheDir: 'C:/Covers',
      forceParse: false
    },
    { kind: 'pause', requestId: 'starting-database' }
  ])
  t.mock.timers.tick(500)
  assert.equal(child.killCount, 0)
  client.destroy()
  await rejected
})

test('resuming a database startup replaces its pending pause without admitting a competing scan', async (t) => {
  const child = new ManualUtilityProcess()
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: { utilityProcess: { fork: () => child } }
  })
  t.after(() => client.destroy())
  const database = {} as Parameters<typeof client.scanDatabase>[2]
  const pending = client.scanDatabase('starting-database', 'C:/Covers', database)
  const rejected = assert.rejects(pending, /stopped/)
  client.pause('starting-database')
  client.resume('starting-database')
  await assert.rejects(client.scanDatabase('other', 'C:/Covers', database), /already scanning/)
  const legacyRejected = assert.rejects(client.scan('legacy', scanRequest), /already using/)
  child.emit('message', { kind: 'ready' })
  await legacyRejected
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(child.messages, [
    {
      kind: 'scan-database',
      requestId: 'starting-database',
      coverCacheDir: 'C:/Covers',
      forceParse: false
    }
  ])
  client.destroy()
  await rejected
})

test('a failed database startup releases its reservation for the next legacy scan', async (t) => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  t.after(() => client.destroy())
  const pending = client.scanDatabase(
    'starting-database',
    'C:/Covers',
    {} as Parameters<typeof client.scanDatabase>[2]
  )
  const rejected = assert.rejects(pending, /exited/)
  children[0].emit('exit', 1)
  await rejected
  const legacy = client.scan('legacy', scanRequest)
  const legacyRejected = assert.rejects(legacy, /stopped/)
  children[1].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[1].messages, [
    { kind: 'scan', requestId: 'legacy', request: scanRequest }
  ])
  client.destroy()
  await legacyRejected
})

test('cancelling a database worker before ready releases startup immediately without sending a scan', async (t) => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  t.after(() => client.destroy())
  const abort = new AbortController()
  const pending = client.scanDatabase(
    'starting-database',
    'C:/Covers',
    {} as Parameters<typeof client.scanDatabase>[2],
    undefined,
    undefined,
    abort.signal
  )
  const rejected = assert.rejects(pending, /cancelled|stopped/)
  abort.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(children[0].killCount, 1)
  assert.deepEqual(children[0].messages, [])
  await rejected
  const legacy = client.scan('legacy', scanRequest)
  const legacyRejected = assert.rejects(legacy, /stopped/)
  children[1].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[1].messages, [
    { kind: 'scan', requestId: 'legacy', request: scanRequest }
  ])
  client.destroy()
  await legacyRejected
})

test('repair reserves the metadata process before startup and aborting startup does not hang or replay', async () => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  const abort = new AbortController()
  const repair = client.scanRepair('repair', 'C:/Music', 'C:/Covers', async () => {}, abort.signal)
  const repairRejected = assert.rejects(repair, /已取消/)
  abort.abort()
  await repairRejected
  assert.equal(children[0].killCount, 1)
  assert.equal(children[0].messages.length, 0)
  const next = client.scan('normal', scanRequest)
  const nextRejected = assert.rejects(next, /stopped/)
  children[1].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(children.length, 2)
  assert.deepEqual(children[1].messages, [
    { kind: 'scan', requestId: 'normal', request: scanRequest }
  ])
  client.destroy()
  await nextRejected
})

test('legacy and database scans cannot interrupt an active repair or enqueue competing work', async () => {
  const child = new ManualUtilityProcess()
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: { utilityProcess: { fork: () => child } }
  })
  const repair = client.scanRepair('repair', 'C:/Music', 'C:/Covers', async () => {})
  child.emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(client.scan('legacy', scanRequest), /already using/)
  await assert.rejects(
    client.scanDatabase('db', 'C:/Covers', {} as Parameters<typeof client.scanDatabase>[2]),
    /already scanning/
  )
  assert.equal(child.messages.length, 1)
  child.emit('message', { kind: 'repair-result', requestId: 'repair' })
  await repair
  client.destroy()
})

test('local library scan service forks on its first scan, then waits for ready', async () => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })

  assert.equal(children.length, 0)
  const pending = client.scan('startup-job', scanRequest)
  assert.equal(children.length, 1)
  assert.equal(children[0].messages.length, 0)

  children[0].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[0].messages, [
    { kind: 'scan', requestId: 'startup-job', request: scanRequest }
  ])

  children[0].emit('message', {
    kind: 'response',
    requestId: 'startup-job',
    ok: true,
    value: {
      mode: 'startup',
      completeIdentitySnapshot: true,
      identities: [],
      parsedTracks: [],
      parsedFilePaths: [],
      removedFilePaths: [],
      skippedUnchanged: 0,
      parsedFileCount: 0,
      cancelled: false
    }
  } satisfies LocalLibraryScanWorkerMessage)

  assert.equal((await pending).cancelled, false)
  client.destroy()
})

test('local library scan service rejects first scans when utilityProcess is unavailable', async () => {
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {}
  })

  await assert.rejects(client.scan('unavailable-job', scanRequest), /utilityProcess is unavailable/)
  client.destroy()
})

test('local library scan service restarts a stalled worker and skips its active paths', async () => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })

  let resetCount = 0
  const pending = client.scan('stalled-job', scanRequest, undefined, undefined, undefined, () => {
    resetCount += 1
  })
  children[0].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  children[0].emit('message', {
    kind: 'activity',
    requestId: 'stalled-job',
    activity: { filePaths: ['C:\\Music\\stalled.mp3'] }
  } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.equal(children.length, 2)
  assert.equal(resetCount, 1)
  children[1].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[1].messages[0], {
    kind: 'scan',
    requestId: 'stalled-job',
    request: { ...scanRequest, skipParsePaths: ['C:\\Music\\stalled.mp3'] }
  })
  children[1].emit('message', {
    kind: 'response',
    requestId: 'stalled-job',
    ok: true,
    value: {
      mode: 'startup',
      completeIdentitySnapshot: true,
      identities: [],
      parsedTracks: [],
      parsedFilePaths: [],
      removedFilePaths: [],
      skippedUnchanged: 0,
      parsedFileCount: 0,
      cancelled: false,
      skippedFilePaths: ['C:\\Music\\stalled.mp3']
    }
  } satisfies LocalLibraryScanWorkerMessage)

  assert.equal((await pending).cancelled, false)
  client.destroy()
})

test('streaming recovery retains completed batches instead of resetting the library', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  t.after(() => client.destroy())
  let resets = 0
  const batches: unknown[] = []
  const pending = client.scan(
    'resume-job',
    { ...scanRequest, streamResults: true },
    undefined,
    (batch) => batches.push(batch),
    undefined,
    () => {
      resets++
    }
  )
  children[0].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  const identities = ['done.mp3', 'stalled.mp3', 'remaining.mp3'].map((name) => ({
    filePath: `C:\\Music\\${name}`,
    size: 10,
    mtimeMs: 1
  }))
  children[0].emit('message', {
    kind: 'identity-batch',
    requestId: 'resume-job',
    batch: { identities }
  } satisfies LocalLibraryScanWorkerMessage)
  children[0].emit('message', {
    kind: 'batch',
    requestId: 'resume-job',
    batch: {
      parsedTracks: [{ filePath: identities[0].filePath }],
      parsedFilePaths: [identities[0].filePath]
    }
  } satisfies LocalLibraryScanWorkerMessage)
  children[0].emit('message', {
    kind: 'activity',
    requestId: 'resume-job',
    activity: { filePaths: [identities[1].filePath] }
  } satisfies LocalLibraryScanWorkerMessage)
  t.mock.timers.tick(101)
  assert.equal(children.length, 2)
  children[1].emit('message', { kind: 'ready' })
  assert.equal(resets, 0)
  assert.equal(batches.length, 1)
  assert.deepEqual(children[1].messages[0], {
    kind: 'scan',
    requestId: 'resume-job',
    request: {
      ...scanRequest,
      streamResults: true,
      skipParsePaths: [identities[1].filePath],
      resumeCheckpoint: {
        identities,
        completeIdentitySnapshot: true,
        completedFilePaths: [identities[0].filePath],
        parsedFileCount: 1
      }
    }
  })
  client.cancel('resume-job')
  assert.equal((await pending).cancelled, true)
})

test('paused scans do not restart when progress arrives or the watchdog interval elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  t.after(() => client.destroy())
  const pending = client.scan('pause-job', scanRequest)
  children[0].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  client.pause('pause-job')
  children[0].emit('message', {
    kind: 'activity',
    requestId: 'pause-job',
    activity: { filePaths: ['C:\\Music\\slow.mp3'] }
  } satisfies LocalLibraryScanWorkerMessage)
  t.mock.timers.tick(60_000)
  assert.equal(children.length, 1)
  assert.equal(children[0].killCount, 0)
  client.resume('pause-job')
  t.mock.timers.tick(101)
  assert.equal(children.length, 2)
  client.cancel('pause-job')
  assert.equal((await pending).cancelled, true)
})

test('local library scan worker is reclaimed after idling and re-forked by the next scan', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    idleTimeoutMs: 1000,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  const completed = {
    mode: 'startup' as const,
    completeIdentitySnapshot: true,
    identities: [],
    parsedTracks: [],
    parsedFilePaths: [],
    removedFilePaths: [],
    skippedUnchanged: 0,
    parsedFileCount: 0,
    cancelled: false
  }

  const first = client.scan('first-job', scanRequest)
  children[0].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  children[0].emit('message', {
    kind: 'response',
    requestId: 'first-job',
    ok: true,
    value: completed
  } satisfies LocalLibraryScanWorkerMessage)
  await first
  assert.equal(children[0].killCount, 0, 'the worker stays warm right after a scan')

  t.mock.timers.tick(999)
  assert.equal(children[0].killCount, 0)
  t.mock.timers.tick(1)
  assert.equal(children[0].killCount, 1, 'the idle worker is killed after the timeout')

  const second = client.scan('second-job', scanRequest)
  assert.equal(children.length, 2, 'the next scan forks a fresh worker')
  children[1].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[1].messages, [
    { kind: 'scan', requestId: 'second-job', request: scanRequest }
  ])
  children[1].emit('message', {
    kind: 'response',
    requestId: 'second-job',
    ok: true,
    value: completed
  } satisfies LocalLibraryScanWorkerMessage)
  assert.equal((await second).cancelled, false)
  client.destroy()
})
