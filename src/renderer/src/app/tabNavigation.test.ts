import assert from 'node:assert/strict'
import test from 'node:test'
import { getTabDestination } from './tabNavigation.ts'
import { normalizeMiniPlayerCommand } from '../../../shared/miniPlayer.ts'

test('tab navigation wraps and supports Home/End without intercepting unrelated keys', () => {
  assert.equal(getTabDestination('ArrowLeft', 0, 3), 2)
  assert.equal(getTabDestination('ArrowRight', 2, 3), 0)
  assert.equal(getTabDestination('Home', 2, 3), 0)
  assert.equal(getTabDestination('End', 0, 3), 2)
  assert.equal(getTabDestination('ArrowUp', 1, 3), null)
  assert.equal(getTabDestination('Tab', 1, 3), null)
  assert.equal(getTabDestination('ArrowRight', 0, 0), null)
  assert.equal(getTabDestination('ArrowRight', 0, 1), 0)
})

test('vertical tabs accept vertical directions only', () => {
  assert.equal(getTabDestination('ArrowUp', 0, 3, true), 2)
  assert.equal(getTabDestination('ArrowDown', 2, 3, true), 0)
  assert.equal(getTabDestination('ArrowRight', 0, 3, true), null)
})

test('mini player accepts the queue command and rejects unknown commands', () => {
  assert.deepEqual(normalizeMiniPlayerCommand({ type: 'open-queue' }), { type: 'open-queue' })
  assert.equal(normalizeMiniPlayerCommand({ type: 'open-anything' }), null)
})
