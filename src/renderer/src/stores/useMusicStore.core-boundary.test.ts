import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('the renderer music store stays Core-backed and does not regain browser playlist persistence', async () => {
  const source = await readFile(fileURLToPath(new URL('./useMusicStore.ts', import.meta.url)), 'utf8')
  assert.match(source, /createCoreMusicStore\(useCoreConnection\(\)\)/)
  assert.doesNotMatch(source, /window\.api\.data\.(?:load|save)Playlists/)
})
