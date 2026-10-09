import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoMixFeatureCache, type AutoMixCacheIdentity } from './autoMixFeatureCache.ts'
import {
  AUTO_MIX_MODEL_HASHES,
  isAutoMixAnalysisResult,
  normalizeAutoMix,
  type AutoMixFeatures
} from '../../shared/autoMix.ts'

const identity: AutoMixCacheIdentity = {
  contentId: 'provider:track:123',
  quality: 'lossless',
  analysisVersion: 4,
  beatThisHash: AUTO_MIX_MODEL_HASHES.beatThis,
  yamnetHash: AUTO_MIX_MODEL_HASHES.yamnet
}
const features: AutoMixFeatures = {
  schemaVersion: 1,
  analysisVersion: 4,
  available: true,
  provenance: 'independent-beat-this-yamnet-v1',
  durationSeconds: 200,
  modelHashes: AUTO_MIX_MODEL_HASHES,
  windows: {
    head: {
      sourceStart: 0,
      sourceEnd: 45,
      energyDbfs: [-10, -20],
      energyHopSeconds: 0.02,
      beatKnown: false,
      beats: null,
      downbeats: null,
      stableRegions: null,
      vocalKnown: false,
      vocalWindows: null,
      key: null,
      phraseBoundaries: null
    }
  }
}

test('AutoMix defaults and independent unknown feature contract remain explicit', () => {
  assert.deepEqual(normalizeAutoMix(undefined), {
    enabled: false,
    allowIntelligentSkip: true,
    maxTransitionSeconds: 12
  })
  assert.equal(normalizeAutoMix({ maxTransitionSeconds: NaN }).maxTransitionSeconds, 12)
  assert.equal(normalizeAutoMix({ maxTransitionSeconds: 100 }).maxTransitionSeconds, 12)
  assert.equal(isAutoMixAnalysisResult(features), true)
  assert.equal(isAutoMixAnalysisResult({ ...features, analysisVersion: 1 }), false)
  assert.equal(isAutoMixAnalysisResult({ ...features, analysisVersion: 2 }), false)
  assert.equal(isAutoMixAnalysisResult({ ...features, analysisVersion: 3 }), false)
  assert.equal(
    isAutoMixAnalysisResult({
      ...features,
      windows: { head: { ...features.windows.head, beatKnown: true } }
    }),
    false
  )
  assert.equal(
    isAutoMixAnalysisResult({
      ...features,
      modelHashes: { ...AUTO_MIX_MODEL_HASHES, yamnet: 'wrong' }
    }),
    false
  )
})

test('AutoMix feature cache isolates entries, validates integrity and does not use signed URLs as identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-automix-cache-'))
  try {
    const cache = new AutoMixFeatureCache(directory)
    await cache.put(identity, features)
    const loaded = await cache.get(identity)
    assert.deepEqual(loaded, features)
    if (loaded?.windows.head) loaded.windows.head.energyDbfs[0] = 100
    assert.deepEqual(await cache.get(identity), features)
    assert.equal(await cache.get({ ...identity, quality: '128k' }), null)
    await assert.rejects(
      cache.put({ ...identity, contentId: 'https://cdn/song?expires=123' }, features),
      /identity/
    )
    const [entry] = await readdir(directory)
    const corrupted = JSON.parse(await readFile(join(directory, entry), 'utf8'))
    corrupted.payload = corrupted.payload.replace('-10', '-99')
    await writeFile(join(directory, entry), JSON.stringify(corrupted))
    assert.equal(await new AutoMixFeatureCache(directory).get(identity), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('AutoMix disk and pending memory budgets reject excess data and evict whole feature files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-automix-budget-'))
  try {
    const cache = new AutoMixFeatureCache(directory, 1500)
    for (let i = 0; i < 8; ++i) await cache.put({ ...identity, contentId: `track:${i}` }, features)
    const files = await readdir(directory)
    const sizes = await Promise.all(
      files.map(async (f) => Buffer.byteLength(await readFile(join(directory, f))))
    )
    assert.ok(sizes.reduce((a, b) => a + b, 0) <= 1500)
    assert.ok(files.length < 8)
    await assert.rejects(
      new AutoMixFeatureCache(directory, 20).put(identity, features),
      /entry exceeds/
    )
    await assert.rejects(
      new AutoMixFeatureCache(directory, 1500, 20).put(identity, features),
      /memory limit/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
