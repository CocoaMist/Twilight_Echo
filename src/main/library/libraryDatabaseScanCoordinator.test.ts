import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LibraryDatabaseServiceClient } from './libraryDatabaseServiceClient.ts'
import { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'
import {
  LibraryDatabaseScanCoordinator,
  type DatabaseScanStatus
} from './libraryDatabaseScanCoordinator.ts'

async function fixture(t: test.TestContext, count = 300) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-scan-workers-'))
  const children: ChildProcess[] = [],
    scanners: ChildProcess[] = []
  const spawn = (entry: string) => {
    const child = fork(entry, [], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    children.push(child)
    return {
      postMessage: (message: object) => {
        child.send(message)
      },
      kill: () => {
        child.kill()
      },
      on: child.on.bind(child)
    }
  }
  const database = new LibraryDatabaseServiceClient({
    serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
    libraryFilePath: join(root, 'music-library.json'),
    fork: spawn
  })
  const scanner = new LocalLibraryScanServiceClient({
    serviceEntry: fileURLToPath(new URL('./libraryScanService.ts', import.meta.url)),
    electron: {
      utilityProcess: {
        fork: (entry) => {
          const adapter = spawn(entry)
          scanners.push(children.at(-1)!)
          return adapter
        }
      }
    }
  })
  t.after(async () => {
    scanner.destroy()
    database.destroy()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('sqlite-scan-workers-'))
    rmSync(root, { recursive: true, force: true })
  })
  await database.updateConfiguration({ folders: [root], exclusions: [] })
  const wave = Buffer.alloc(44 + 48_000)
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
  wave.writeUInt32LE(48_000, 40)
  for (let i = 0; i < count; i++)
    writeFileSync(join(root, `${String(i).padStart(4, '0')}.wav`), wave)
  writeFileSync(
    join(root, 'disc.cue'),
    'FILE "0000.wav" WAVE\nTRACK 01 AUDIO\nTITLE "First"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Second"\nINDEX 01 00:01:00\n'
  )
  const coordinator = new LibraryDatabaseScanCoordinator({
    database,
    scanner,
    coverCacheDir: join(root, 'covers'),
    log() {}
  })
  return { root, database, scanner, scanners, coordinator }
}

test(
  'actual workers expose committed playable CUE tracks, pause/cancel, and resume without rereading completed metadata',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, database, root } = await fixture(t)
    let paused!: Promise<boolean>
    let first = true
    const commit = database.commitScanBatch.bind(database)
    const committed = new Promise<void>((resolve) => {
      database.commitScanBatch = async (batch) => {
        const result = await commit(batch)
        if (first) {
          first = false
          // Pause before returning this batch's ACK, not after a progress IPC
          // races the next claim. Under load the one-second batch may be <256.
          paused = coordinator.pause()
          await paused
          resolve()
        }
        return result
      }
    })
    const pending = coordinator.start('full', [root])
    await committed
    assert.equal(await paused, true)
    const snapshot = coordinator.getStatus()!
    assert.equal(snapshot.state, 'paused')
    const page = await database.queryTracks({ limit: 200 })
    assert.ok(page.total > 0 && page.total < 301)
    assert.equal(page.tracks.length, Math.min(200, page.total))
    assert.ok(
      page.tracks.every((track) => Number(track.duration) > 0 && typeof track.filePath === 'string')
    )
    coordinator.cancel()
    assert.equal((await pending).progress.state, 'cancelled')
    assert.equal(
      await coordinator.recoverInterruptedScan(),
      null,
      'user cancellation must not auto-resume'
    )
    const resumed = await coordinator.continueScan(snapshot.jobId)
    assert.equal(resumed.progress.trackCount, 301)
    assert.equal(resumed.progress.parsedFiles, 300, 'committed files must not be parsed twice')
    const cue = await database.queryTracks({ search: 'Second' })
    assert.equal(cue.total, 1)
    assert.equal((cue.tracks[0].cueRange as { startSeconds: number }).startSeconds, 1)
    const unchanged = await coordinator.start('startup', [root])
    assert.equal(unchanged.progress.parsedFiles, 0)
    assert.equal(unchanged.progress.trackCount, 301)
    const plain = await database.queryTracks({ search: '0001', searchFileName: true })
    const plainId = plain.tracks[0].id
    const plainVersion = plain.versions[plainId]
    writeFileSync(
      join(root, 'disc.cue'),
      'FILE "0000.wav" WAVE\nTRACK 01 AUDIO\nTITLE "First"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Second edited"\nINDEX 01 00:02:00\n'
    )
    const edited = await coordinator.start('watch', [root])
    assert.equal(edited.progress.parsedFiles, 0, 'CUE edits reuse the physical audio metadata')
    const nextCue = await database.getTracksByIds([cue.tracks[0].id])
    assert.equal(nextCue.tracks[0].title, 'Second edited')
    assert.equal((nextCue.tracks[0].cueRange as { startSeconds: number }).startSeconds, 2)
    assert.equal((await database.getTracksByIds([plainId])).versions[plainId], plainVersion)
    rmSync(join(root, 'disc.cue'))
    const removed = await coordinator.start('watch', [root])
    assert.equal(removed.progress.parsedFiles, 0, 'removing a CUE does not reread audio tags')
    assert.equal(removed.progress.trackCount, 300)
    const physical = await database.queryTracks({ search: '0000', searchFileName: true })
    assert.equal(physical.total, 1)
    assert.equal(physical.tracks[0].cueRange, undefined)
    assert.equal(physical.tracks[0].duration, 3)
    const forced = await coordinator.start('full', [root])
    assert.equal(forced.progress.parsedFiles, 300)
  }
)

