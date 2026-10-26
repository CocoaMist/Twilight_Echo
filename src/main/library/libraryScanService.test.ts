import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type {
  LocalLibraryScanWorkerMessage,
  LocalLibraryScanWorkerRequest,
  LocalLibraryWorkerScanRequest
} from '../../shared/localLibraryScan.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import { persistLocalLibraryFileIndex, loadLocalLibraryFileIndex } from './fileIndex.ts'
import { LocalLibraryIndexCoordinator } from './libraryIndexCoordinator.ts'
import type { LocalLibraryScanRunner } from './libraryScanServiceClient.ts'
import { loadMusicLibraryDocument, persistMusicLibraryDocument } from './libraryRepository.ts'
import { collectTrackIdentityTags } from './trackIdentityTags.ts'
import { legacyTrackIdentityTags, normalizeTrackIdentityTags, type TrackIdentityTags } from '../../shared/trackIdentification.ts'
import { LOCAL_LIBRARY_METADATA_VERSION } from '../../shared/localLibraryScan.ts'

const WORKER_MESSAGE_TIMEOUT_MS = 30_000
const WORKER_TERMINATION_TIMEOUT_MS = 5_000

test('identity observations keep artist roles, ID order and original precision without inventing alignment', () => {
  const tags = collectTrackIdentityTags({
    title: 'Title', artist: 'A & B', artists: ['A', 'B'], album: 'Album',
    albumartist: 'Various Artists', albumartists: ['Various Artists'], genre: ['Jazz', 'Pop'],
    musicbrainz_artistid: ['second-id', 'first-id', 'second-id'],
    musicbrainz_albumartistid: ['compilation-id'], musicbrainz_recordingid: 'recording-id',
    musicbrainz_trackid: 'release-track-id', musicbrainz_albumid: 'release-id',
    musicbrainz_releasegroupid: 'project-id', isrc: ['ISRC-A', 'ISRC-B'], barcode: '0012345',
    catalognumber: ['CAT-01', 'CAT-02'], track: { no: 3, of: 12 }, disk: { no: 2, of: 3 }
  }, 123.456789, { title: 'filename', artist: 'filename' })
  assert.deepEqual(tags.artist, { value: 'A & B', origin: 'audio_tag' })
  assert.deepEqual(tags.albumArtists?.value, ['Various Artists'])
  assert.deepEqual(tags.musicbrainz?.artistIds, ['second-id', 'first-id', 'second-id'])
  assert.equal(tags.musicbrainz?.recordingId, 'recording-id')
  assert.equal(tags.musicbrainz?.releaseTrackId, 'release-track-id')
  assert.equal(tags.durationSeconds?.value, 123.456789)
  assert.equal(tags.trackTotal?.value, 12)
  assert.equal(tags.discTotal?.value, 3)
  assert.deepEqual(tags.isrcs, ['ISRC-A', 'ISRC-B'])
  assert.equal(tags.barcode, '0012345')
  assert.equal(LOCAL_LIBRARY_METADATA_VERSION, 1, 'new optional evidence must not force a full reread')
})

test('fallback, compilation-only tags and old caches never become observed performer tags', () => {
  const fallback = { title: 'file', artist: 'Unknown Artist' }
  const tags = collectTrackIdentityTags({ albumartist: 'Various Artists' }, undefined, fallback)
  assert.deepEqual(tags.artist, { value: 'Unknown Artist', origin: 'filename' })
  assert.equal(tags.albumArtist?.origin, 'audio_tag')
  const legacy = legacyTrackIdentityTags({ title: 'Enriched title', artist: 'Enriched artist', isrc: 'old' })
  assert.equal(legacy.artist?.origin, 'legacy')
  assert.equal(legacy.isrcs, undefined)
  assert.equal(legacy.musicbrainz, undefined)
  assert.equal(normalizeTrackIdentityTags({ version: 9 }), undefined)
  const normalized = normalizeTrackIdentityTags({
    ...tags, arbitraryUrl: 'https://untrusted.invalid',
    musicbrainz: { artistIds: Array.from({ length: 100 }, () => 'x'.repeat(4000)), albumArtistIds: [] }
  })!
  assert.equal(normalized.truncated, true)
  assert.ok(normalized.musicbrainz!.artistIds.length <= 64)
  assert.ok(JSON.stringify(normalized).length < 20000)
  assert.equal('arbitraryUrl' in normalized, false)
})

