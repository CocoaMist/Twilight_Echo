import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreSettingsBridge, type CoreSettingsAdapterOperations } from './settingsBridge.ts'
import { createDefaultSettings } from '../../core/settings/normalization.ts'
import type { CoreSettingsState } from '../../shared/coreSettings.ts'
import type { SettingsSnapshot } from '../../shared/appSettings.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  let state: CoreSettingsState = { revision: 0, settings: createDefaultSettings('win32') }
  let projected = state
  let release: (() => void) | undefined
  let held = false
  let writes = 0
  const bridge = new CoreSettingsBridge({
    request: (async (name: keyof CoreSettingsAdapterOperations, payload: any) => {
      if (name === 'settings.state') return structuredClone(state)
      if (name === 'settings.edit' || name === 'settings.restore') {
        assert.equal(payload.revision, state.revision)
        if (held)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        if (payload.patch?.language === 'invalid') throw Error('Rejected setting')
        writes++
        state = {
          revision: state.revision + 1,
          settings: { ...state.settings, ...(payload.patch ?? JSON.parse(payload.json)) }
        }
        return structuredClone(state)
      }
      return 'exported'
    }) as never,
    project: (next) => {
      projected = next
    },
    snapshot: () => ({ settings: structuredClone(projected.settings) }) as SettingsSnapshot
  })
  return {
    bridge,
    get state() {
      return state
    },
    get writes() {
      return writes
    },
    hold() {
      held = true
    },
    release() {
      held = false
      release!()
    }
  }
}

test('main settings edits compute nested patches against the latest committed Core state', async () => {
  const f = fixture()
  const first = f.bridge.update((settings) => ({
    miniPlayer: { ...settings.miniPlayer, windowX: 100 }
  }))
  const second = f.bridge.update((settings) => ({
    miniPlayer: { ...settings.miniPlayer, windowY: 200 }
  }))
  await Promise.all([first, second])
  const current = await f.bridge.get()
  assert.equal(current.settings.miniPlayer.windowX, 100)
  assert.equal(current.settings.miniPlayer.windowY, 200)
  assert.equal(f.state.revision, 2)
})

test('shutdown flush joins accepted satellite writes, then restore uses the next Core revision', async () => {
  const f = fixture()
  f.hold()
  const update = f.bridge.update({ language: 'en-US' })
  await turn()
  let flushed = false
  const flushing = f.bridge.flush().then(() => {
    flushed = true
  })
  await turn()
  assert.equal(flushed, false)
  f.release()
  await Promise.all([update, flushing])
  await f.bridge.restore(JSON.stringify({ language: 'zh-CN' }))
  assert.equal(f.state.settings.language, 'zh-CN')
  assert.equal(f.state.revision, 2)
})

test('a rejected setting is not replayed and does not poison later platform settings writes', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.update({ language: 'invalid' as never }), /Rejected setting/)
  await f.bridge.update({ language: 'en-US' })
  await f.bridge.flush()
  assert.equal(f.writes, 1)
  assert.equal(f.state.settings.language, 'en-US')
})
