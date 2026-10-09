import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { computed, ref } from 'vue'
import ts from 'typescript'
import { toProviderIpcArgs } from '../providers/mediaProvider.ts'

const source = readFileSync(new URL('./useProviderStore.ts', import.meta.url), 'utf8')

function providerStoreFixture(list: () => Promise<unknown[]>) {
  const listeners: Array<() => void> = []
  const exports: {
    useProviderStore?: () => {
      syncProviders: () => Promise<void>
      hasProvider: (id: string) => boolean
    }
  } = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        if (id === 'vue') return { computed, ref }
        if (id === '@renderer/providers/mediaProvider') return { toProviderIpcArgs }
        throw new Error(`Unexpected dependency: ${id}`)
      },
      window: {
        setInterval: () => 1,
        clearInterval: () => {},
        api: {
          providers: { list },
          plugins: { onChanged: (listener: () => void) => listeners.push(listener) }
        }
      }
    }
  )
  return { store: exports.useProviderStore!(), changed: () => listeners.forEach((fn) => fn()) }
}

test('provider navigation waits for fresh lifecycle state when a list is already pending', async () => {
  let resolve!: (value: unknown[]) => void
  const stale = new Promise<unknown[]>((done) => {
    resolve = done
  })
  const provider = { id: 'ncm', name: 'NCM', capabilities: ['login'] }
  let calls = 0
  const f = providerStoreFixture(async () => (++calls === 1 ? stale : [provider]))
  const first = f.store.syncProviders()
  const second = f.store.syncProviders()
  assert.equal(calls, 1, 'concurrent readers share the request')
  f.changed()
  resolve([])
  await Promise.all([first, second])
  assert.equal(calls, 2)
  assert.equal(f.store.hasProvider('ncm'), true)
})

test('a stale provider list cannot undo disabling a plugin', async () => {
  let resolve!: (value: unknown[]) => void
  const stale = new Promise<unknown[]>((done) => {
    resolve = done
  })
  const provider = { id: 'ncm', name: 'NCM', capabilities: ['login'] }
  let calls = 0
  const f = providerStoreFixture(async () => (++calls === 1 ? stale : []))
  const pending = f.store.syncProviders()
  f.changed()
  resolve([provider])
  await pending
  assert.equal(f.store.hasProvider('ncm'), false)
})

test('homepage section arguments cross IPC after provider metadata becomes reactive', async () => {
  const metadata = ref({
    ui: {
      streamingSections: [
        { method: 'fetchRecommendSongs', args: ['daily'] },
        { method: 'fetchRecommendSongs', args: ['rising'] }
      ]
    }
  })
  const received: unknown[][] = []
  const functionSource = source.slice(
    source.indexOf('async function callProvider<T>('),
    source.indexOf('export function useProviderStore(')
  )
  const callProvider = runInNewContext(`${stripTypeScriptTypes(functionSource)}\ncallProvider`, {
    toProviderIpcArgs,
    window: {
      api: {
        providers: {
          call: async (_provider: string, _method: string, args: unknown[]) => {
            received.push(structuredClone(args))
            return []
          }
        }
      }
    }
  }) as (id: string, method: string, args: unknown[]) => Promise<unknown>
  for (const section of metadata.value.ui.streamingSections) {
    await callProvider('kugou', section.method, section.args)
  }
  assert.deepEqual(received, [['daily'], ['rising']])
})

test('provider store exposes provider health metadata from the host', () => {
  assert.match(source, /export interface ProviderHealth/)
  assert.match(source, /health\?: ProviderHealth/)
  assert.match(source, /health: provider\.health as ProviderHealth \| undefined/)
  assert.match(source, /supportedMethods: provider\.supportedMethods \?\? \[\]/)
})

test('streaming library surfaces provider health diagnostics to users', () => {
  const streamingSource = readFileSync(
    new URL('../components/StreamingLibrary.vue', import.meta.url),
    'utf8'
  )

  assert.match(streamingSource, /buildProviderHealthPresentation/)
  assert.match(streamingSource, /type ProviderHealthInput/)
  assert.match(streamingSource, /health\?: ProviderHealthInput/)
  assert.match(streamingSource, /loggedIn\?: boolean/)
  assert.match(streamingSource, /providerMenuHealthLabel/)
  assert.match(streamingSource, /providerMenuHealthDetail/)
  assert.match(streamingSource, /provider-menu-health/)
  assert.match(streamingSource, /:title="providerMenuHealthDetail\(provider\)"/)
})
