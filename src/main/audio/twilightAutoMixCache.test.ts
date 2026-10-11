import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutoMixFeatures } from '../../shared/twilightAutoMix.ts'
import {
  identifyTwilightAutoMixFile,
  TwilightAutoMixWindowCache,
  twilightAutoMixWindowKey,
  type TwilightAutoMixWindowIdentity
} from './twilightAutoMixCache.ts'

const identity = (start = 0, end = 30): TwilightAutoMixWindowIdentity => ({
  sourceIdentity: 'a'.repeat(64),
  sourceStartSeconds: 5,
  sourceEndSeconds: 65,
  parametersSha256: 'b'.repeat(64),
  modelVersion: `twilight-automix-native-1:${'c'.repeat(64)}:${'d'.repeat(64)}`,
  windowStartSeconds: start,
  windowEndSeconds: end
})
function features(i: TwilightAutoMixWindowIdentity): AutoMixFeatures {
  const start = i.windowStartSeconds,
    end = i.windowEndSeconds
  return {
    ok: true,
    algorithm: 'Twilight AutoMix',
    sourceIdentity: i.sourceIdentity,
    modelVersion: i.modelVersion,
    coverage: { startSeconds: start, endSeconds: end, durationSeconds: 60, complete: false },
    bpm: 120,
    tempoConfidence: 0.9,
    rmsDb: -12,
    peak: 0.3,
    key: -1,
    keyConfidence: 0,
    beats: [],
    downbeats: [],
    voice: [],
    frameDb: Array(Math.ceil((end - start) * 50)).fill(-12),
    framePeak: Array(Math.ceil((end - start) * 50)).fill(0.3)
  }
}
async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-native-automix-cache-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('cache identity binds actual source, CUE range, model, parameters and precise window', () => {
  const base = identity(),
    key = twilightAutoMixWindowKey(base)
  for (const patch of [
    { sourceIdentity: 'f'.repeat(64) },
    { sourceStartSeconds: 4 },
    { sourceEndSeconds: 70 },
    { modelVersion: `twilight-automix-native-1:${'e'.repeat(64)}:${'d'.repeat(64)}` },
    { parametersSha256: 'e'.repeat(64) },
    { windowStartSeconds: 0.00001 },
    { windowEndSeconds: 29.99 }
  ])
    assert.notEqual(twilightAutoMixWindowKey({ ...base, ...patch }), key)
  for (const patch of [
    { windowStartSeconds: NaN },
    { windowEndSeconds: 61 },
    { sourceIdentity: 'song-1' },
    { windowEndSeconds: 31 },
    { sourceEndSeconds: 5 }
  ])
    assert.throws(() => twilightAutoMixWindowKey({ ...base, ...patch }), /identity/)
})

test('partial windows keep honest coverage, including gaps and invalid complete claims', async () =>
  temporary(async (dir) => {
    const cache = new TwilightAutoMixWindowCache(join(dir, 'cache.json')),
      head = identity(),
      tail = identity(31, 60)
    await cache.set(head, features(head))
    await cache.set(tail, features(tail))
    assert.deepEqual(await cache.coverage(head), {
      complete: false,
      ranges: [
        [0, 30],
        [31, 60]
      ]
    })
    assert.equal((await cache.get(head))?.coverage.complete, false)
    const gap = identity(29, 32)
    await cache.set(gap, features(gap))
    assert.deepEqual(await cache.coverage(head), { complete: true, ranges: [[0, 60]] })
    assert.equal((await cache.get(head))?.coverage.complete, false)
    const dishonest = features(head)
    dishonest.coverage.complete = true
    await assert.rejects(cache.set(head, dishonest), /cover/)
    const short = features(head)
    short.coverage.endSeconds = 20
    short.frameDb.length = short.framePeak.length = 1000
    await assert.rejects(cache.set(head, short), /cover/)
  }))

test('cache returns independent values and serialises writes/clear without resurrection', async () =>
  temporary(async (dir) => {
    const file = join(dir, 'cache.json'),
      cache = new TwilightAutoMixWindowCache(file),
      head = identity(),
      tail = identity(30, 60)
    const original = features(head),
      saving = cache.set(head, original)
    original.frameDb[0] = -100
    await Promise.all([saving, cache.set(tail, features(tail))])
    const result = (await cache.get(head))!
    assert.equal(result.frameDb[0], -12)
    result.frameDb[0] = -80
    assert.equal((await cache.get(head))?.frameDb[0], -12)
    assert.ok(await cache.get(tail))
    await Promise.all([cache.set(head, features(head)), cache.clear()])
    assert.equal(await cache.get(head), null)
    await cache.set(head, features(head))
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    parsed.entries[twilightAutoMixWindowKey(head)].features.sourceIdentity = 'f'.repeat(64)
    await writeFile(file, JSON.stringify(parsed))
    assert.equal(await cache.get(head), null)
  }))

test('codec tail shorter than one analysis frame remains a reusable partial range', async () =>
  temporary(async (dir) => {
    const file = join(dir, 'cache.json'),
      cache = new TwilightAutoMixWindowCache(file),
      head = identity(),
      tail = identity(30, 60),
      actual = identity(30, 59.988),
      decoded = features(actual)
    await cache.set(head, features(head))
    await cache.set(tail, decoded)
    const stored = JSON.parse(await readFile(file, 'utf8')).entries
    assert.equal(stored[twilightAutoMixWindowKey(tail)], undefined)
    assert.equal(stored[twilightAutoMixWindowKey(actual)].identity.windowEndSeconds, 59.988)
    assert.equal((await cache.get(tail))?.coverage.endSeconds, 59.988)
    assert.deepEqual(await cache.coverage(tail), { complete: false, ranges: [[0, 59.988]] })
    for (const patch of [
      { sourceIdentity: 'e'.repeat(64) },
      { parametersSha256: 'e'.repeat(64) },
      { sourceEndSeconds: 70 }
    ])
      assert.equal(await cache.get({ ...tail, ...patch }), null)
    await assert.rejects(cache.set(tail, features(identity(30, 59.97))), /cover/)
    await assert.rejects(cache.set(head, features(identity(0, 29.988))), /cover/)
    const dishonest = structuredClone(decoded)
    dishonest.coverage.complete = true
    await assert.rejects(cache.set(tail, dishonest), /cover/)
  }))

test('cache evicts to budget and corrupt/oversized caches remain misses', async () =>
  temporary(async (dir) => {
    const file = join(dir, 'cache.json'),
      cache = new TwilightAutoMixWindowCache(file, 1)
    const head = identity(),
      tail = identity(30, 60)
    await cache.set(head, features(head))
    await cache.set(tail, features(tail))
    assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).entries).length, 1)
    await writeFile(file, '{broken')
    assert.equal(await cache.get(head), null)
    await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1))
    assert.equal(await cache.get(head), null)
  }))

test('actual file identity supports Chinese paths, observes changed bytes, and aborts', async () =>
  temporary(async (dir) => {
    const file = join(dir, '中文曲目.flac'),
      bytes = Buffer.from('actual audio source fixture')
    await writeFile(file, bytes)
    assert.equal(
      await identifyTwilightAutoMixFile(file),
      createHash('sha256').update(bytes).digest('hex')
    )
    const first = await identifyTwilightAutoMixFile(file)
    await writeFile(file, Buffer.from('changed audio source bytes'))
    assert.notEqual(await identifyTwilightAutoMixFile(file), first)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(identifyTwilightAutoMixFile(file, abort.signal), /abort/i)
    await writeFile(file, Buffer.alloc(0))
    await assert.rejects(identifyTwilightAutoMixFile(file), /nonempty/)
  }))
