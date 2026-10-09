import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings,
  type AppearanceDraft
} from '../../../shared/appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from '../../../shared/liquidGlass.ts'
import { useAppearanceDraft } from './useAppearanceDraft.ts'
const initial = (): AppearanceDraft =>
  cloneAppearance({
    appBackground: normalizeAppBackgroundSettings({}),
    cardAppearance: defaultCardAppearance(),
    liquidGlass: DEFAULT_LIQUID_GLASS,
    surfaceMaterial: 'standard'
  })

test('draft editing and preview never persist; cancel clears overrides against latest confirmed settings', async () => {
  let confirmed = initial(),
    writes = 0
  const previews: Array<AppearanceDraft | null> = []
  const editor = useAppearanceDraft({
    confirmed: () => confirmed,
    persist: async () => {
      writes++
    },
    preview: async (value) => {
      previews.push(value)
    }
  })
  editor.begin()
  editor.state.draft.cardAppearance.dark.backgroundOpacity = 0
  editor.state.draft.surfaceMaterial = 'transparent'
  assert.equal(confirmed.surfaceMaterial, 'standard')
  await editor.preview(true)
  confirmed = { ...initial(), surfaceMaterial: 'liquidGlass' }
  await editor.cancel()
  assert.equal(writes, 0)
  assert.equal(previews.at(-1), null)
  editor.begin()
  assert.equal(editor.state.draft.surfaceMaterial, 'liquidGlass')
})
test('save commits one normalized patch; a failed save keeps the draft and can be retried', async () => {
  let confirmed = initial(),
    fail = true,
    writes = 0
  const editor = useAppearanceDraft({
    confirmed: () => confirmed,
    persist: async (value) => {
      writes++
      if (fail) throw new Error('磁盘不可写')
      confirmed = value
    },
    preview: async () => {}
  })
  editor.begin()
  editor.state.draft.surfaceMaterial = 'transparent'
  await editor.preview(true)
  assert.equal(await editor.save(), false)
  assert.equal(editor.state.error, '磁盘不可写')
  assert.equal(editor.state.fullWindow, false)
  assert.equal(editor.state.draft.surfaceMaterial, 'transparent')
  fail = false
  assert.equal(await editor.save(), true)
  assert.equal(confirmed.surfaceMaterial, 'transparent')
  assert.equal(writes, 2)
  assert.equal(editor.state.saving, false)
})
test('duplicate saves are gated and a disposed session cannot restore a stale preview', async () => {
  let release: () => void = () => {}
  let writes = 0
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const editor = useAppearanceDraft({
    confirmed: initial,
    persist: async () => {
      writes++
      await pending
    },
    preview: async () => {}
  })
  editor.begin()
  const firstSave = editor.save()
  assert.equal(await editor.save(), false)
  await editor.cancel()
  release()
  assert.equal(await firstSave, false)
  assert.equal(writes, 1)
})
