import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderPlaybackIdentityRegistry } from './providerPlaybackIdentity.ts'

test('requested quality never substitutes for unknown actual quality', () => {
  const r = new ProviderPlaybackIdentityRegistry()
  r.record('ncm', '1', 'hires', 'https://cdn.example/1.mp3')
  assert.equal(r.get('https://cdn.example/1.mp3')?.actualQuality, null)
})
test('refresh, actual quality, and exact cache path changes revoke old resolution', () => {
  const r = new ProviderPlaybackIdentityRegistry(),
    changed: string[][] = []
  r.on('changed', (sources) => changed.push(sources))
  const first = {
    streamUrl: 'D:/cache/1.a.flac',
    providerSource: {
      originSource: 'https://cdn.example/1?token=a',
      actualQuality: 'lossless',
      sampleRate: 44100
    }
  }
  r.record('ncm', '1', 'hires', first)
  const revision = r.revision(first.streamUrl)
  r.record('ncm', '1', 'hires', first)
  assert.equal(r.revision(first.streamUrl), revision)
  assert.equal(changed.length, 1)
  r.record('ncm', '1', 'hires', {
    ...first,
    providerSource: {
      ...first.providerSource,
      originSource: 'https://cdn.example/1?token=b',
      actualQuality: 'hires'
    }
  })
  assert.notEqual(r.revision(first.streamUrl), revision)
  r.record('ncm', '1', 'standard', 'D:/cache/1.b.mp3')
  assert.throws(() => r.assertCurrent(first.streamUrl), /resolution_changed/)
  assert.doesNotThrow(() => r.assertCurrent('D:/cache/1.b.mp3'))
  assert.doesNotThrow(() => r.assertCurrent('D:/local/unregistered.flac'))
})
test('expired addresses cannot prepare, but cached bytes do not inherit URL expiry', () => {
  const r = new ProviderPlaybackIdentityRegistry()
  r.record('ncm', '1', 'standard', {
    streamUrl: 'https://cdn.example/expired',
    providerSource: { expiresAt: 1 }
  })
  assert.throws(() => r.assertCurrent('https://cdn.example/expired'), /expired/)
  r.record('ncm', '1', 'standard', {
    streamUrl: 'D:/cache/1.flac',
    providerSource: { expiresAt: 1 }
  })
  assert.doesNotThrow(() => r.assertCurrent('D:/cache/1.flac'))
})
