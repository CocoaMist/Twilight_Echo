import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutoMixCoordinator, type AutoMixPairSnapshot } from './autoMixCoordinator.ts'
import { AUTO_MIX_MODEL_HASHES, type AutoMixFeatures } from '../../shared/autoMix.ts'
const feature = (segment: 'head' | 'tail'): AutoMixFeatures => ({
  schemaVersion: 1,
  analysisVersion: 4,
  available: true,
  provenance: 'independent-beat-this-yamnet-v1',
  durationSeconds: 100,
  modelHashes: AUTO_MIX_MODEL_HASHES,
  windows: {
    [segment]: {
      sourceStart: segment === 'head' ? 0 : 55,
      sourceEnd: segment === 'head' ? 45 : 100,
      energyHopSeconds: 0.02,
      energyDbfs: [-20],
      key: null,
      phraseBoundaries: null,
      beatKnown: false,
      beats: null,
      downbeats: null,
      stableRegions: null,
      vocalKnown: false,
      vocalWindows: null
    }
  }
})
test('AutoMix analysis is sequential, cached and delivered only once per pair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'automix-coordinator-'))
  try {
    const outgoing = { id: 'a', source: join(dir, 'a.flac') },
      incoming = { id: 'b', source: join(dir, 'b.flac') }
    await Promise.all([writeFile(outgoing.source, 'a'), writeFile(incoming.source, 'b')])
    const pair: AutoMixPairSnapshot = {
      queueToken: 'q',
      outgoing,
      incoming,
      status: {
        enabled: true,
        state: 'ready',
        progress: 0,
        transitionSeconds: 4,
        styleId: 1,
        reason: '',
        configRevision: 1,
        pairRevision: 1
      }
    }
    const cache = new Map<string, AutoMixFeatures>()
    let active = 0,
      peak = 0,
      analyzed = 0,
      deliveries = 0
    const coordinator = new AutoMixCoordinator(
      {
        snapshot: async () => pair,
        analyze: async (_, options) => {
          active++
          peak = Math.max(peak, active)
          analyzed++
          await new Promise((r) => setImmediate(r))
          active--
          return feature(JSON.parse(options).segment)
        },
        deliver: async (text) => {
          const body = JSON.parse(text)
          assert.equal(body.pairRevision, 1)
          deliveries++
          pair.status.featuresDelivered = true
          pair.status.pairRevision = 2
        }
      },
      {
        get: async (id) => cache.get(id.contentId) ?? null,
        put: async (id, value) => {
          cache.set(id.contentId, value)
        }
      }
    )
    await Promise.all([coordinator.update(), coordinator.update(), coordinator.update()])
    await coordinator.update()
    assert.equal(peak, 1)
    assert.equal(analyzed, 2)
    assert.equal(deliveries, 1)
    pair.status.featuresDelivered = false
    pair.status.pairRevision = 3
    await coordinator.update()
    assert.equal(analyzed, 2) // hot features reused after a seek
    coordinator.destroy()
    await coordinator.update()
    assert.equal(analyzed, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('AutoMix discards an analysis completion after queue revision changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'automix-stale-'))
  try {
    const source = join(dir, 'a.flac')
    await writeFile(source, 'a')
    const pair: AutoMixPairSnapshot = {
      queueToken: 'q',
      outgoing: { source },
      incoming: { source },
      status: {
        enabled: true,
        state: 'ready',
        progress: 0,
        transitionSeconds: 4,
        styleId: 1,
        reason: '',
        configRevision: 1,
        pairRevision: 1
      }
    }
    let delivered = false,
      analyzed = 0
    const coordinator = new AutoMixCoordinator(
      {
        snapshot: async () => pair,
        analyze: async () => {
          analyzed++
          pair.queueToken = 'new'
          return feature('tail')
        },
        deliver: async () => {
          delivered = true
        }
      },
      { get: async () => null, put: async () => {} }
    )
    await coordinator.update()
    assert.equal(delivered, false)
    assert.equal(analyzed, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('online features authorize before cache access, survive URL refresh and deliver fresh preparation sources', async () => {
  const pair: AutoMixPairSnapshot = {
    queueToken: 'q',
    outgoing: { id: 'a', source: 'https://cdn/a?old' },
    incoming: { id: 'b', source: 'https://cdn/b?old' },
    status: {
      enabled: true,
      state: 'ready',
      progress: 0,
      transitionSeconds: 4,
      styleId: 1,
      reason: '',
      configRevision: 1,
      pairRevision: 1
    }
  }
  type Delivery = {
    outgoing: { source: string; preparationSource: string }
    incoming: { preparationSource: string }
  }
  const cache = new Map<string, AutoMixFeatures>(),
    order: string[] = []
  let refresh = 0,
    delivery: Delivery | undefined,
    analyzed = 0
  const coordinator = new AutoMixCoordinator(
    {
      snapshot: async () => pair,
      resolveOnline: async (track) => {
        order.push(`authorize:${track.id}`)
        return {
          source: `https://cdn/${track.id}?fresh=${++refresh}`,
          contentId: `provider:actual-hash:${track.id}`,
          quality: 'actual-flac',
          durationSeconds: 100
        }
      },
      analyze: async (source, options) => {
        analyzed++
        assert.match(source, /fresh=/)
        return feature(JSON.parse(options).segment)
      },
      deliver: async (text) => {
        delivery = JSON.parse(text)
        pair.status.featuresDelivered = true
      }
    },
    {
      get: async (id) => {
        order.push(`cache:${id.contentId}`)
        return cache.get(id.contentId) ?? null
      },
      put: async (id, features) => {
        assert.equal(id.quality, 'actual-flac')
        cache.set(id.contentId, features)
      }
    }
  )
  await coordinator.update()
  assert.equal(analyzed, 2)
  assert.ok(delivery)
  assert.equal(delivery.outgoing.source, pair.outgoing.source)
  assert.equal(delivery.outgoing.preparationSource, 'https://cdn/a?fresh=5')
  assert.equal(delivery.incoming.preparationSource, 'https://cdn/b?fresh=6')
  assert.deepEqual(order.slice(0, 2), ['authorize:a', 'cache:provider:actual-hash:a'])
  pair.status.featuresDelivered = false
  pair.status.pairRevision = 2
  await coordinator.update()
  assert.equal(analyzed, 2)
  assert.equal(delivery.outgoing.preparationSource, 'https://cdn/a?fresh=9')
})
test('online authorization failure or a changed actual quality cannot deliver a cached or analyzed plan', async () => {
  for (const fail of [true, false]) {
    const pair: AutoMixPairSnapshot = {
      queueToken: 'q',
      outgoing: { id: 'a', source: 'https://cdn/a' },
      incoming: { id: 'b', source: 'https://cdn/b' },
      status: {
        enabled: true,
        state: 'ready',
        progress: 0,
        transitionSeconds: 4,
        styleId: 1,
        reason: '',
        configRevision: 1,
        pairRevision: 1
      }
    }
    let called = 0,
      delivered = false,
      cached = false
    const coordinator = new AutoMixCoordinator(
      {
        snapshot: async () => pair,
        resolveOnline: async () => {
          called++
          if (fail) throw new Error('authorization expired')
          return {
            source: 'https://cdn/a?fresh',
            contentId: 'provider:hash',
            quality: called === 1 ? 'flac' : 'mp3',
            durationSeconds: 100
          }
        },
        analyze: async () => feature('tail'),
        deliver: async () => {
          delivered = true
        }
      },
      {
        get: async () => {
          cached = true
          return null
        },
        put: async () => {
          throw new Error('changed quality must not be cached')
        }
      }
    )
    await coordinator.update()
    assert.equal(delivered, false)
    assert.equal(cached, !fail)
  }
})