test('real scanner retains FLAC identity tags and fractional duration through CUE projection', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-identity-flac-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filePath = join(root, 'audio.flac')
  // Minimal STREAMINFO plus a real Vorbis-comment block; no decoder is involved.
  const stream = Buffer.alloc(38)
  stream.writeUIntBE(34, 1, 3)
  stream.writeUInt16BE(4096, 4)
  stream.writeUInt16BE(4096, 6)
  stream.writeBigUInt64BE((8000n << 44n) | (15n << 36n) | 987654n, 14)
  const comments = [
    'TITLE=Tagged title', 'ARTIST=Performer', 'ALBUMARTIST=Various Artists', 'ALBUM=Album',
    'MUSICBRAINZ_ARTISTID=a223958d-5c56-4b2c-a30a-87e357bc121b',
    'MUSICBRAINZ_ALBUMARTISTID=89ad4ac3-39f7-470e-963a-56509c546377',
    'MUSICBRAINZ_TRACKID=c8b031a2-8f55-4e9e-8057-561a3b9c4f38',
    'MUSICBRAINZ_ALBUMID=22ba18ba-f1b4-45e3-b089-4dcf96b202cf',
    'MUSICBRAINZ_RELEASEGROUPID=9fbd356f-b4b8-38e8-8871-7566068993d1',
    'ISRC=USAAA2400001', 'BARCODE=0012345', 'CATALOGNUMBER=CAT-01', 'TRACKNUMBER=1', 'TRACKTOTAL=2'
  ]
  const uint = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const body = Buffer.concat([uint(0), uint(comments.length), ...comments.flatMap((v) => {
    const bytes = Buffer.from(v); return [uint(bytes.length), bytes]
  })])
  const header = Buffer.alloc(4)
  header[0] = 0x84
  header.writeUIntBE(body.length, 1, 3)
  writeFileSync(filePath, Buffer.concat([Buffer.from('fLaC'), stream, header, body]))
  const child = await startWorker()
  try {
    const response = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.ok(response.ok)
    const track = response.value.parsedTracks[0] as Record<string, unknown>
    const tags = track.identityTags as TrackIdentityTags
    assert.equal(tags.musicbrainz?.recordingId, 'c8b031a2-8f55-4e9e-8057-561a3b9c4f38')
    assert.equal(tags.musicbrainz?.releaseId, '22ba18ba-f1b4-45e3-b089-4dcf96b202cf')
    assert.equal(tags.albumArtist?.value, 'Various Artists')
    assert.equal(tags.durationSeconds?.value, 123.45675)
    assert.equal(track.duration, 123)
    assert.deepEqual(tags.isrcs, ['USAAA2400001'])
    writeFileSync(join(root, 'audio.cue'), 'PERFORMER "CUE artist"\nTITLE "CUE album"\nFILE "audio.flac" WAVE\nTRACK 01 AUDIO\nTITLE "One"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Two"\nINDEX 01 01:00:01\n')
    const cue = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.ok(cue.ok)
    const segment = cue.value.parsedTracks[1] as Record<string, unknown>
    const segmentTags = segment.identityTags as TrackIdentityTags
    assert.equal(segmentTags.scope, 'cue_track')
    assert.equal(segmentTags.artist?.origin, 'cue')
    assert.equal(segmentTags.musicbrainz?.recordingId, undefined)
    assert.deepEqual(segmentTags.musicbrainz?.artistIds, [])
    assert.deepEqual(segmentTags.isrcs, [])
    assert.equal(segmentTags.trackTotal, undefined)
    assert.equal(segmentTags.durationSeconds?.value, 123.45675 - (60 + 1 / 75))
  } finally {
    await terminateWorker(child)
  }
})

