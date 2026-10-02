import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { installWindowChromePublisher, readWindowChromeState } from './windowChrome.ts'

function fixture() {
  const events = new EventEmitter()
  let maximized = false
  let destroyed = false
  const sent: unknown[][] = []
  const win = Object.assign(events, {
    isMaximized: () => maximized,
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, send: (...args: unknown[]) => sent.push(args) }
  }) as unknown as BrowserWindow
  return {
    win,
    sent,
    maximize: (value: boolean) => {
      maximized = value
    },
    destroy: () => {
      destroyed = true
    }
  }
}

test('native maximize and restore events publish real window state and close releases listeners', () => {
  const { win, sent, maximize } = fixture()
  assert.deepEqual(readWindowChromeState(win), { maximized: false })
  installWindowChromePublisher(win)
  maximize(true)
  win.emit('maximize')
  maximize(false)
  win.emit('unmaximize')
  assert.deepEqual(sent, [
    ['window:state-changed', { maximized: true }],
    ['window:state-changed', { maximized: false }]
  ])
  win.emit('closed')
  assert.equal(win.listenerCount('maximize'), 0)
  assert.equal(win.listenerCount('unmaximize'), 0)
})

test('a destroyed window never receives a state publication and disposal is repeatable', () => {
  const { win, sent, destroy } = fixture()
  const dispose = installWindowChromePublisher(win)
  destroy()
  win.emit('maximize')
  assert.equal(sent.length, 0)
  dispose()
  dispose()
  assert.equal(win.listenerCount('closed'), 0)
})
