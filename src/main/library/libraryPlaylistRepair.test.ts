import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryPlaylistRepairService } from './libraryPlaylistRepairService.ts'
import { LibraryDatabaseServiceClient } from './libraryDatabaseServiceClient.ts'
import { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'
import { PlaylistRepairScanSession } from './playlistRepairScanSession.ts'
import { runPlaylistRepairScan } from './playlistRepairScanner.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type {
  LocalLibraryScanWorkerRequest,
  RepairScanCall
} from '../../shared/localLibraryScan.ts'
import { findPlaylistRelocations } from '../../renderer/src/utils/playlistLifecycle.ts'
import type { TrackData as Track } from '../../shared/track.ts'
import type { NativeAudioMetadata } from '../../shared/audioEngineTypes.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const record = (id: string, path = `E:/Moved/${id}.flac`, extra = {}): LibraryTrackRecord => ({
  id,
  filePath: path,
  title: id,
  artist: 'Artist',
  duration: 180,
  fileName: path.split('/').pop(),
  album: 'Album',
  size: 1,
  cover: null,
  lyrics: null,
  ...extra
})
class Owner extends EventEmitter {
  dead = false
  isDestroyed() {
    return this.dead
  }
  destroy() {
    this.dead = true
    this.emit('destroyed')
  }
}

test('disk candidate matching preserves exact-path, filename, metadata, ambiguity, duplicate-ID consumption and CUE semantics', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const candidates = [
    record('same-path', 'E:/Kept/exact.flac'),
    record('one', 'E:/Moved/a.flac', { title: 'Common' }),
    record('two', 'E:/Moved/b.flac', { title: 'Common' }),
    record('three', 'E:/Moved/c.flac', { title: 'Common' }),
    record('dup', 'E:/Moved/d.flac'),
    record('dup', 'E:/Moved/e.flac'),
    record('cue:1', 'E:/Moved/disc.wav', {
      title: 'First',
      duration: 30,
      subTrack: '1',
      cueRange: { startSeconds: 0, endSeconds: 30 },
      cueEncoding: 'utf-8'
    }),
    record('cue:2', 'E:/Moved/disc.wav', {
      title: 'Second',
      duration: 32,
      subTrack: '2',
      cueRange: { startSeconds: 30, endSeconds: 62 }
    }),
    record('amb:1', 'E:/a/amb.flac', { title: 'Amb' }),
    record('amb:2', 'E:/b/amb.flac', { title: 'Amb' })
  ].map(compactPlaylistRecord)
  const missing = [
    record('skip', 'e:\\kept\\EXACT.flac'),
    record('m1', 'D:/Old/a.flac'),
    record('m2', 'D:/Old/b.flac'),
    record('m3', 'D:/Old/renamed.flac', { title: ' common ', artist: ' ARTIST ', duration: 182 }),
    record('dup1', 'D:/Old/d.flac'),
    record('dup2', 'D:/Old/e.flac'),
    record('old-cue1', 'D:/Old/disc.wav', { title: 'First', duration: 29 }),
    record('old-cue2', 'D:/Old/disc.wav', { title: 'Second', duration: 33 }),
    record('amb', 'D:/Old/amb.flac', { title: 'Amb' }),
    record('gone', 'D:/Old/gone.flac')
  ]
  db.repairCandidates({ kind: 'begin', id: 'r' })
  db.repairCandidates({ kind: 'append', id: 'r', sequence: 1, tracks: candidates })
  assert.throws(
    () => db.repairCandidates({ kind: 'resolve', id: 'r', sequence: 2, missing }),
    /尚未完成/
  )
  db.repairCandidates({ kind: 'seal', id: 'r', sequence: 2 })
  const result = { relocations: [], unresolvedTrackIds: [], ambiguousTrackIds: [] } as ReturnType<
    typeof findPlaylistRelocations
  >
  let seq = 2
  for (let offset = 0; offset < missing.length; offset += 2) {
    const page = db.repairCandidates({
      kind: 'resolve',
      id: 'r',
      sequence: ++seq,
      missing: missing.slice(offset, offset + 2)
    }).result!
    result.relocations.push(...(page.relocations as unknown as typeof result.relocations))
    result.unresolvedTrackIds.push(...page.unresolvedTrackIds)
    result.ambiguousTrackIds.push(...page.ambiguousTrackIds)
  }
  assert.deepEqual(
    result,
    findPlaylistRelocations(missing as unknown as Track[], candidates as unknown as Track[])
  )
  assert.deepEqual(
    result.relocations.map((item) => item.toTrack.id),
    ['one', 'two', 'three', 'dup', 'cue:1', 'cue:2']
  )
  assert.equal(db.getMetadata().trackCount, 0)
  assert.equal(db.getMetadata().revision, 0)
  assert.equal(db.sql.prepare('PRAGMA temp_store').get()?.temp_store, 1)
  assert.equal(
    db.sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'repair_%'").get()?.n,
    0
  )
  assert.throws(
    () => db.repairCandidates({ kind: 'resolve', id: 'r', sequence: seq, missing: [] }),
    /批次已失效/
  )
  db.repairCandidates({ kind: 'close', id: 'r' })
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM repair_candidates').get()?.n, 0)
})

