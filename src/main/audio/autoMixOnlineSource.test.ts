import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAutoMixOnlineResolver } from './autoMixOnlineSource.ts'
import { ProviderPlaybackSourceRegistry } from '../security/providerPlaybackSources.ts'
import { RemoteMediaGrantService } from '../security/remoteMediaGrants.ts'

test('online refresh retains provider ownership, arguments and actual content identity before authorization', async () => {
  const registry = new ProviderPlaybackSourceRegistry()
  const identity = {
    contentId: 'ncm:1:actual-hash',
    quality: 'actual-flac',
    durationSeconds: 100,
    seekable: true as const
  }
  registry.register('https://cdn.example/old', {
    providerId: 'ncm',
    pluginId: 'trusted-owner',
    args: [{ id: 'ncm:1' }, { quality: 'hires' }, 'extra'],
    identity
  })
  const grants = new RemoteMediaGrantService()
  const fresh = grants.grant('https://cdn.example/fresh', 'audio')
  let authorized = 0
  const resolve = createAutoMixOnlineResolver({
    registry,
    callProvider: async (provider, method, args, options) => {
      assert.equal(provider, 'ncm')
      assert.equal(method, 'getPlaybackUrl')
      assert.deepEqual(args, [{ id: 'ncm:1' }, { quality: 'hires', force: true }, 'extra'])
      assert.deepEqual(options, {
        expectedPluginId: 'trusted-owner',
        returnAutoMixSourceIdentity: true
      })
      return { streamUrl: fresh, autoMixIdentity: identity }
    },
    authorize: async (source) => {
      authorized++
      return grants.resolve(source, 'audio').source
    }
  })
  assert.deepEqual(await resolve({ id: 'ncm:1', source: 'https://cdn.example/old' }), {
    source: 'https://cdn.example/fresh',
    contentId: JSON.stringify(['trusted-owner', 'ncm', identity.contentId]),
    quality: identity.quality,
    durationSeconds: 100
  })
  assert.equal(await resolve({ id: 'ncm:2', source: 'https://cdn.example/old' }), null)
  assert.equal(authorized, 1)
})

test('changed content, duration, quality or missing identity cannot authorize intelligent preparation', async () => {
  const registry = new ProviderPlaybackSourceRegistry()
  const identity = {
    contentId: 'actual-hash',
    quality: 'flac',
    durationSeconds: 100,
    seekable: true as const
  }
  registry.register('https://cdn.example/old', {
    providerId: 'ncm',
    pluginId: 'owner',
    args: [{}],
    identity
  })
  for (const updated of [
    null,
    { ...identity, contentId: 'different' },
    { ...identity, quality: 'mp3' },
    { ...identity, durationSeconds: 101 },
    { ...identity, seekable: false }
  ]) {
    const resolve = createAutoMixOnlineResolver({
      registry,
      callProvider: async () => ({
        streamUrl: 'https://cdn.example/fresh',
        autoMixIdentity: updated
      }),
      authorize: async () => {
        throw new Error('invalid identity must be rejected before authorization')
      }
    })
    assert.equal(await resolve({ source: 'https://cdn.example/old' }), null)
  }
})
