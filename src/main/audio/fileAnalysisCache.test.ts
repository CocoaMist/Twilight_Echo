import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BPM_ANALYSIS_ALGORITHM_VERSION, BpmAnalysisCache } from '../bpm/bpmCache.ts'
import { LOUDNESS_ANALYSIS_ALGORITHM_VERSION, LoudnessAnalysisCache } from './loudnessCache.ts'

const identity = { filePath: 'D:\\Music\\song.flac', size: 123, mtimeMs: 456 }
interface Cache<Analysis> {
  get: (key: typeof identity) => Promise<Analysis | null>
  set: (key: typeof identity, analysis: Analysis) => Promise<void>
  deleteIfMatches: (key: typeof identity, analysis: Analysis) => Promise<boolean>
}

function cacheContract<Analysis extends { analyzedAt: string }>(
  name: string,
  create: (path: string) => Cache<Analysis>,
  analysis: Analysis
): void {
  test(`${name} serializes concurrent writes without losing entries and keeps the v1 format`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twilight-analysis-cache-concurrent-'))
    try {
      const path = join(dir, 'cache.json')
      const cache = create(path)
      const identities = Array.from({ length: 12 }, (_, size) => ({ ...identity, size }))
      await Promise.all(identities.map((key) => cache.set(key, analysis)))
      for (const key of identities) assert.deepEqual(await cache.get(key), analysis)
      const saved = JSON.parse(await readFile(path, 'utf-8'))
      assert.equal(saved.version, 1)
      assert.equal(Object.keys(saved.entries).length, identities.length)
      assert.deepEqual(await create(path).get(identities[0]!), analysis)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`${name} stale rollback waits for a newer write and cannot delete it`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twilight-analysis-cache-rollback-'))
    try {
      const cache = create(join(dir, 'cache.json'))
      await cache.set(identity, analysis)
      const newer = { ...analysis, analyzedAt: '2026-02-01T00:00:00.000Z' }
      const write = cache.set(identity, newer)
      const rollback = cache.deleteIfMatches(identity, analysis)
      const read = cache.get(identity)
      await write
      assert.equal(await rollback, false)
      assert.deepEqual(await read, newer)
      assert.equal(await cache.deleteIfMatches(identity, newer), true)
      assert.equal(await cache.get(identity), null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`${name} a failed write does not poison subsequent mutations`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twilight-analysis-cache-recovery-'))
    try {
      const path = join(dir, 'cache.json')
      await mkdir(path)
      const cache = create(path)
      await assert.rejects(cache.set(identity, analysis))
      await rm(path, { recursive: true })
      await cache.set(identity, analysis)
      assert.deepEqual(await cache.get(identity), analysis)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

cacheContract('BPM cache', (path) => new BpmAnalysisCache(path), {
  bpm: 128,
  confidence: 0.9,
  source: 'analyzed',
  algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION,
  analyzedAt: '2026-01-01T00:00:00.000Z'
})
cacheContract('loudness cache', (path) => new LoudnessAnalysisCache(path), {
  integratedLufs: -14,
  truePeakDb: -1,
  source: 'analyzed',
  algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION,
  analyzedAt: '2026-01-01T00:00:00.000Z'
})

test('loudness cache keeps unavailable measurements out of cache hits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-analysis-cache-unavailable-'))
  try {
    const cache = new LoudnessAnalysisCache(join(dir, 'cache.json'))
    await cache.set(identity, {
      integratedLufs: -14,
      truePeakDb: -1,
      source: 'analyzed',
      algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION,
      analyzedAt: '2026-01-01T00:00:00.000Z',
      available: false
    })
    assert.equal(await cache.get(identity), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