test('failed matching rolls back consumed IDs and candidate sessions vanish after database reopen', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'repair-index-')),
    path = join(root, 'library.sqlite')
  const db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.repairCandidates({ kind: 'begin', id: 'r' })
  db.repairCandidates({ kind: 'append', id: 'r', sequence: 1, tracks: [record('a'), record('b')] })
  db.repairCandidates({ kind: 'seal', id: 'r', sequence: 2 })
  db.sql.exec(
    "CREATE TEMP TRIGGER fail_repair BEFORE UPDATE OF used ON repair_candidates WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'disk full'); END"
  )
  assert.throws(
    () =>
      db.repairCandidates({
        kind: 'resolve',
        id: 'r',
        sequence: 3,
        missing: [record('old-a', 'D:/a.flac'), record('old-b', 'D:/b.flac')]
      }),
    /disk full/
  )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM repair_candidates WHERE used=1').get()?.n,
    0
  )
  db.close()
  const reopened = new LibraryDatabase(path)
  try {
    assert.throws(
      () => reopened.repairCandidates({ kind: 'resolve', id: 'r', sequence: 3, missing: [] }),
      /会话已失效/
    )
    assert.equal(reopened.getMetadata().trackCount, 0)
  } finally {
    reopened.close()
  }
})

test('streaming candidate traversal bounds details, parsers and unacknowledged batches', async () => {
  let parsed = 0,
    active = 0,
    peak = 0,
    release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: RepairScanCall[] = []
  const scanning = runPlaylistRepairScan({
    root: 'root',
    async *enumerate() {
      for (let offset = 0; offset < 1001; offset += 200)
        yield {
          children: [],
          identities: Array.from({ length: Math.min(200, 1001 - offset) }, (_, i) => ({
            filePath: String(offset + i),
            size: 1,
            mtimeMs: 1
          }))
        }
    },
    async parse(identity) {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      parsed++
      active--
      return [
        record(identity.filePath, `E:/Moved/${identity.filePath}.flac`, {
          lyrics: 'heavy',
          analysis: { data: 'heavy' }
        })
      ]
    },
    async call(call) {
      calls.push(call)
      if (call.kind === 'append' && calls.filter((item) => item.kind === 'append').length === 1)
        await held
    }
  })
  for (let i = 0; i < 100 && !calls.some((item) => item.kind === 'append'); i++) await tick()
  assert.equal(parsed, 200)
  await tick()
  assert.equal(parsed, 200, 'an unacknowledged batch must stop parsing')
  release()
  await scanning
  assert.equal(peak, 4)
  const batches = calls.filter((item) => item.kind === 'append')
  assert.deepEqual(
    batches.map((item) => item.tracks.length),
    [200, 200, 200, 200, 200, 1]
  )
  assert.ok(
    batches.every((item) =>
      item.tracks.every((track) => track.lyrics === null && !('analysis' in track))
    )
  )
})

test('scan session rejects unbounded producers and waits for dispatched work before disposal', async () => {
  let release!: () => void,
    stopped = 0
  const work = new Promise<void>((resolve) => {
    release = resolve
  })
  const sent: LocalLibraryScanWorkerRequest[] = []
  const session = new PlaylistRepairScanSession(
    'r',
    (message) => sent.push(message),
    () => {
      stopped++
    },
    () => work,
    1000
  )
  const outcome = assert.rejects(session.result, /无效或无界/)
  session.handle({
    kind: 'repair-call',
    requestId: 'r',
    sequence: 1,
    call: { kind: 'authorize', paths: ['x'] }
  })
  session.handle({
    kind: 'repair-call',
    requestId: 'r',
    sequence: 2,
    call: { kind: 'authorize', paths: ['y'] }
  })
  assert.equal(stopped, 1)
  release()
  await outcome
  assert.equal(sent.length, 0)
})

