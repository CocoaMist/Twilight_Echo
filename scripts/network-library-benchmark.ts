import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { createNetworkLibrary } from '../src/main/network/networkLibrary.ts'
import type { NetworkEntry } from '../src/shared/networkSources.ts'

// No application/native build. Fixture-only disk I/O; never opens a user's index.
const directory = await mkdtemp(join(tmpdir(), 'te-network-library-benchmark-'))
const collections: Array<{ durationMs: number; kind: number }> = []
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as unknown as { detail: { kind: number } }).detail
    collections.push({ durationMs: entry.duration, kind: detail.kind })
  }
})
observer.observe({ entryTypes: ['gc'] })
const makeEntry = (profileId: string, index: number): NetworkEntry => ({
  id: `${profileId}:${index}`,
  profileId,
  path: `/music/${index}.flac`,
  name: `Track ${index}`,
  kind: 'audio'
})
try {
  const filePath = join(directory, 'library.json')
  const library = createNetworkLibrary({ filePath })
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => {
      const id = `p${index}`
      return library.addEntries(id, '/music', [makeEntry(id, index)])
    })
  )
  assert.equal(Object.keys(JSON.parse(await readFile(filePath, 'utf8'))).length, 10)
  const profileIds = Array.from({ length: 10 }, (_, index) => `p${index}`)
  const fixture = Object.fromEntries(
    profileIds.map((id) => [
      id,
      {
        roots: ['/music'],
        entries: Array.from({ length: 1000 }, (_, index) => makeEntry(id, index))
      }
    ])
  )
  await writeFile(filePath, JSON.stringify(fixture), 'utf8')
  const sequential: number[] = [],
    snapshot: number[] = []
  const measure = async (batch: boolean): Promise<number> => {
    const start = performance.now()
    if (batch) {
      const rows = await library.searchEntries(profileIds, 'Track 99')
      assert.equal(rows.length, 110)
    } else {
      let matches = 0
      for (const id of profileIds) matches += (await library.listEntries(id, 'Track 99')).length
      assert.equal(matches, 110)
    }
    return performance.now() - start
  }
  for (let warmup = 0; warmup < 3; warmup++) {
    await measure(false)
    await measure(true)
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  collections.length = 0
  const memoryBefore = process.memoryUsage()
  // Alternate order to reduce warm-file/system-drift bias. No forced collection.
  for (let iteration = 0; iteration < 20; iteration++) {
    for (const batch of iteration % 2 ? [true, false] : [false, true]) {
      ;(batch ? snapshot : sequential).push(await measure(batch))
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return { p50Ms: sorted[9], p95Ms: sorted[18] }
  }
  const hashes: Record<string, string> = {}
  for (const relative of [
    'src/main/network/networkLibrary.ts',
    'src/main/network/networkLibraryPersistence.ts',
    'scripts/network-library-benchmark.ts'
  ]) {
    const text = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8')
    hashes[relative] = createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        rows: 10000,
        profiles: 10,
        warmupIterations: 3,
        iterations: 20,
        concurrentWrites: { expectedProfiles: 10, persistedProfiles: 10 },
        sequentialQueries: summarize(sequential),
        singleSnapshotQuery: summarize(snapshot),
        gc: {
          forced: false,
          count: collections.length,
          totalDurationMs: collections.reduce((sum, entry) => sum + entry.durationMs, 0)
        },
        memoryBefore,
        memoryAfter: process.memoryUsage(),
        sourceHashes: hashes,
        limits:
          'Controlled file-query microbenchmark; GC covers both variants together. Memory endpoints are not peak usage or retained-heap/leak proof. Not end-to-end playback or UI latency.'
      },
      null,
      2
    )
  )
} finally {
  observer.disconnect()
  await rm(directory, { recursive: true, force: true })
}
