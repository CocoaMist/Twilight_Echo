import assert from 'node:assert/strict'
import test from 'node:test'
import { useAppNavigation } from './useAppNavigation.ts'
import { guardDspNavigation } from './dspNavigationGuard.ts'
import { guardAppearanceNavigation } from './appearanceNavigationGuard.ts'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
test('DSP cancellation preserves all overlay and page history; approval uses original return routes', async () => {
  const raw = useAppNavigation()
  raw.openSettingsPage('dsp')
  raw.openDspRackPage()
  let allow = false,
    asks = 0
  const navigation = guardDspNavigation(raw, () => workspace)
  const workspace = {
    requestLeave: async () => {
      asks++
      return allow
    }
  }
  const previous = JSON.stringify(raw.session.value)
  navigation.closeDspRackPage()
  await settle()
  assert.equal(JSON.stringify(raw.session.value), previous)
  navigation.openEqualizerPage()
  await settle()
  assert.equal(raw.showEqualizerPage.value, false)
  allow = true
  navigation.closeDspRackPage()
  await settle()
  assert.equal(raw.showSettingsPage.value, true)
  assert.equal(asks, 3)
})

test('DSP guard retains appearance navigation protection rather than bypassing it', async () => {
  const raw = useAppNavigation()
  raw.openAppearancePage()
  let appearanceAllowed = false
  const appearance = { requestLeave: async () => appearanceAllowed }
  const navigation = guardDspNavigation(
    guardAppearanceNavigation(raw, () => appearance),
    () => null
  )
  navigation.navigate({ kind: 'local', category: 'albums', filter: null })
  await settle()
  assert.equal(raw.showAppearancePage.value, true)
  appearanceAllowed = true
  navigation.navigate({ kind: 'local', category: 'albums', filter: null })
  await settle()
  assert.equal(raw.showAppearancePage.value, false)
})

test('DSP navigation coalesces repeated requests while a leave decision is pending', async () => {
  const raw = useAppNavigation()
  raw.openDspRackPage()
  let answer!: (value: boolean) => void
  let asks = 0
  const workspace = {
    requestLeave: () => {
      asks++
      return new Promise<boolean>((resolve) => {
        answer = resolve
      })
    }
  }
  const navigation = guardDspNavigation(raw, () => workspace)
  navigation.closeDspRackPage()
  navigation.openEqualizerPage()
  assert.equal(asks, 1)
  answer(true)
  await settle()
  assert.equal(raw.showDspRackPage.value, false)
  assert.equal(raw.showEqualizerPage.value, false)
})