test(
  'a CUE changed before commit is reindexed instead of retrying a stale in-memory definition',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, database, root } = await fixture(t, 2)
    const commit = database.commitScanBatch.bind(database)
    let changed = false
    database.commitScanBatch = async (batch) => {
      if (!changed) {
        changed = true
        writeFileSync(
          join(root, 'disc.cue'),
          'FILE "0000.wav" WAVE\nTRACK 01 AUDIO\nTITLE "Latest definition"\nINDEX 01 00:00:00\n'
        )
      }
      return commit(batch)
    }
    const result = await coordinator.start('startup', [root])
    assert.equal(result.progress.state, 'completed')
    assert.equal(result.progress.trackCount, 2)
    assert.equal((await database.queryTracks({ search: 'Latest definition' })).total, 1)
  }
)

test(
  'actual workers pause and resume one live job without losing claimed work',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, root } = await fixture(t)
    let requested = false
    let confirm!: (value: boolean) => void
    const paused = new Promise<boolean>((resolve) => {
      confirm = resolve
    })
    coordinator.on('status', (status: DatabaseScanStatus) => {
      if (!requested && status.phase === 'committing' && status.committedFiles >= 256) {
        requested = true
        void coordinator.pause().then(confirm)
      }
    })
    const pending = coordinator.start('full', [root])
    assert.equal(await paused, true)
    assert.equal(coordinator.getStatus()?.state, 'paused')
    assert.equal(await coordinator.resume(), true)
    const result = await pending
    assert.equal(result.progress.state, 'completed')
    assert.equal(result.progress.parsedFiles, 300)
    assert.equal(result.progress.trackCount, 301)
  }
)

test(
  'pausing the initial checking status survives worker startup without polling the database while paused',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, database, scanner, root } = await fixture(t, 2)
    let requested = false,
      claims = 0,
      confirm!: (value: boolean) => void,
      firstClaim!: () => void
    const claimed = new Promise<void>((resolve) => {
      firstClaim = resolve
    })
    const claim = database.claimScanFiles.bind(database)
    t.mock.method(database, 'claimScanFiles', async (id: string, limit?: number) => {
      claims++
      const result = await claim(id, limit)
      firstClaim()
      return result
    })
    const paused = new Promise<boolean>((resolve) => {
      confirm = resolve
    })
    coordinator.on('status', (status: DatabaseScanStatus) => {
      if (!requested && status.state === 'running') {
        requested = true
        void coordinator.pause().then(confirm)
      }
    })
    const ready = once(scanner, 'ready')
    const pending = coordinator.start('full', [root])
    void pending.catch(() => {})
    assert.equal(await paused, true)
    await ready
    await claimed
    const pausedClaims = claims
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      claims,
      pausedClaims,
      'a paused cold worker must wait rather than spin on SQLite claims'
    )
    assert.equal(coordinator.getStatus()?.state, 'paused')
    assert.equal(await coordinator.resume(), true)
    assert.equal((await pending).progress.trackCount, 3)
  }
)

