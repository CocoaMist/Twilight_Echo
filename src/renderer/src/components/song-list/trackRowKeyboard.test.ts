import assert from 'node:assert/strict'
import test from 'node:test'
import { trackRowKeyAction } from './trackRowKeyboard.ts'

function key(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const row = {} as EventTarget
  const event = {
    key,
    target: row,
    currentTarget: row,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...overrides
  }
  return event as KeyboardEvent
}

test('Enter plays while Space selects without triggering global playback or page scrolling', () => {
  for (const [value, action] of [
    ['Enter', 'play'],
    [' ', 'select']
  ] as const) {
    const event = key(value)
    assert.equal(trackRowKeyAction(event), action)
    assert.equal(event.defaultPrevented, true)
    const repeat = key(value, { repeat: true })
    assert.equal(trackRowKeyAction(repeat), null)
    assert.equal(repeat.defaultPrevented, true)
  }
  assert.equal(trackRowKeyAction(key(' '), false), null)
  assert.equal(trackRowKeyAction(key(' ', { ctrlKey: true })), 'select')
})

test('row keys leave nested controls, composition and modified commands alone', () => {
  for (const value of ['Enter', ' ']) {
    for (const overrides of [
      { target: {} as EventTarget },
      { defaultPrevented: true },
      { isComposing: true },
      { altKey: true },
      { metaKey: true },
      { shiftKey: true }
    ]) {
      assert.equal(trackRowKeyAction(key(value, overrides)), null)
    }
  }
  assert.equal(trackRowKeyAction(key('Enter', { ctrlKey: true })), null)
  const arrow = key('ArrowDown')
  assert.equal(trackRowKeyAction(arrow), null)
  assert.equal(arrow.defaultPrevented, false)
})
