import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PluginSettingsRepository, pluginSettingsPath } from './settingsRepository.ts'
import type { SecureValueEnvelope } from '../../shared/secureValue.ts'

const envelope = (value: unknown): SecureValueEnvelope => ({
  __twilightSecure: true,
  version: 1,
  backend: 'electron-safe-storage',
  ciphertext: JSON.stringify(value)
})

test('one Core writer serializes concurrent host settings and retains special dictionary keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'core-plugin-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scopes: string[] = []
  const repository = new PluginSettingsRepository({
    protect: async (value, scope) => {
      scopes.push(scope)
      await new Promise<void>((r) => setImmediate(r))
      return envelope(value)
    },
    unprotect: (value) => JSON.parse(value.ciphertext)
  })
  await Promise.all([
    repository.set(root, 'cookie', 'existing-credential'),
    repository.set(root, 'volume', 0.25),
    repository.set(root, '__proto__', { keep: true }),
    repository.set(root, 'constructor', 7)
  ])
  assert.deepEqual(
    await repository.get(root),
    JSON.parse(
      '{"cookie":"existing-credential","volume":0.25,"__proto__":{"keep":true},"constructor":7}'
    )
  )
  assert.deepEqual(scopes, [`plugin-settings:${root}:cookie`])
  await repository.flush()
})

test('a locked OS credential survives an unrelated setting write byte-for-byte', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'core-plugin-locked-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const locked = envelope('old-safe-storage-secret')
  await writeFile(pluginSettingsPath(root), JSON.stringify({ cookie: locked, theme: 'dark' }))
  const repository = new PluginSettingsRepository({ protect: envelope, unprotect: () => undefined })
  assert.equal(await repository.get(root, 'cookie'), undefined)
  await repository.set(root, 'theme', 'light')
  assert.deepEqual(JSON.parse(await readFile(pluginSettingsPath(root), 'utf8')), {
    cookie: locked,
    theme: 'light'
  })
})

test('failed encryption does not publish or drop a concurrent successful setting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'core-plugin-keyring-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new PluginSettingsRepository({
    protect: () => {
      throw Error('keyring unavailable')
    },
    unprotect: () => undefined
  })
  const failure = repository.set(root, 'cookie', 'secret')
  const success = repository.set(root, 'setting', true)
  await assert.rejects(failure, /keyring unavailable/)
  await success
  assert.deepEqual(await repository.get(root), { setting: true })
})