async function serviceFixture(t: test.TestContext, fail = false, idleMs = 120000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-service-'))),
    path = join(root, 'one.flac')
  writeFileSync(path, 'test')
  const db = new LibraryDatabase(':memory:')
  const commands: string[] = []
  let loseReply = false,
    authorized = true,
    candidatePath = path
  const service = new LibraryPlaylistRepairService({
    database: {
      repairCandidates: async (command) => {
        commands.push(command.kind)
        const reply = db.repairCandidates(command)
        if (command.kind === 'resolve' && loseReply) throw new Error('resolve reply lost')
        return reply
      }
    },
    coverCacheDir: root,
    authorizeDirectory: realpath,
    authorizeFile: async (path) => {
      if (!authorized) throw new Error('file authorization revoked')
      return realpath(path)
    },
    readSacdIsoMetadata: async (filePath) =>
      ({
        isoTracks: [
          {
            source: filePath + '#sacd-stereo-1',
            title: 'First',
            artist: 'Artist',
            duration: 180,
            playable: true
          },
          {
            source: filePath + '#sacd-stereo-2',
            title: 'Second',
            artist: 'Artist',
            duration: 181,
            playable: true
          }
        ]
      }) as unknown as NativeAudioMetadata,
    reserveScan: async (action) => action(),
    idleMs,
    scanner: {
      scanRepair: async (_id, _root, _covers, call) => {
        await call({ kind: 'authorize', paths: [candidatePath] })
        await call({ kind: 'append', tracks: [record('new', candidatePath)] })
        if (fail) throw new Error('incomplete scan')
      }
    }
  })
  const owner = new Owner()
  t.after(async () => {
    owner.destroy()
    await tick()
    service.destroy()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    path,
    db,
    service,
    owner,
    commands,
    loseResolveReply() {
      loseReply = true
    },
    revoke() {
      authorized = false
    },
    setCandidate(path: string) {
      candidatePath = path
    }
  }
}

test('a lost stateful resolution reply stops the session instead of replaying consumed candidates', async (t) => {
  const f = await serviceFixture(t)
  const ready = await f.service.handle(f.owner, { kind: 'open', folder: f.root })
  f.loseResolveReply()
  await assert.rejects(
    f.service.handle(f.owner, {
      kind: 'resolve',
      id: ready.id,
      sequence: 1,
      missing: [record('old', 'D:/Old/one.flac')]
    }),
    /reply lost/
  )
  await f.service.handle(f.owner, { kind: 'close', id: ready.id })
  assert.equal(f.commands.filter((kind) => kind === 'resolve').length, 1)
  assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM repair_candidates').get()?.n, 0)
})

test('repair rechecks candidate authorization before returning matches', async (t) => {
  const f = await serviceFixture(t)
  const ready = await f.service.handle(f.owner, { kind: 'open', folder: f.root })
  f.revoke()
  await assert.rejects(
    f.service.handle(f.owner, {
      kind: 'resolve',
      id: ready.id,
      sequence: 1,
      missing: [record('old', 'D:/Old/one.flac')]
    }),
    /authorization revoked/
  )
  await f.service.handle(f.owner, { kind: 'close', id: ready.id })
  assert.equal(f.db.getMetadata().trackCount, 0)
})

test('candidate canonical paths cannot escape the selected root even when other roots are authorized', async (t) => {
  const f = await serviceFixture(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'repair-outside-'))),
    path = join(outside, 'outside.flac')
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(path, 'test')
  f.setCandidate(path)
  await assert.rejects(
    f.service.handle(f.owner, { kind: 'open', folder: f.root }),
    /超出所选文件夹/
  )
  await tick()
  assert.equal(f.commands.includes('append'), false)
  assert.equal(f.commands.includes('seal'), false)
})

test('repair expands SACD programme tracks and preserves their sub-track playback identities', async (t) => {
  const f = await serviceFixture(t),
    path = join(f.root, 'disc.iso')
  writeFileSync(path, 'ISO')
  f.setCandidate(path)
  const ready = await f.service.handle(f.owner, { kind: 'open', folder: f.root })
  if (ready.kind === 'ready') assert.equal(ready.candidateCount, 2)
  const reply = await f.service.handle(f.owner, {
    kind: 'resolve',
    id: ready.id,
    sequence: 1,
    missing: [record('old', 'D:/Old/disc.iso', { title: 'Second', duration: 181 })]
  })
  if (reply.kind !== 'resolved') throw new Error('expected resolution')
  assert.equal(reply.result.relocations[0].toTrack.subTrack, path + '#sacd-stereo-2')
  await f.service.handle(f.owner, { kind: 'close', id: ready.id })
})

