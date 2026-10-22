import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openLibraryDatabase } from '../src/main/library/libraryDatabase.ts'

// Synthetic metadata/SQL benchmark, not real media, renderer or Electron evidence.
// node --expose-gc --experimental-strip-types scripts/benchmark-library-selection.ts 300000 tmp/sqlite-selection-300k.json
const count = Number(process.argv[2] ?? 300_000)
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Expected a positive track count')
const output = process.argv[3] ? resolve(process.argv[3]) : null
const root = mkdtempSync(join(tmpdir(), 'twilight-selection-benchmark-'))
let database: Awaited<ReturnType<typeof openLibraryDatabase>> | undefined
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
const summary = (values: number[]) => ({
  count: values.length,
  p95Ms: p95(values),
  maxMs: Math.max(...values)
})
try {
  const json = join(root, 'music-library.json'),
    stream = createWriteStream(json)
  const append = async (text: string) => {
    if (!stream.write(text)) await once(stream, 'drain')
  }
  await append('{"version":2,"revision":17,"folders":[],"exclusions":[],"tracks":[')
  let buffer = ''
  for (let i = 0; i < count; i++) {
    buffer +=
      (i ? ',' : '') +
      JSON.stringify({
        id: `t${i}`,
        filePath: join(root, `${Math.floor(i / 3)}.flac`),
        title: `月光 ${String(i).padStart(6, '0')}`,
        artist: 'Artist',
        source: 'local',
        duration: 100,
        cueRange: { startSeconds: (i % 3) * 100, endSeconds: ((i % 3) + 1) * 100 },
        extension: 'x'.repeat(512),
        lyrics: 'not part of selection intent'
      })
    if (buffer.length >= 64 * 1024) {
      await append(buffer)
      buffer = ''
    }
  }
  await append(buffer + ']}')
  stream.end()
  await once(stream, 'finish')
  const migrationStart = performance.now()
  database = await openLibraryDatabase(json)
  const db = database,
    migrationMs = performance.now() - migrationStart,
    metadata = db.getMetadata()
  assert.equal(metadata.trackCount, count)
  assert.equal(metadata.fileCount, Math.ceil(count / 3))
  global.gc?.()
  const baselineRss = process.memoryUsage().rss,
    builds: number[] = [],
    probes: number[] = []
  let peakRss = baselineRss
  const measureMemory = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const start = performance.now(),
    preparation = db.beginTrackSelectionBuild({
      query: { contentRevision: metadata.revision, sort: 'title' },
      total: count,
      ranges: [[0, count]]
    })
  let snapshot
  for (;;) {
    const batchStart = performance.now(),
      result = db.advanceTrackSelectionBuild(preparation)
    builds.push(performance.now() - batchStart)
    assert.equal(db.sql.isTransaction, false)
    measureMemory()
    if (builds.length % 20 === 1) {
      const probe = performance.now()
      assert.equal(db.getTracksByIds(['t0']).tracks.length, 1)
      probes.push(performance.now() - probe)
    }
    if (result.ready) {
      snapshot = result.snapshot
      break
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const buildMs = performance.now() - start
  assert.equal(snapshot.selectedCount, count)
  assert.equal(snapshot.fileCount, Math.ceil(count / 3))
  const reads: number[] = []
  let cursor: number | null = 0,
    consumed = 0,
    maxRows = 0
  const readStart = performance.now()
  do {
    const before = performance.now(),
      page = db.readTrackSelection(snapshot.id, cursor)
    reads.push(performance.now() - before)
    maxRows = Math.max(maxRows, page.rows.length)
    for (const row of page.rows) {
      assert.equal(row.position, consumed)
      assert.equal(row.track.id, `t${consumed}`)
      assert.equal(row.instance, consumed + 1)
      assert.equal(row.version, 1)
      assert.deepEqual(row.track.cueRange, {
        startSeconds: (consumed % 3) * 100,
        endSeconds: ((consumed % 3) + 1) * 100
      })
      assert.equal(row.track.extension, undefined)
      consumed++
    }
    cursor = page.nextCursor
    measureMemory()
  } while (cursor !== null)
  const readMs = performance.now() - readStart
  assert.equal(consumed, count)
  assert.ok(maxRows <= 200)
  cursor = 0
  let files = 0
  do {
    const page = db.readTrackSelection(snapshot.id, cursor, 'files')
    files += page.rows.length
    cursor = page.nextCursor
    measureMemory()
  } while (cursor !== null)
  assert.equal(files, Math.ceil(count / 3))
  db.closeTrackSelection(snapshot.id)
  const cleanupStart = performance.now(),
    cleanup: number[] = []
  while (db.needsQueryMaintenance) {
    const before = performance.now()
    db.maintainQueryState()
    cleanup.push(performance.now() - before)
    assert.equal(db.sql.isTransaction, false)
    measureMemory()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const report = {
    syntheticTracks: count,
    syntheticFiles: files,
    migrationMs,
    buildMs,
    readMs,
    build: summary(builds),
    read: summary(reads),
    ordinaryReadProbes: summary(probes),
    cleanupMs: performance.now() - cleanupStart,
    cleanup: summary(cleanup),
    maxReadRows: maxRows,
    rowIncarnationsValidated: true,
    baselineRssMiB: baselineRss / 1024 ** 2,
    selectionPeakRssMiB: peakRss / 1024 ** 2,
    overallPeakRssMiB: process.resourceUsage().maxRSS / 1024,
    libraryUnchanged: JSON.stringify(db.getMetadata()) === JSON.stringify(metadata),
    remainingRows: db.sql.prepare('SELECT count(*) AS n FROM selection_rows').get()!.n,
    remainingFileKeys: db.sql.prepare('SELECT count(*) AS n FROM selection_files').get()!.n
  }
  assert.equal(report.libraryUnchanged, true)
  assert.equal(report.remainingRows, 0)
  assert.equal(report.remainingFileKeys, 0)
  console.log(JSON.stringify(report, null, 2))
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
} finally {
  database?.close()
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('twilight-selection-benchmark-'))
  rmSync(root, { recursive: true, force: true })
}
