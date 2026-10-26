import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artistProfileChoices,
  artistProfileChoice,
  saveArtistProfileChoice
} from './artistProfileChoice.ts'

test('profile choice saves exact names and source/target only, with reversible and failure-safe writes', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let value = '',
    full = false
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => value,
      setItem: (_k: string, v: string) => {
        if (full) throw Error('quota')
        value = v
      }
    }
  })
  try {
    artistProfileChoices.value = {}
    saveArtistProfileChoice('AC/DC', { entityId: 'a', targetId: 'one' })
    assert.deepEqual(JSON.parse(value), [['AC/DC', { entityId: 'a', targetId: 'one' }]])
    assert.equal(artistProfileChoice('AC'), null)
    full = true
    assert.throws(
      () => saveArtistProfileChoice('AC/DC', { entityId: 'b', targetId: 'two' }),
      /quota/
    )
    assert.equal(artistProfileChoice('AC/DC')?.entityId, 'a')
    full = false
    saveArtistProfileChoice('AC/DC', null)
    assert.equal(artistProfileChoice('AC/DC'), null)
    assert.equal(value, '[]')
  } finally {
    artistProfileChoices.value = {}
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