test(
  'adding an ambiguous CUE before commit invalidates the directory projection',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, database, root } = await fixture(t, 2)
    const commit = database.commitScanBatch.bind(database)
    let changed = false
    database.commitScanBatch = async (batch) => {
      if (!changed) {
        changed = true
        writeFileSync(
          join(root, 'other.cue'),
          'FILE "0000.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'
        )
      }
      return commit(batch)
    }
    const result = await coordinator.start('startup', [root])
    assert.equal(result.progress.state, 'completed')
    assert.equal(result.progress.trackCount, 2)
    const page = await database.queryTracks()
    assert.ok(page.tracks.every((track) => !track.cueRange))
  }
)

test(
  'killing the metadata process preserves committed batches and explicit restart recovery skips them',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, database, root, scanners } = await fixture(t)
    let killed = false
    coordinator.on('status', (status: DatabaseScanStatus) => {
      if (!killed && status.phase === 'committing' && status.committedFiles >= 256) {
        killed = true
        scanners.at(-1)!.kill()
      }
    })
    await assert.rejects(coordinator.start('full', [root]), /exited|stopped/)
    assert.equal(coordinator.getStatus()?.state, 'interrupted')
    assert.ok((await database.getMetadata()).trackCount >= 256)
    const recovered = await coordinator.recoverInterruptedScan()
    assert.equal(recovered?.progress.state, 'completed')
    assert.equal(recovered?.progress.parsedFiles, 300)
    assert.equal(recovered?.progress.trackCount, 301)
  }
)

test(
  'cancellation after finalization commits reports completion instead of an invalid transition',
  { timeout: 30_000 },
  async (t) => {
    const { coordinator, database, root } = await fixture(t, 2)
    const finish = database.finishScan.bind(database)
    database.finishScan = async (id) => {
      const result = await finish(id)
      coordinator.cancel()
      return result
    }
    const result = await coordinator.start('startup', [root])
    assert.equal(result.cancelled, false)
    assert.equal(result.progress.state, 'completed')
    assert.equal(result.progress.trackCount, 3)
  }
)

test(
  'actual scan workers lazily read dense CUE definitions within the RPC bound and preserve old tracks on a lost cache read',
  { timeout: 30_000 },
  async (t) => {
    const count = 24
    const { coordinator, database, root } = await fixture(t, count)
    for (let i = 1; i < count; i++)
      writeFileSync(
        join(root, `${i}.cue`),
        `FILE "${String(i).padStart(4, '0')}.wav" WAVE\nTRACK 01 AUDIO\nTITLE "First"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Second"\nINDEX 01 00:01:00\n`
      )
    const get = database.getScanCueDefinition.bind(database)
    let active = 0,
      peak = 0,
      calls = 0,
      loseDefinition = false
    const perPath = new Map<string, number>()
    database.getScanCueDefinition = async (id, identity) => {
      calls++
      const read = (perPath.get(identity.filePath) ?? 0) + 1
      perPath.set(identity.filePath, read)
      peak = Math.max(peak, ++active)
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
        if (loseDefinition && basename(identity.filePath) === 'disc.cue' && read > 1) return null
        return await get(id, identity)
      } finally {
        active--
      }
    }
    const first = await coordinator.start('full', [root])
    assert.equal(first.progress.trackCount, count * 2)
    assert.equal(first.progress.failedFiles, 0)
    assert.equal(calls, count * 2)
    assert.equal(peak, 1, 'four parsers must not exceed the existing scan-session allowance')
    const cue = await database.queryTracks({ search: 'Second' })
    assert.equal(cue.total, count)
    perPath.clear()
    loseDefinition = true
    const failed = await coordinator.start('full', [root])
    assert.equal(failed.progress.trackCount, count * 2)
    assert.equal(failed.progress.failedFiles, 1)
    assert.deepEqual(
      (await database.getTracksByIds(cue.tracks.map((track) => track.id))).tracks
        .map((track) => track.id)
        .sort(),
      cue.tracks.map((track) => track.id).sort()
    )
    loseDefinition = false
    const retried = await coordinator.start('startup', [root])
    assert.equal(retried.progress.failedFiles, 0)
    assert.equal(retried.progress.trackCount, count * 2)
    assert.equal((await database.queryTracks({ search: 'Second' })).total, count)
  }
)
