import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProviderPlaybackSourceRegistry,
  providerAudioIdentity,
  type ProviderPlaybackSourceBinding
} from './providerPlaybackSources.ts'
const binding: ProviderPlaybackSourceBinding = {
  providerId: 'ncm',
  pluginId: 'builtin-ncm',
  args: [{ id: 'ncm:1' }, { quality: 'lossless' }],
  identity: {
    contentId: 'song:1:content-hash',
    quality: 'flac:actual-bitrate',
    durationSeconds: 100,
    seekable: true
  }
}
test('provider playback identity comes from a bounded trusted resolution and survives signed URL refresh', () => {
  let now = 0
  const registry = new ProviderPlaybackSourceRegistry(() => now, 2, 100)
  registry.register('https://cdn.example/music?expires=first', binding)
  const resolved = registry.get('https://cdn.example/music?expires=first', 'ncm:1')!
  assert.deepEqual(resolved.identity, binding.identity)
  resolved.identity.quality = 'changed'
  assert.deepEqual(
    registry.get('https://cdn.example/music?expires=first')!.identity,
    binding.identity
  )
  assert.equal(registry.get('https://cdn.example/music?expires=first', 'ncm:2'), null)
  registry.register('https://cdn.example/music?expires=second', binding)
  assert.deepEqual(
    registry.get('https://cdn.example/music?expires=second')!.identity,
    binding.identity
  )
  registry.register('https://cdn.example/third', binding)
  assert.equal(registry.get('https://cdn.example/music?expires=first'), null)
  now = 101
  assert.equal(registry.get('https://cdn.example/third'), null)
})
test('unknown identity, unseekable streams, credential URLs and oversized arguments do not become AutoMix sources', () => {
  const registry = new ProviderPlaybackSourceRegistry()
  assert.equal(providerAudioIdentity({ ...binding.identity, seekable: false }), null)
  assert.equal(
    providerAudioIdentity({ ...binding.identity, contentId: 'https://cdn/music?signature=x' }),
    null
  )
  registry.register('https://user:secret@cdn.example/music', binding)
  assert.equal(registry.get('https://user:secret@cdn.example/music'), null)
  registry.register('https://cdn.example/large', {
    ...binding,
    args: [{ id: 'ncm:1', lyrics: 'x'.repeat(32769) }]
  })
  assert.equal(registry.get('https://cdn.example/large'), null)
  registry.clear()
})
test('registration copies the trusted identity and normalizes the same URL as media grants', () => {
  const registry = new ProviderPlaybackSourceRegistry()
  const input = structuredClone(binding)
  registry.register('HTTPS://CDN.EXAMPLE', input)
  input.identity.quality = 'mutated'
  input.args[0] = { id: 'different' }
  assert.deepEqual(registry.get('https://cdn.example/', 'ncm:1'), binding)
})
