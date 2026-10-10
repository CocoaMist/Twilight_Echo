import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { findProviderRoute, getProviderCallTimeoutMs } from './providerRouting.ts'
import { PluginRpcCoordinator, resolveProviderIdempotencyKey } from './rpcCoordinator.ts'
import { isPluginHostedPlaybackUrl } from './hostIdle.ts'
import {
  ProviderPlaybackSourceRegistry,
  providerAudioIdentity
} from '../security/providerPlaybackSources.ts'
import { protectProviderMedia, remoteMediaGrants } from '../security/remoteMediaGrants.ts'
import type { TwilightProviderCallOptions } from './manager.ts'
import type { TwilightMediaProviderMethod } from './types.ts'

const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8').replaceAll(
  '\r\n',
  '\n'
)
const start = source.indexOf('export class TwilightPluginManager')
const classSource = source.slice(start, source.indexOf('\n}\n', start) + 3)
const identity = {
  contentId: 'fixture:actual-hash',
  quality: 'actual-flac',
  durationSeconds: 100,
  seekable: true
}

interface HarnessManager {
  callProvider(
    provider: string,
    method: TwilightMediaProviderMethod,
    args: unknown[],
    options?: TwilightProviderCallOptions
  ): Promise<unknown>
  handleProviderResult(plugin: string, response: unknown): void
}

function harness() {
  const registry = new ProviderPlaybackSourceRegistry()
  const Manager = runInNewContext(
    `${stripTypeScriptTypes(classSource.replace('export class', 'class'))}\nTwilightPluginManager`,
    {
      EventEmitter,
      randomUUID,
      structuredClone,
      findProviderRoute,
      getProviderCallTimeoutMs,
      resolveProviderIdempotencyKey,
      providerAudioIdentity,
      providerPlaybackSources: registry,
      protectProviderMedia,
      isPluginHostedPlaybackUrl
    }
  ) as { prototype: HarnessManager }
  const calls: { requestId: string; args: unknown[] }[] = []
  const running = {
    descriptor: { id: 'owner', enabled: true },
    hasPlaybackProxy: false,
    providers: [
      { id: 'fixture', capabilities: ['playbackUrl'], supportedMethods: ['getPlaybackUrl'] }
    ],
    process: {
      postMessage: (message: { requestId: string; args: unknown[] }) => calls.push(message)
    }
  }
  const manager = Object.assign(Object.create(Manager.prototype) as HarnessManager, {
    running: new Map([['owner', running]]),
    hostIdle: null,
    rpcCalls: new PluginRpcCoordinator(),
    contributingPlugins: () => [running],
    ensureRunningForCall: async () => running,
    assertRunningPlugin: () => {},
    recordProviderCallSuccess: () => {},
    recordProviderCallFailure: () => {},
    cancelHostRpc: () => {}
  })
  return { manager, registry, running, calls }
}

test('settled provider envelope returns a protected URL, copies request identity and pins proxy hosts', async () => {
  const { manager, registry, running, calls } = harness()
  const args = [{ id: 'track' }, { quality: 'hires' }, 'extra']
  const pending = manager.callProvider('fixture', 'getPlaybackUrl', args)
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), [
    { id: 'track' },
    { quality: 'hires', autoMixSource: true },
    'extra'
  ])
  args[0] = { id: 'changed-after-dispatch' }
  manager.handleProviderResult('owner', {
    requestId: calls[0].requestId,
    ok: true,
    value: { streamUrl: 'http://127.0.0.1:1234/audio', autoMixIdentity: identity }
  })
  const url = (await pending) as string
  assert.match(url, /^twilight-media:\/\/audio\//)
  assert.equal(remoteMediaGrants.resolve(url, 'audio').source, 'http://127.0.0.1:1234/audio')
  assert.ok(registry.get('http://127.0.0.1:1234/audio', 'track'))
  assert.equal(running.hasPlaybackProxy, true)
})

test('cancelled and wrong-owner results cannot register audio or pin proxy hosts', async () => {
  const { manager, registry, running, calls } = harness()
  const signal = new AbortController()
  const pending = manager.callProvider('fixture', 'getPlaybackUrl', [{ id: 'track' }], {
    signal: signal.signal
  })
  const rejected = assert.rejects(pending, /abort|cancel/i)
  await new Promise((done) => setImmediate(done))
  const response = {
    requestId: calls[0].requestId,
    ok: true,
    value: { streamUrl: 'http://127.0.0.1:1234/audio', autoMixIdentity: identity }
  }
  manager.handleProviderResult('different-owner', response)
  signal.abort()
  await rejected
  manager.handleProviderResult('owner', response)
  assert.equal(registry.get('http://127.0.0.1:1234/audio'), null)
  assert.equal(running.hasPlaybackProxy, false)
})

test('internal refresh preserves the protected identity envelope and refuses ownership changes', async () => {
  const { manager, calls } = harness()
  await assert.rejects(
    manager.callProvider('fixture', 'getPlaybackUrl', [], { expectedPluginId: 'different' }),
    /owner changed/
  )
  assert.equal(calls.length, 0)
  const pending = manager.callProvider('fixture', 'getPlaybackUrl', [{ id: 'track' }], {
    expectedPluginId: 'owner',
    returnAutoMixSourceIdentity: true
  })
  await new Promise((done) => setImmediate(done))
  manager.handleProviderResult('owner', {
    requestId: calls[0].requestId,
    ok: true,
    value: { streamUrl: 'https://cdn.example/audio', autoMixIdentity: identity }
  })
  const value = (await pending) as { streamUrl: string; autoMixIdentity: unknown }
  assert.deepEqual(value.autoMixIdentity, identity)
  assert.equal(
    remoteMediaGrants.resolve(value.streamUrl, 'audio').source,
    'https://cdn.example/audio'
  )
})
