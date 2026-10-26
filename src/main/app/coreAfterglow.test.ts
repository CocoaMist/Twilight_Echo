import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreAfterglow, type CoreAfterglowEntry } from './coreAfterglow.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  const events: string[] = []
  let ready = true,
    shortcut: string | null = 'Ctrl+Alt+R'
  let persist: () => Promise<void> = async () => {}
  let restore: () => Promise<void> = async () => {}
  const mode = new CoreAfterglow({
    ready: () => ready,
    persistView: async () => {
      events.push('persist')
      await persist()
    },
    unload: (entry: CoreAfterglowEntry) => {
      events.push(`unload:${entry}`)
    },
    restoreWindow: async () => {
      events.push('restore-window')
      await restore()
    },
    registerRestore: () => {
      events.push('register')
      return shortcut
    },
    unregisterRestore: () => {
      events.push('unregister')
    },
    changed: () => {}
  })
  return {
    mode,
    events,
    notReady() {
      ready = false
    },
    noShortcut() {
      shortcut = null
    },
    failRestore() {
      restore = async () => {
        throw Error('renderer failed to load')
      }
    },
    holdPersist() {
      let release!: () => void
      const held = new Promise<void>((done) => {
        release = done
      })
      persist = () => held
      return release
    }
  }
}

test('Afterglow serializes enter and restore and owns only window presentation', async () => {
  const f = fixture()
  const release = f.holdPersist()
  const entering = f.mode.enter('manual')
  const restoring = f.mode.restore()
  await turn()
  assert.equal(f.mode.getStatus().phase, 'entering')
  assert.deepEqual(f.events, ['persist'])
  release()
  assert.equal((await entering).phase, 'active')
  assert.equal((await restoring).phase, 'inactive')
  assert.deepEqual(f.events, [
    'persist',
    'register',
    'unload:manual',
    'restore-window',
    'unregister'
  ])
})

test('restore failure preserves the active window-only mode and its restore shortcut', async () => {
  const f = fixture()
  await f.mode.enter('hide')
  f.failRestore()
  const result = await f.mode.restore()
  assert.equal(result.phase, 'active')
  assert.equal(result.restoreAccelerator, 'Ctrl+Alt+R')
  assert.match(result.error!, /renderer failed/)
  assert.deepEqual(f.events, ['persist', 'register', 'unload:hide', 'restore-window'])
  f.mode.reassertShortcuts()
  assert.deepEqual(f.events.slice(-2), ['unregister', 'register'])
})

test('manual unload requires a restore affordance and ready Core, not an active or local-only track', async () => {
  const f = fixture()
  f.notReady()
  assert.equal((await f.mode.enter('manual')).phase, 'inactive')
  assert.deepEqual(f.events, [])
  const shortcut = fixture()
  shortcut.noShortcut()
  const status = await shortcut.mode.enter('manual')
  assert.equal(status.phase, 'inactive')
  assert.equal(status.error, 'afterglow_restore_shortcut_unavailable')
  assert.equal(
    shortcut.events.some((event) => event.startsWith('unload')),
    false
  )
})

test('shutdown during persistence cancels pending UI unload and later restore', async () => {
  const f = fixture()
  const release = f.holdPersist()
  const entering = f.mode.enter('manual')
  await turn()
  f.mode.shutdown()
  release()
  assert.equal((await entering).phase, 'inactive')
  assert.equal((await f.mode.restore()).phase, 'inactive')
  assert.deepEqual(f.events, ['persist', 'unregister'])
})
