import assert from 'node:assert/strict'
import test from 'node:test'
import { useAppNavigation } from './useAppNavigation.ts'
import { guardAppearanceNavigation, type AppearanceWorkspace } from './appearanceNavigationGuard.ts'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('ordinary routes remain synchronous and preserve forward history', () => {
  const raw = useAppNavigation()
  const navigation = guardAppearanceNavigation(raw, () => null)
  navigation.navigate({ kind: 'local', category: 'albums', filter: null })
  assert.equal(navigation.activeCategory.value, 'albums')
  navigation.goBackPage()
  assert.equal(navigation.activeCategory.value, 'dashboard')
  assert.equal(navigation.goForwardPage(), true)
  assert.equal(navigation.activeCategory.value, 'albums')
})

test('page commands, playlists and the title menu respect rejected appearance leave requests', async () => {
  for (const destination of ['page', 'playlist', 'menu', 'streaming', 'radio'] as const) {
    const raw = useAppNavigation()
    raw.openSettingsPage('library')
    raw.openAppearancePage()
    let requests = 0
    const navigation = guardAppearanceNavigation(raw, () => ({
      requestLeave: async () => {
        requests++
        return false
      }
    }))
    const saved = JSON.stringify(navigation.session.value)
    if (destination === 'page')
      navigation.navigate({ kind: 'local', category: 'albums', filter: null })
    if (destination === 'playlist') navigation.openLibraryPlaylist({ id: 'one', name: 'One' })
    if (destination === 'menu') navigation.createToggleMenuHandler()()
    if (destination === 'streaming') navigation.enterStreamingMode('library')
    if (destination === 'radio') navigation.enterRadioPodcastMode()
    await flush()
    assert.equal(requests, 1, destination)
    assert.equal(JSON.stringify(navigation.session.value), saved, destination)
  }
})

test('approved command navigation releases the retained workspace only after its leave completes', async () => {
  const raw = useAppNavigation()
  raw.openAppearancePage()
  let release!: (allowed: boolean) => void
  let requests = 0
  const workspace = {
    requestLeave: () => {
      requests++
      return new Promise<boolean>((resolve) => {
        release = resolve
      })
    }
  }
  const navigation = guardAppearanceNavigation(raw, () => workspace)
  navigation.openLibraryPlaylist({ id: 'one', name: 'One' })
  navigation.navigate({ kind: 'network' })
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(requests, 1)
  release(true)
  await flush()
  assert.equal(navigation.showAppearancePage.value, false)
  assert.deepEqual(navigation.session.value.overlayHistory, [])
  assert.equal(navigation.activeCategory.value, 'playlists')
})

test('retained appearance drafts remain protected beneath other tools', async () => {
  const raw = useAppNavigation()
  raw.openAppearancePage()
  raw.openEqualizerPage()
  let requests = 0
  const navigation = guardAppearanceNavigation(raw, () => ({
    requestLeave: async () => {
      requests++
      return false
    }
  }))
  navigation.navigate({ kind: 'network' })
  await flush()
  assert.equal(requests, 1)
  assert.equal(navigation.showEqualizerPage.value, true)
  assert.ok(navigation.session.value.overlayHistory.includes('appearance'))
})

test('stale approvals cannot navigate after the workspace or foreground has changed', async () => {
  for (const change of ['workspace', 'overlay'] as const) {
    const raw = useAppNavigation()
    raw.openAppearancePage()
    let release!: (allowed: boolean) => void
    let workspace: AppearanceWorkspace = {
      requestLeave: () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    }
    const navigation = guardAppearanceNavigation(raw, () => workspace)
    navigation.navigate({ kind: 'network' })
    if (change === 'workspace') workspace = { requestLeave: async () => true }
    else raw.openEqualizerPage()
    release(true)
    await flush()
    assert.equal(navigation.pageTarget.value.kind, 'local', change)
  }
})

test('original appearance settings coexist with the new workspace without changing DSP entry points', () => {
  const navigation = useAppNavigation()
  navigation.openSettingsPage('library')
  navigation.openSettingsPage('appearance')
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.showAppearancePage.value, false)
  assert.equal(navigation.settingsInitialSection.value, 'appearance')
  navigation.openAppearancePage()
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.session.value.settingsSection, 'appearance')
  navigation.closeAppearancePage()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.settingsInitialSection.value, 'appearance')
  navigation.openDspSettings()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.showDspRackPage.value, false)
  navigation.restoreSession({
    ...navigation.session.value,
    overlay: 'theme',
    overlayHistory: [null, 'settings']
  })
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.appearanceTab.value, 'studio')
  navigation.closeAppearancePage()
  assert.equal(navigation.showSettingsPage.value, true)
})
