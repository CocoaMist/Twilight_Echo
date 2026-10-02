import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeNavigationPagePreferences } from './navigationPages.ts'

test('legacy settings use the default directory without persisting menu openness', () => {
  assert.deepEqual(normalizeNavigationPagePreferences(undefined), {
    version: 1,
    order: [],
    hidden: []
  })
})

test('preferences retain unavailable plugin IDs and normalize invalid settings at the boundary', () => {
  const value = normalizeNavigationPagePreferences({
    order: ['search', 'search', '', 7, 'plugin:old:page'],
    hidden: ['search', 'search', null]
  })
  assert.deepEqual(value, { version: 1, order: ['search', 'plugin:old:page'], hidden: ['search'] })
  assert.deepEqual(normalizeNavigationPagePreferences(JSON.parse(JSON.stringify(value))), value)
})
