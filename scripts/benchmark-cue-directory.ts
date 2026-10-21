import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CueDirectoryIndex } from '../src/main/library/cueLibrary.ts'
import { LibraryDatabase } from '../src/main/library/libraryDatabase.ts'

// Synthetic CUE syntax + actual filesystem/SQLite. Audio files are placeholders;
// this measures the scan index, not media decoding, Electron or IPC latency.
// node --expose-gc --experimental-strip-types scripts/benchmark-cue-directory.ts 5000 60 tmp/sqlite-cue-density.json
const files = Number(process.argv[2] ?? 5_000)
const tracksPerFile = Number(process.argv[3] ?? 60)
assert.ok(Number.isSafeInteger(files) && files > 0 && files <= 100_000)
assert.ok(Number.isSafeInteger(tracksPerFile) && tracksPerFile > 0 && tracksPerFile <= 99)
const output = process.argv[4] ? resolve(process.argv[4]) : null
const scratch = resolve('tmp')
mkdirSync(scratch, { recursive: true })
const root = mkdtempSync(join(scratch, 'sqlite-cue-density-'))
const media = join(root, 'media')
mkdirSync(media)
let database: LibraryDatabase | undefined
const mib = (bytes: number) => bytes / 1024 ** 2
const memory = () => {
  const { rss, heapUsed } = process.memoryUsage()
  return { rssMiB: mib(rss), heapMiB: mib(heapUsed) }
}

try {
  const creationStart = performance.now()
  for (let file = 0; file < files; file++) {
    writeFileSync(join(media, `${file}.flac`), 'fixture')
    let cue = `PERFORMER "Artist ${file}"\nTITLE "Album ${file}"\nFILE "${file}.flac" WAVE\n`
    for (let track = 0; track < tracksPerFile; track++)
      cue += `TRACK ${String(track + 1).padStart(2, '0')} AUDIO\nTITLE "${file}-${track} ${'密集目录曲目标题'.repeat(8)}"\nINDEX 01 ${String(track).padStart(2, '0')}:00:00\n`
    writeFileSync(join(media, `${file}.cue`), cue)
  }
  const creationMs = performance.now() - creationStart
  database = new LibraryDatabase(join(root, 'library.sqlite'))
  const db = database
  db.updateConfiguration({ folders: [media], exclusions: [] })
  db.startScan({ id: 'benchmark', mode: 'full', roots: [media] })
  const metadata = db.getMetadata()
  const measurePass = async (name: string) => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc?.()
    const baseline = memory()
    let peakRssMiB = baseline.rssMiB
    const sample = () => {
      peakRssMiB = Math.max(peakRssMiB, memory().rssMiB)
    }
    let cacheGets = 0,
      cachePuts = 0
    const index = new CueDirectoryIndex(['.flac'], {
      get: async (identity) => {
        cacheGets++
        const result = db.getScanCueDefinition('benchmark', identity)
        sample()
        return result
      },
      put: async (record) => {
        cachePuts++
        db.putScanCueDefinition('benchmark', record)
        sample()
      }
    })
    const buildStart = performance.now()
    const signatures = await index.getSignatures(media)
    const buildMs = performance.now() - buildStart
    assert.equal(signatures.size, files)
    global.gc?.()
    const indexed = memory()
    // Inspect the actual retained cache rather than inferring it from a heap delta.
    const directories = (
      index as unknown as {
        directories: Map<
          string,
          { value: Promise<Map<string, Array<{ definition?: { tracks: unknown[] } }>>> }
        >
      }
    ).directories
    let retainedDefinitions = 0,
      retainedRawTracks = 0
    for (const entry of directories.values())
      for (const entries of (await entry.value).values())
        for (const cue of entries) {
          if (!cue.definition) continue
          retainedDefinitions++
          retainedRawTracks += cue.definition.tracks.length
        }
    const deriveStart = performance.now()
    let projectedTracks = 0
    for (let offset = 0; offset < files; offset += 4) {
      await Promise.all(
        Array.from({ length: Math.min(4, files - offset) }, async (_, i) => {
          const file = offset + i
          const audio = join(media, `${file}.flac`)
          const tracks = await index.derive(audio, tracksPerFile * 60, {
            id: `file:${file}`,
            filePath: audio
          })
          assert.equal(tracks?.length, tracksPerFile)
          assert.equal(tracks![0].title.toString().startsWith(`${file}-0 `), true)
          assert.equal(tracks![tracksPerFile - 1].cueRange.endSeconds, tracksPerFile * 60)
          assert.equal((await index.getDependencies(audio)).length, 2)
          projectedTracks += tracks!.length
        })
      )
      sample()
    }
    assert.equal(projectedTracks, files * tracksPerFile)
    return {
      name,
      buildMs,
      deriveMs: performance.now() - deriveStart,
      baseline,
      indexed,
      retainedHeapMiB: indexed.heapMiB - baseline.heapMiB,
      peakRssMiB,
      retainedDefinitions,
      retainedRawTracks,
      projectedTracks,
      cacheGets,
      cachePuts,
      persistentCacheHits: index.persistentCacheHits,
      ...index.metrics
    }
  }
  const passes = []
  for (const name of ['cold', 'warm']) passes.push(await measurePass(name))
  assert.deepEqual(db.getMetadata(), metadata)
  const report = {
    syntheticAudioFiles: files,
    cueFiles: files,
    logicalTracks: files * tracksPerFile,
    tracksPerFile,
    creationMs,
    passes,
    overallPeakRssMiB: process.resourceUsage().maxRSS / 1024,
    libraryUnchanged: true
  }
  console.log(JSON.stringify(report, null, 2))
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
} finally {
  database?.close()
  assert.equal(dirname(resolve(root)), scratch)
  assert.ok(basename(root).startsWith('sqlite-cue-density-'))
  rmSync(root, { recursive: true, force: true })
}