test('scan worker preserves GIF folder covers and rejects invalid GIF signatures', async (t) => {
  for (const signature of ['GIF87a', 'GIF89a', 'GIF00a']) {
    await t.test(signature, async () => {
      const root = mkdtempSync(join(tmpdir(), 'twilight-scan-gif-'))
      const bytes = Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64'
      )
      bytes.write(signature, 0, 'latin1')
      writeTaggedWav(join(root, 'audio.wav'))
      writeFileSync(join(root, 'cover.gif'), bytes)
      const child = await startWorker()
      try {
        const response = await sendScan(child, { ...baseRequest(root), mode: 'full' })
        assert.equal(response.ok, true)
        if (!response.ok) return
        const track = response.value.parsedTracks[0] as Record<string, unknown>
        if (signature === 'GIF00a') assert.equal(track.cover, null)
        else {
          assert.match(String(track.cover), /^cover:\/\/[a-f0-9]+\.gif$/)
          const name = String(track.cover).slice('cover://'.length)
          assert.deepEqual(readFileSync(join(root, 'covers', name)), bytes)
        }
      } finally {
        await terminateWorker(child)
        assert.ok(root.startsWith(join(tmpdir(), 'twilight-scan-gif-')))
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

test('real scan worker suspends only cover writes and invalidates directory handles after clearing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-cover-maintenance-'))
  writeTaggedWav(join(root, 'audio.wav'))
  writeFileSync(join(root, 'cover.gif'), Buffer.from('GIF89a-fixture'))
  const child = await startWorker()
  try {
    const first = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.ok(first.ok)
    const cover = String((first.value.parsedTracks[0] as Record<string, unknown>).cover)
    assert.match(cover, /^cover:\/\//)
    const suspended = waitForMessage(
      child,
      (m) => m.kind === 'cache-ready' && m.state === 'suspended'
    )
    child.send({ kind: 'cache-suspend', requestId: 'maintenance' })
    await suspended
    rmSync(join(root, 'covers'), { recursive: true, force: true })
    // A full scan would finish immediately from the old directory memo if it
    // weren't invalidated. Its actual cover write must now wait for resume.
    let finished = false
    const second = sendScan(child, { ...baseRequest(root), mode: 'full' }).then((r) => {
      finished = true
      return r
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(finished, false)
    const resumed = waitForMessage(child, (m) => m.kind === 'cache-ready' && m.state === 'running')
    child.send({ kind: 'cache-resume', requestId: 'maintenance' })
    await resumed
    const result = await second
    assert.ok(result.ok)
    assert.equal((result.value.parsedTracks[0] as Record<string, unknown>).cover, cover)
    assert.equal(
      readFileSync(join(root, 'covers', cover.slice('cover://'.length)), 'utf8'),
      'GIF89a-fixture'
    )
  } finally {
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

test('scan worker reads duration and trailing tags across a large audio payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-seek-'))
  const filePath = join(root, 'large.wav')
  const dataSize = 32 * 1024 * 1024
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(dataSize + 62, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  const tail = Buffer.alloc(26)
  tail.write('LIST', 0)
  tail.writeUInt32LE(18, 4)
  tail.write('INFOINAM', 8)
  tail.writeUInt32LE(6, 16)
  tail.write('Title\0', 20)
  const fd = openSync(filePath, 'w')
  try {
    writeSync(fd, header, 0, header.length, 0)
    writeSync(fd, tail, 0, tail.length, 44 + dataSize)
  } finally {
    closeSync(fd)
  }
  const child = await startWorker()
  try {
    const response = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.equal(response.ok, true)
    if (!response.ok) return
    const track = response.value.parsedTracks[0] as Record<string, unknown>
    assert.equal(track.title, 'Title')
    assert.equal(track.duration, Math.round(dataSize / 16000))
    assert.equal(track.sampleRate, 8000)
    assert.equal(track.bitDepth, 16)
    writeFileSync(
      join(root, 'large.cue'),
      'FILE "large.wav" WAVE\nTRACK 01 AUDIO\nTITLE "Part One"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Part Two"\nINDEX 01 01:00:00\n'
    )
    const cueResponse = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.equal(cueResponse.ok, true)
    if (!cueResponse.ok) return
    assert.deepEqual(
      cueResponse.value.parsedTracks.map((item) => (item as Record<string, unknown>).title),
      ['Part One', 'Part Two']
    )
  } finally {
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

test('scan worker resumes a 170000-file checkpoint without reparsing completed files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-checkpoint-'))
  const filePath = join(root, 'remaining.mp3')
  writeFileSync(filePath, 'not-real-mp3')
  const info = statSync(filePath)
  const completed = Array.from({ length: 170_000 }, (_, index) => ({
    filePath: join(root, `${index}.mp3`),
    size: 1,
    mtimeMs: 1
  }))
  const child = await startWorker()
  const messages: LocalLibraryScanWorkerMessage[] = []
  child.on('message', (message) => messages.push(message as LocalLibraryScanWorkerMessage))
  try {
    const response = await sendScan(child, {
      ...baseRequest(root),
      mode: 'full',
      streamResults: true,
      resumeCheckpoint: {
        identities: [...completed, { filePath, size: info.size, mtimeMs: info.mtimeMs }],
        completeIdentitySnapshot: true,
        completedFilePaths: completed.map((file) => file.filePath),
        parsedFileCount: completed.length
      }
    })
    assert.equal(response.ok, true)
    if (!response.ok) return
    assert.equal(response.value.parsedFileCount, 170_001)
    assert.deepEqual(
      messages.flatMap((message) =>
        message.kind === 'batch' ? message.batch.parsedFilePaths : []
      ),
      [filePath]
    )
    assert.equal(
      messages.some((message) => message.kind === 'identity-batch'),
      false
    )
    const progress = messages.flatMap((message) =>
      message.kind === 'progress' ? [message.progress] : []
    )
    assert.ok(progress.length > 0)
    assert.ok(progress.every((item) => item.phase === 'parsing' && item.current >= 170_000))
    assert.equal(progress.at(-1)?.current, 170_001)
  } finally {
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

test('scan worker parses metadata out of process and returns a complete identity snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-worker-'))
  const filePath = join(root, 'Artist - Song.mp3')
  writeFileSync(filePath, 'not-real-mp3')
  const child = await startWorker()
  try {
    const response = await sendScan(child, {
      ...baseRequest(root),
      mode: 'full'
    })

    assert.notEqual(child.pid, process.pid)
    assert.equal(response.ok, true)
    if (!response.ok) return
    assert.equal(response.value.completeIdentitySnapshot, true)
    assert.equal(response.value.parsedFileCount, 1)
    assert.equal(response.value.identities[0].filePath, filePath)
    assert.equal((response.value.parsedTracks[0] as { title?: unknown }).title, 'Song')
  } finally {
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

test('scan worker tracks sibling CUE dependencies across startup and watcher scans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-worker-cue-'))
  const filePath = join(root, 'disc.mp3')
  const cuePath = join(root, 'disc.cue')
  writeFileSync(filePath, 'not-real-mp3')
  const child = await startWorker()
  try {
    const initial = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.equal(initial.ok, true)
    if (!initial.ok) return
    const initialIdentity = initial.value.identities[0]
    assert.equal(initialIdentity.cueSignature, undefined)

    writeFileSync(cuePath, 'FILE "disc.mp3" MP3\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n')
    const added = await sendScan(child, {
      ...baseRequest(root),
      knownIdentities: [initialIdentity],
      knownTrackPaths: [filePath],
      mode: 'watch',
      changes: [{ kind: 'add', path: cuePath }]
    })
    assert.equal(added.ok, true)
    if (!added.ok) return
    assert.equal(added.value.parsedFileCount, 1)
    assert.equal(typeof added.value.identities[0].cueSignature, 'string')
    const addedIdentity = added.value.identities[0]

    const unchanged = await sendScan(child, {
      ...baseRequest(root),
      knownIdentities: [{ ...addedIdentity, metadataVersion: 1 }],
      knownTrackPaths: [filePath],
      mode: 'startup'
    })
    assert.equal(unchanged.ok, true)
    if (!unchanged.ok) return
    assert.equal(unchanged.value.parsedFileCount, 0)
    assert.equal(unchanged.value.skippedUnchanged, 1)

    writeFileSync(
      cuePath,
      'FILE "disc.mp3" MP3\nTRACK 01 AUDIO\nTITLE "Changed and longer"\nINDEX 01 00:00:00\n'
    )
    const changed = await sendScan(child, {
      ...baseRequest(root),
      knownIdentities: [addedIdentity],
      knownTrackPaths: [filePath],
      mode: 'watch',
      changes: [{ kind: 'add', path: cuePath }]
    })
    assert.equal(changed.ok, true)
    if (!changed.ok) return
    assert.equal(changed.value.parsedFileCount, 1)
    assert.notEqual(changed.value.identities[0].cueSignature, addedIdentity.cueSignature)

    rmSync(cuePath, { force: true })
    const removed = await sendScan(child, {
      ...baseRequest(root),
      knownIdentities: changed.value.identities,
      knownTrackPaths: [filePath],
      mode: 'watch',
      changes: [{ kind: 'remove', path: cuePath }]
    })
    assert.equal(removed.ok, true)
    if (!removed.ok) return
    assert.equal(removed.value.parsedFileCount, 1)
    assert.equal(removed.value.identities[0].cueSignature, undefined)
    assert.deepEqual(removed.value.removedFilePaths, [])
  } finally {
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

test('scan worker fails closed instead of treating an unreadable root as an empty library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-worker-missing-'))
  const missingRoot = join(root, 'offline-volume')
  const child = await startWorker()
  try {
    const response = await sendScan(child, {
      ...baseRequest(missingRoot),
      mode: 'startup'
    })

    assert.equal(response.ok, false)
    if (response.ok) return
    assert.match(response.error, /enumeration was incomplete/)
    assert.doesNotMatch(response.error, /offline-volume/)
  } finally {
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

test('vanished watcher additions remove the persisted Track and file index through the coordinator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-scan-worker-vanished-'))
  const libraryFile = join(root, 'music-library.json')
  const filePath = join(root, 'vanished.flac')
  const track = createTrack('vanished', filePath)
  persistMusicLibraryDocument(libraryFile, createDocument(1, root, [track]))
  persistLocalLibraryFileIndex(libraryFile, {
    version: 1,
    libraryRevision: 1,
    updatedAt: new Date(0).toISOString(),
    entries: [{ filePath, size: 1, mtimeMs: 1 }]
  })

  const child = await startWorker()
  const runner = createWorkerRunner(child)
  const coordinator = new LocalLibraryIndexCoordinator({
    libraryFilePath: libraryFile,
    scanRunner: runner,
    enqueueTransaction: async (operation) => await operation(),
    loadDocument: () => loadMusicLibraryDocument(libraryFile),
    persistDocument: (document) => persistMusicLibraryDocument(libraryFile, document),
    resolveRoots: async (folders) => [...folders],
    getCoverCacheDir: () => join(root, 'covers'),
    watcherDebounceMs: 25
  })
  try {
    const completed = once(coordinator, 'watch-result')
    coordinator.enqueueWatcherChanges([{ kind: 'add', path: filePath }])
    const [result] = await completed

    assert.deepEqual(result.removedFilePaths, [filePath])
    assert.deepEqual(result.library.tracks, [])
    assert.deepEqual(loadMusicLibraryDocument(libraryFile).document.tracks, [])
    assert.deepEqual(loadLocalLibraryFileIndex(libraryFile).document.entries, [])
  } finally {
    coordinator.destroy()
    runner.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('real WAV dates backfill without replacing existing metadata and missing tags do not repeat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-release-tags-'))
  const libraryFile = join(root, 'music-library.json')
  const dated = join(root, 'dated.wav')
  const undated = join(root, 'undated.wav')
  const unreadable = join(root, 'broken.flac')
  writeTaggedWav(dated, '2020-05-12')
  writeTaggedWav(undated)
  writeFileSync(unreadable, 'fLaC')
  const tracks = [dated, undated, unreadable].map((path, index) => ({
    ...createTrack(String(index), path),
    cover: 'cover://retained',
    lyrics: 'retained lyrics'
  }))
  persistMusicLibraryDocument(libraryFile, createDocument(1, root, tracks))
  const identities = [dated, undated, unreadable].map((filePath) => {
    const info = statSync(filePath)
    return { filePath, size: info.size, mtimeMs: info.mtimeMs }
  })
  persistLocalLibraryFileIndex(libraryFile, {
    version: 1,
    libraryRevision: 1,
    updatedAt: '',
    entries: identities
  })
  const child = await startWorker()
  const runner = createWorkerRunner(child)
  const coordinator = new LocalLibraryIndexCoordinator({
    libraryFilePath: libraryFile,
    scanRunner: runner,
    enqueueTransaction: async (operation) => await operation(),
    loadDocument: () => loadMusicLibraryDocument(libraryFile),
    persistDocument: (document) => persistMusicLibraryDocument(libraryFile, document),
    resolveRoots: async (folders) => [...folders],
    getCoverCacheDir: () => join(root, 'covers')
  })
  try {
    const first = await coordinator.scanStartup()
    assert.deepEqual(first.library.tracks, [
      { ...tracks[0], releaseDate: '2020-05-12' },
      tracks[1],
      tracks[2]
    ])
    const index = loadLocalLibraryFileIndex(libraryFile).document.entries
    assert.equal(index.find((i) => i.filePath === dated)?.metadataVersion, 1)
    assert.equal(index.find((i) => i.filePath === undated)?.metadataVersion, 1)
    assert.equal(index.find((i) => i.filePath === unreadable)?.metadataVersion, undefined)
    const second = await coordinator.scanStartup()
    assert.equal(second.skippedUnchanged, 2)
    assert.deepEqual(second.updatedTracks, [])
    // Normal scans and derived CUE entries retain the same tagged calendar date.
    writeFileSync(
      join(root, 'dated.cue'),
      'FILE "dated.wav" WAVE\nTRACK 01 AUDIO\nTITLE "Part"\nINDEX 01 00:00:00\n'
    )
    const full = await sendScan(child, { ...baseRequest(root), mode: 'full' })
    assert.equal(full.ok, true)
    if (full.ok) {
      const cue = full.value.parsedTracks.find(
        (t) => (t as Record<string, unknown>).filePath === dated
      ) as Record<string, unknown>
      assert.equal(cue.releaseDate, '2020-05-12')
      assert.ok(cue.cueRange)
    }
  } finally {
    coordinator.destroy()
    await terminateWorker(child)
    rmSync(root, { recursive: true, force: true })
  }
})

function writeTaggedWav(filePath: string, date?: string): void {
  const data = Buffer.alloc(16000)
  const value = Buffer.from(`${date ?? ''}\0`)
  const tag = date ? Buffer.alloc(20 + value.length + (value.length % 2)) : Buffer.alloc(0)
  if (date) {
    tag.write('LIST')
    tag.writeUInt32LE(tag.length - 8, 4)
    tag.write('INFOICRD', 8)
    tag.writeUInt32LE(value.length, 16)
    value.copy(tag, 20)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF')
  header.writeUInt32LE(36 + data.length + tag.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(filePath, Buffer.concat([header, data, tag]))
}

async function startWorker(): Promise<ChildProcess> {
  const child = fork(fileURLToPath(new URL('./libraryScanService.ts', import.meta.url)), [], {
    execArgv: ['--experimental-strip-types'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  try {
    await waitForMessage(child, (message) => message.kind === 'ready')
    return child
  } catch (error) {
    await terminateWorker(child)
    throw error
  }
}

async function terminateWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  const exited = once(child, 'exit')
  child.kill()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, WORKER_TERMINATION_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function sendScan(
  child: ChildProcess,
  request: LocalLibraryWorkerScanRequest
): Promise<Extract<LocalLibraryScanWorkerMessage, { kind: 'response' }>> {
  const requestId = `scan-${Date.now()}-${Math.random()}`
  const response = waitForMessage(
    child,
    (message): message is Extract<LocalLibraryScanWorkerMessage, { kind: 'response' }> =>
      message.kind === 'response' && message.requestId === requestId
  )
  child.send({ kind: 'scan', requestId, request } satisfies LocalLibraryScanWorkerRequest)
  return await response
}

function createWorkerRunner(child: ChildProcess): LocalLibraryScanRunner {
  return {
    async scan(_jobId, request, _onProgress, onBatch, onIdentityBatch) {
      const receive = (message: LocalLibraryScanWorkerMessage): void => {
        if (message.kind === 'batch') onBatch?.(message.batch)
        if (message.kind === 'identity-batch') onIdentityBatch?.(message.batch)
      }
      child.on('message', receive)
      try {
        const response = await sendScan(child, request)
        if (!response.ok) throw new Error(response.error)
        return response.value
      } finally {
        child.off('message', receive)
      }
    },
    pause(requestId) {
      child.send({ kind: 'pause', requestId } satisfies LocalLibraryScanWorkerRequest)
    },
    resume(requestId) {
      child.send({ kind: 'resume', requestId } satisfies LocalLibraryScanWorkerRequest)
    },
    cancel(requestId) {
      child.send({ kind: 'cancel', requestId } satisfies LocalLibraryScanWorkerRequest)
    },
    destroy() {
      child.kill()
    }
  }
}

async function waitForMessage<T extends LocalLibraryScanWorkerMessage>(
  child: ChildProcess,
  predicate: (message: LocalLibraryScanWorkerMessage) => message is T,
  timeoutMs?: number
): Promise<T>
async function waitForMessage(
  child: ChildProcess,
  predicate: (message: LocalLibraryScanWorkerMessage) => boolean,
  timeoutMs?: number
): Promise<LocalLibraryScanWorkerMessage>
async function waitForMessage(
  child: ChildProcess,
  predicate: (message: LocalLibraryScanWorkerMessage) => boolean,
  timeoutMs = WORKER_MESSAGE_TIMEOUT_MS
): Promise<LocalLibraryScanWorkerMessage> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('scan worker response timed out')), timeoutMs)
    const onMessage = (rawMessage: unknown): void => {
      const message = rawMessage as LocalLibraryScanWorkerMessage
      if (predicate(message)) finish(null, message)
    }
    const onExit = (code: number | null): void =>
      finish(new Error(`scan worker exited before responding (${code ?? 'unknown'})`))
    const finish = (error: Error | null, message?: LocalLibraryScanWorkerMessage): void => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(message!)
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

function createDocument(
  revision: number,
  root: string,
  tracks: Array<Record<string, unknown>>
): LocalMusicLibraryDocument {
  return { version: 2, revision, folders: [root], tracks, exclusions: [] }
}

function createTrack(id: string, filePath: string): Record<string, unknown> {
  return {
    id,
    title: id,
    artist: 'Test',
    album: 'Test',
    filePath,
    fileName: filePath.split(/[\\/]/).pop() ?? filePath,
    duration: 1,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

function baseRequest(root: string): LocalLibraryWorkerScanRequest {
  return {
    mode: 'startup',
    roots: [root],
    knownIdentities: [],
    knownTrackPaths: [],
    excludedPaths: [],
    coverCacheDir: join(root, 'covers')
  }
}
