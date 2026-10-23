import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./useRadioStore.ts', import.meta.url), 'utf8')

test('radio renderer store is a Core projection and never owns stream persistence', () => {
  assert.match(source, /core\.query\('radio\.stations'/)
  assert.match(source, /core\.command\('radio\.edit'/)
  assert.match(source, /core\.command\('streams\.play'/)
  assert.doesNotMatch(source, /window\.api\.radio/)
  assert.doesNotMatch(source, /resolvePlayback|window\.api\.radio/)
})
