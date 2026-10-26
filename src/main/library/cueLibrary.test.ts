import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import type { LibraryCueDefinitionRecord } from '../../shared/libraryDatabase.ts'
import type { TrackIdentityTags } from '../../shared/trackIdentification.ts'
import { MAX_CUE_BYTES } from '../../shared/cue.ts'
import { CueDirectoryIndex, deriveCueTracks, resolveCueAudioPath } from './cueLibrary.ts'
import { LibraryDatabase } from './libraryDatabase.ts'

test('CUE library derivation replaces one audio file with stable logical tracks', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-'))
  try {
    const audio = join(root, 'disc.flac')
    const cue = join(root, 'disc.cue')
    writeFileSync(audio, 'fixture')
    writeFileSync(
      cue,
      'PERFORMER "Artist"\nTITLE "Album"\nFILE "disc.flac" WAVE\nTRACK 01 AUDIO\nTITLE "One"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Two"\nINDEX 01 01:00:00\n'
    )
    const base = {
      id: 'unstable',
      title: 'disc',
      artist: 'fallback',
      album: 'fallback album',
      filePath: audio,
      fileName: 'disc.flac',
      duration: 120,
      size: 7,
      cover: null,
      lyrics: null
    }
    const first = deriveCueTracks(audio, 120, base, ['.flac'])
    const second = deriveCueTracks(audio, 120, base, ['.flac'])
    assert.ok(first)
    assert.equal(first.length, 2)
    assert.deepEqual(
      first.map((item) => item.id),
      second?.map((item) => item.id)
    )
    assert.deepEqual(
      first.map((item) => item.duration),
      [60, 60]
    )
    assert.equal(first[1].cueRange.startSeconds, 60)
    assert.equal(first[0].album, 'Album')
    assert.equal(first[0].trackNumber, 1)
    assert.equal(first[1].trackNumber, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CUE referenced file cannot escape its containing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-path-'))
  try {
    assert.throws(() => resolveCueAudioPath(root, '../outside.flac', ['.flac']), /relative|escapes/)
    if (process.platform === 'win32') {
      assert.throws(
        () => resolveCueAudioPath(root, '..\\outside.flac', ['.flac']),
        /relative|escapes/
      )
    }
    assert.throws(
      () => resolveCueAudioPath(root, join(root, 'absolute.flac'), ['.flac']),
      /relative/
    )
    assert.throws(() => resolveCueAudioPath(root, 'inside.txt', ['.flac']), /extension/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CUE library derivation rejects an oversized sheet before parsing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-size-'))
  try {
    const audio = join(root, 'disc.flac')
    writeFileSync(audio, 'fixture')
    writeFileSync(join(root, 'disc.cue'), Buffer.alloc(MAX_CUE_BYTES + 1, 0x20))
    assert.equal(
      deriveCueTracks(
        audio,
        120,
        { id: 'base', filePath: audio, fileName: 'disc.flac', duration: 120 },
        ['.flac']
      ),
      null
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CUE library derivation retains GB18030 identity, pregap, and source ReplayGain', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-gb18030-'))
  try {
    const audio = join(root, 'disc.flac')
    const cue = join(root, 'disc.cue')
    writeFileSync(audio, 'fixture')
    writeFileSync(
      cue,
      Buffer.concat([
        Buffer.from('TITLE "', 'ascii'),
        Buffer.from([0x94, 0x39, 0xfc, 0x36]),
        Buffer.from(
          '"\nFILE "disc.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n' +
            'TRACK 02 AUDIO\nPREGAP 00:02:00\nINDEX 01 01:00:00\n',
          'ascii'
        )
      ])
    )
    const tracks = deriveCueTracks(
      audio,
      120,
      {
        id: 'base',
        title: 'disc',
        artist: 'Artist',
        album: 'Album',
        filePath: audio,
        fileName: 'disc.flac',
        duration: 120,
        size: 7,
        cover: null,
        lyrics: null,
        replayGainTrackGainDb: -7.5,
        r128AlbumGainDb: -6
      },
      ['.flac']
    )

    assert.ok(tracks)
    assert.equal(tracks[0].cueEncoding, 'gb18030')
    assert.equal(tracks[0].album, '😀')
    assert.equal(tracks[1].cueRange.pregapSeconds, 2)
    assert.equal(tracks[1].cueRange.virtualPregapSeconds, 2)
    assert.equal(tracks[1].cueRange.sourcePregapSeconds, 0)
    assert.equal(tracks[1].duration, 62)
    assert.equal((tracks[1].identityTags as TrackIdentityTags).durationSeconds?.value, 60)
    assert.equal(tracks[1].replayGainTrackGainDb, -7.5)
    assert.equal(tracks[1].r128AlbumGainDb, -6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('async directory index reads each CUE once rather than once per audio file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-index-'))
  try {
    const count = 48
    for (let index = 0; index < count; index++) {
      writeFileSync(join(root, `${index}.flac`), 'fixture')
      writeFileSync(
        join(root, `${index}.cue`),
        `FILE "${index}.flac" WAVE\nTRACK 01 AUDIO\nTITLE "Track ${index}"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 00 00:59:00\nINDEX 01 01:00:00\n`
      )
    }
    const index = new CueDirectoryIndex(['.flac'])
    const values = await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const audio = join(root, `${i}.flac`)
        return index.derive(audio, 120, {
          id: `base:${i}`,
          filePath: audio,
          replayGainTrackGainDb: -7.5
        })
      })
    )
    assert.ok(values.every((value) => value?.length === 2))
    assert.deepEqual(index.metrics, { directoryReads: 1, cueReads: count })
    const audio = join(root, '0.flac'),
      base = { id: 'base:0', filePath: audio, replayGainTrackGainDb: -7.5 }
    assert.deepEqual(values[0], deriveCueTracks(audio, 120, base, ['.flac']))
    await index.derive(audio, 120, base)
    assert.deepEqual(index.metrics, { directoryReads: 1, cueReads: count })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('async CUE definitions are resolved against only their referenced audio duration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-duration-'))
  try {
    for (const name of ['short', 'long']) writeFileSync(join(root, `${name}.flac`), 'fixture')
    writeFileSync(
      join(root, 'short.cue'),
      'FILE "short.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'
    )
    writeFileSync(
      join(root, 'long.cue'),
      'FILE "long.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 30:00:00\n'
    )
    const index = new CueDirectoryIndex(['.flac'])
    assert.equal((await index.derive(join(root, 'short.flac'), 30, {}))?.length, 1)
    assert.equal((await index.derive(join(root, 'long.flac'), 3600, {}))?.length, 2)
    assert.equal(index.metrics.cueReads, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function definitionCache() {
  const records = new Map<string, LibraryCueDefinitionRecord>()
  return {
    async get(identity: LibraryCueDefinitionRecord['identity']) {
      const record = records.get(identity.filePath)
      return record?.identity.size === identity.size && record.identity.mtimeMs === identity.mtimeMs
        ? record
        : null
    },
    async put(record: LibraryCueDefinitionRecord) {
      records.set(record.identity.filePath, record)
    }
  }
}

test('persistent CUE definitions avoid rereads across scans and invalidate only the changed sheet', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-persistent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = (i: number, title = 'Original') =>
    `FILE "${i}.flac" WAVE\nTRACK 01 AUDIO\nTITLE "${title}"\nINDEX 01 00:00:00\n`
  for (let i = 0; i < 48; i++) {
    writeFileSync(join(root, `${i}.flac`), 'fixture')
    writeFileSync(join(root, `${i}.cue`), text(i))
  }
  const cache = definitionCache()
  const first = new CueDirectoryIndex(['.flac'], cache)
  await first.getSignatures(root)
  assert.equal(first.metrics.cueReads, 48)
  const next = new CueDirectoryIndex(['.flac'], cache)
  const signatures = await next.getSignatures(root)
  assert.equal(next.metrics.cueReads, 0)
  assert.equal(next.persistentCacheHits, 48)
  writeFileSync(join(root, '0.cue'), text(0, 'Changed title'))
  next.invalidateDirectory(root)
  const changed = await next.getSignatures(root)
  assert.equal(next.metrics.cueReads, 1)
  assert.notEqual(changed.get([...changed.keys()][0]), undefined)
  const audio = join(root, '0.flac')
  assert.equal((await next.derive(audio, 120, {}))?.[0].title, 'Changed title')
  assert.equal(
    [...signatures.values()].filter((value) => [...changed.values()].includes(value)).length,
    47
  )
})

test('a missing audio does not turn its valid CUE definition into a permanent cached error', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-missing-audio-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(
    join(root, 'disc.cue'),
    'FILE "disc.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'
  )
  const cache = definitionCache()
  const first = new CueDirectoryIndex(['.flac'], cache)
  assert.equal((await first.getSignatures(root)).size, 0)
  const audio = join(root, 'disc.flac')
  writeFileSync(audio, 'fixture')
  const next = new CueDirectoryIndex(['.flac'], cache)
  assert.equal((await next.derive(audio, 120, {}))?.length, 1)
  assert.equal(next.metrics.cueReads, 0)
  assert.equal(next.persistentCacheHits, 1)
})

function sqliteCueFixture(t: test.TestContext, count = 1, tracksPerFile = 2) {
  const root = mkdtempSync(join(tmpdir(), 'twilight-cue-compact-'))
  const db = new LibraryDatabase(join(root, 'library.sqlite'))
  db.updateConfiguration({ folders: [root], exclusions: [] })
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  t.after(() => {
    db.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('twilight-cue-compact-'))
    rmSync(root, { recursive: true, force: true })
  })
  const audio = (file: number) => join(root, `${file}.flac`)
  for (let file = 0; file < count; file++) {
    writeFileSync(audio(file), 'fixture')
    let text = `FILE "${file}.flac" WAVE\n`
    for (let track = 0; track < tracksPerFile; track++)
      text += `TRACK ${String(track + 1).padStart(2, '0')} AUDIO\nTITLE "Track ${file}-${track}"\nINDEX 01 ${String(track).padStart(2, '0')}:00:00\n`
    writeFileSync(join(root, `${file}.cue`), text)
  }
  const cache = {
    get: async (identity: LibraryCueDefinitionRecord['identity']) =>
      db.getScanCueDefinition('job', identity),
    put: async (record: LibraryCueDefinitionRecord) => db.putScanCueDefinition('job', record)
  }
  return { root, db, cache, audio }
}

test('SQLite dense-directory index retains only identities and projects exact tracks with one cache RPC in flight', async (t) => {
  const count = 80,
    tracksPerFile = 60
  const f = sqliteCueFixture(t, count, tracksPerFile)
  const get = f.cache.get
  let reads = 0,
    active = 0,
    peak = 0
  f.cache.get = async (identity) => {
    reads++
    peak = Math.max(peak, ++active)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      return await get(identity)
    } finally {
      active--
    }
  }
  const before = f.db.getMetadata()
  const index = new CueDirectoryIndex(['.flac'], f.cache)
  assert.equal((await index.getSignatures(f.root)).size, count)
  const state = index as unknown as {
    directories: Map<string, { value: Promise<Map<string, Array<{ definition?: unknown }>>> }>
    pendingDefinitions: Map<unknown, unknown>
  }
  for (const directory of state.directories.values())
    for (const entries of (await directory.value).values())
      assert.ok(
        entries.every((entry) => !entry.definition),
        'logical track definitions belong to SQLite, not the index'
      )
  for (let offset = 0; offset < count; offset += 4)
    await Promise.all(
      Array.from({ length: 4 }, async (_, i) => {
        const filePath = f.audio(offset + i)
        const base = { id: `base:${offset + i}`, filePath, replayGainTrackGainDb: -7.5 }
        const tracks = await index.derive(filePath, tracksPerFile * 60, base)
        assert.equal(tracks?.length, tracksPerFile)
        assert.equal(tracks![0].title, `Track ${offset + i}-0`)
        assert.equal(tracks![tracksPerFile - 1].cueRange.endSeconds, tracksPerFile * 60)
        assert.equal(tracks![0].replayGainTrackGainDb, -7.5)
        assert.equal((await index.getDependencies(filePath)).length, 2)
        if (offset + i === 0)
          assert.deepEqual(tracks, deriveCueTracks(filePath, tracksPerFile * 60, base, ['.flac']))
      })
    )
  assert.equal(peak, 1)
  assert.equal(reads, count * 2)
  assert.equal(state.pendingDefinitions.size, 0)
  assert.deepEqual(index.metrics, { directoryReads: 1, cueReads: count })
  assert.deepEqual(f.db.getMetadata(), before)
})

test('same-sheet definition reads coalesce only in flight and retain each projection duration', async (t) => {
  const f = sqliteCueFixture(t)
  const index = new CueDirectoryIndex(['.flac'], f.cache)
  await index.getSignatures(f.root)
  const get = f.cache.get
  let release!: () => void,
    entered!: () => void,
    calls = 0
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.cache.get = async (identity) => {
    calls++
    entered()
    await gate
    return get(identity)
  }
  const durations = [120, 180, 240]
  const pending = durations.map((duration) => index.derive(f.audio(0), duration, {}))
  await started
  assert.equal(calls, 1)
  release()
  const tracks = await Promise.all(pending)
  assert.deepEqual(
    tracks.map((value) => value![1].cueRange.endSeconds),
    durations
  )
  await index.derive(f.audio(0), 300, {})
  assert.equal(calls, 2, 'a settled definition is not retained in the directory index')
})

test('lost or failed persistent reads fail the file instead of silently replacing CUE tracks with their container', async (t) => {
  const f = sqliteCueFixture(t)
  const index = new CueDirectoryIndex(['.flac'], f.cache)
  await index.getSignatures(f.root)
  const get = f.cache.get
  f.cache.get = async () => null
  await assert.rejects(index.derive(f.audio(0), 120, {}), /definition is no longer available/)
  f.cache.get = async () => {
    throw new Error('database read failed')
  }
  await assert.rejects(index.derive(f.audio(0), 120, {}), /database read failed/)
  f.cache.get = get
  assert.equal(
    (await index.derive(f.audio(0), 120, {}))?.length,
    2,
    'failed reads release the serial lane and coalescer'
  )
  assert.equal(index.metrics.cueReads, 1, 'no filesystem reread fallback')
})