test('repair sessions bind to their sender, expire, reject duplicate resolution and leave the canonical library untouched', async (t) => {
  const f = await serviceFixture(t)
  const ready = await f.service.handle(f.owner, { kind: 'open', folder: f.root })
  assert.equal(ready.kind, 'ready')
  assert.equal('tracks' in ready, false)
  const other = new Owner()
  await assert.rejects(f.service.handle(other, { kind: 'close', id: ready.id }), /不属于/)
  await assert.rejects(
    f.service.handle(other, { kind: 'resolve', id: ready.id, sequence: 1, missing: [] }),
    /不属于/
  )
  const resolved = await f.service.handle(f.owner, {
    kind: 'resolve',
    id: ready.id,
    sequence: 1,
    missing: [record('old', 'D:/Old/one.flac')]
  })
  assert.equal(resolved.kind, 'resolved')
  if (resolved.kind === 'resolved') assert.equal(resolved.result.relocations[0].toTrack.id, 'new')
  assert.equal(f.db.getMetadata().trackCount, 0)
  assert.equal(f.db.getMetadata().revision, 0)
  await assert.rejects(
    f.service.handle(f.owner, { kind: 'resolve', id: ready.id, sequence: 1, missing: [] }),
    /批次已失效/
  )
  await f.service.handle(f.owner, { kind: 'close', id: ready.id })
  assert.equal(f.commands.at(-1), 'close')
})

for (const cause of ['incomplete', 'destroy', 'expiry'] as const)
  test(`repair ${cause} discards candidates without publishing a partial unique match`, async (t) => {
    const f = await serviceFixture(t, cause === 'incomplete', 10)
    if (cause === 'incomplete')
      await assert.rejects(
        f.service.handle(f.owner, { kind: 'open', folder: f.root }),
        /incomplete/
      )
    else {
      await f.service.handle(f.owner, { kind: 'open', folder: f.root })
      if (cause === 'destroy') f.owner.destroy()
      else await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await tick()
    assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM repair_candidates').get()?.n, 0)
    assert.equal(f.db.getMetadata().revision, 0)
    assert.equal(f.commands.includes('resolve'), false)
    assert.equal(f.commands.includes('seal'), cause !== 'incomplete')
  })

test(
  'actual metadata and database workers scan 405 WAV files and CUE without importing candidates or returning a full result array',
  { timeout: 30000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-workers-'))),
      media = join(root, 'media')
    mkdirSync(media)
    const children: ChildProcess[] = []
    let maximum = 0,
      outstanding = 0,
      peakOutstanding = 0
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
      electron: { utilityProcess: { fork: spawn } }
    })
    const service = new LibraryPlaylistRepairService({
      database: {
        repairCandidates: async (command) => {
          if (command.kind === 'append') {
            maximum = Math.max(maximum, command.tracks.length)
            outstanding++
            peakOutstanding = Math.max(peakOutstanding, outstanding)
          }
          try {
            return await database.repairCandidates(command)
          } finally {
            if (command.kind === 'append') outstanding--
          }
        }
      },
      scanner,
      coverCacheDir: join(root, 'covers'),
      authorizeDirectory: realpath,
      authorizeFile: realpath,
      reserveScan: async (action) => action()
    })
    const owner = new Owner()
    t.after(async () => {
      service.destroy()
      scanner.destroy()
      database.destroy()
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      rmSync(root, { recursive: true, force: true })
    })
    const wave = Buffer.alloc(44 + 48000)
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
    wave.writeUInt32LE(48000, 40)
    for (let i = 0; i < 405; i++)
      writeFileSync(join(media, `${String(i).padStart(4, '0')}.wav`), wave)
    writeFileSync(
      join(media, 'disc.cue'),
      'FILE "0000.wav" WAVE\nTRACK 01 AUDIO\nTITLE "First"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Second"\nINDEX 01 00:01:00\n'
    )
    const before = await database.getMetadata()
    const ready = await service.handle(owner, { kind: 'open', folder: media })
    assert.equal(ready.kind, 'ready')
    if (ready.kind === 'ready') assert.equal(ready.candidateCount, 406)
    assert.ok(maximum <= 200)
    assert.equal(peakOutstanding, 1)
    const reply = await service.handle(owner, {
      kind: 'resolve',
      id: ready.id,
      sequence: 1,
      missing: [
        record('old-cue', 'D:/Old/0000.wav', {
          title: 'Second',
          artist: 'Unknown Artist',
          duration: 2
        }),
        record('old-one', 'D:/Old/0404.wav')
      ]
    })
    assert.equal(reply.kind, 'resolved')
    if (reply.kind === 'resolved') {
      assert.equal(reply.result.relocations.length, 2)
      assert.equal(
        reply.result.relocations[0].toTrack.cueRange &&
          (reply.result.relocations[0].toTrack.cueRange as { startSeconds: number }).startSeconds,
        1
      )
      assert.match(String(reply.result.relocations[1].toTrack.filePath), /0404\.wav$/)
    }
    await service.handle(owner, { kind: 'close', id: ready.id })
    assert.deepEqual(await database.getMetadata(), before)
    assert.deepEqual(await database.listScanJobs(), [])
  }
)
