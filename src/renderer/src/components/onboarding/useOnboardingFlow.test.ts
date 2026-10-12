import assert from 'node:assert/strict'
import test from 'node:test'

const {
  buildSettingsPatch,
  createDefaultOnboardingChoices,
  resolveFinishAction,
  resolveVisibleSteps,
  useOnboardingFlow
} = (await import(
  new URL('./useOnboardingFlow.ts', import.meta.url).href
)) as typeof import('./useOnboardingFlow')

test('early completion only writes visited sections', () => {
  const choices = createDefaultOnboardingChoices()
  choices.usage = 'both'
  choices.audioExclusiveMode = true
  const patch = buildSettingsPatch(choices, new Set(['welcome', 'usage', 'local']))
  assert.equal(patch.startupHomePage, 'local')
  assert.equal(patch.watchLibrary, true)
  for (const field of [
    'audioExclusiveMode',
    'playerBar',
    'miniPlayer',
    'ncmPlaybackQuality',
    'cachePolicy',
    'closeWindowBehavior',
    'globalShortcuts'
  ])
    assert.equal(field in patch, false, field)
})

test('reopening seeds all persisted choices and clones editable objects', () => {
  const seed = {
    onboardingCompleted: true,
    ...createDefaultOnboardingChoices(),
    audioExclusiveMode: true,
    watchLibrary: false,
    autoAnalyzeBpm: false,
    globalShortcuts: true,
    smtcEnabled: false,
    discordRpcEnabled: true,
    ncmPlaybackQuality: 'hires' as const,
    playbackResumeMode: 'trackAndPosition' as const
  }
  const choices = createDefaultOnboardingChoices(seed)
  for (const field of [
    'audioExclusiveMode',
    'watchLibrary',
    'autoAnalyzeBpm',
    'globalShortcuts',
    'smtcEnabled',
    'discordRpcEnabled',
    'ncmPlaybackQuality',
    'playbackResumeMode'
  ] as const)
    assert.equal(choices[field], seed[field])
  choices.playerBar.mode = 'compact'
  choices.miniPlayer.alwaysOnTop = !seed.miniPlayer.alwaysOnTop
  choices.cachePolicy.streamingAudio = 'off'
  assert.notEqual(choices.playerBar.mode, seed.playerBar.mode)
  assert.notEqual(choices.miniPlayer.alwaysOnTop, seed.miniPlayer.alwaysOnTop)
  assert.equal(seed.cachePolicy.streamingAudio, 'provider')
})

test('first-run defaults use standard on home and compact on the playing page without replacing saved choices', () => {
  const defaults = createDefaultOnboardingChoices()
  assert.equal(defaults.playerBar.mode, 'standard')
  assert.equal(defaults.playerBar.modeSource, 'user')
  assert.equal(defaults.playerBar.playingPageMode, 'compact')
  const saved = {
    ...defaults.playerBar,
    mode: 'mini' as const,
    playingPageMode: 'standard' as const
  }
  const reopened = createDefaultOnboardingChoices({ onboardingCompleted: true, playerBar: saved })
  assert.equal(reopened.playerBar.mode, 'mini')
  assert.equal(reopened.playerBar.playingPageMode, 'standard')
  defaults.usage = 'local'
  assert.equal(buildSettingsPatch(defaults).playerBar?.playingPageMode, 'compact')
})

test('summary edits can return to finish, but cannot jump to unvisited steps', () => {
  const flow = useOnboardingFlow()
  flow.next()
  flow.choices.value.usage = 'both'
  flow.goTo(7)
  assert.equal(flow.currentStep.value, 'usage')
  while (!flow.isLastStep.value) flow.next()
  flow.goTo(flow.visibleSteps.value.indexOf('player'))
  assert.equal(flow.currentStep.value, 'player')
  flow.goTo(flow.visibleSteps.value.indexOf('finish'))
  assert.equal(flow.currentStep.value, 'finish')
  flow.goTo(1)
  flow.choices.value.usage = 'local'
  flow.choices.value.wantsStreamingLogin = true
  flow.choices.value.wantsPluginMarket = true
  assert.equal(resolveFinishAction(flow.choices.value), 'local')
  const patch = buildSettingsPatch(flow.choices.value, flow.visitedSteps.value)
  assert.equal('ncmPlaybackQuality' in patch, false)
  assert.equal('cachePolicy' in patch, false)
})

test('visible steps adapt to the usage choice', () => {
  assert.deepEqual(resolveVisibleSteps(null), [
    'welcome',
    'usage',
    'player',
    'audio',
    'system',
    'finish'
  ])
  assert.deepEqual(resolveVisibleSteps('local'), [
    'welcome',
    'usage',
    'local',
    'player',
    'audio',
    'system',
    'finish'
  ])
  assert.deepEqual(resolveVisibleSteps('streaming'), [
    'welcome',
    'usage',
    'streaming',
    'player',
    'audio',
    'system',
    'finish'
  ])
  assert.deepEqual(resolveVisibleSteps('both'), [
    'welcome',
    'usage',
    'local',
    'streaming',
    'player',
    'audio',
    'system',
    'finish'
  ])
})

test('the usage step gates advancing until a choice is made', () => {
  const flow = useOnboardingFlow()
  assert.equal(flow.currentStep.value, 'welcome')
  assert.equal(flow.canAdvance.value, true)

  flow.next()
  assert.equal(flow.currentStep.value, 'usage')
  assert.equal(flow.canAdvance.value, false)
  flow.next()
  assert.equal(flow.currentStep.value, 'usage')

  flow.choices.value.usage = 'both'
  assert.equal(flow.canAdvance.value, true)
  flow.next()
  assert.equal(flow.currentStep.value, 'local')
  assert.equal(flow.direction.value, 'forward')
})

test('back and goTo only move backwards and set direction', () => {
  const flow = useOnboardingFlow()
  flow.choices.value.usage = 'local'
  flow.next()
  flow.next()
  assert.equal(flow.currentStep.value, 'local')

  flow.back()
  assert.equal(flow.currentStep.value, 'usage')
  assert.equal(flow.direction.value, 'back')

  flow.next()
  flow.goTo(5)
  assert.equal(flow.currentStep.value, 'local')
  flow.goTo(0)
  assert.equal(flow.currentStep.value, 'welcome')
})

test('skip without a usage choice persists only the completion flag', () => {
  const choices = createDefaultOnboardingChoices()
  assert.deepEqual(buildSettingsPatch(choices), { onboardingCompleted: true })
  assert.equal(resolveFinishAction(choices), 'local')
})

test('a streaming user lands on the streaming page without local-library churn', () => {
  const choices = createDefaultOnboardingChoices()
  choices.usage = 'streaming'
  choices.audioExclusiveMode = true
  choices.wantsStreamingLogin = true

  choices.ncmPlaybackQuality = 'lossless'
  choices.cachePolicy.streamingAudio = 'off'
  const patch = buildSettingsPatch(choices)
  assert.equal(patch.onboardingCompleted, true)
  assert.equal(patch.startupHomePage, 'streaming')
  assert.equal(patch.audioExclusiveMode, true)
  assert.equal(patch.ncmPlaybackQuality, 'lossless')
  assert.equal(patch.cachePolicy?.streamingAudio, 'off')
  assert.equal('watchLibrary' in patch, false)
  assert.equal('autoAnalyzeBpm' in patch, false)
  assert.equal(resolveFinishAction(choices), 'streaming-login')

  choices.wantsStreamingLogin = false
  assert.equal(resolveFinishAction(choices), 'streaming')
})

test('local and both users keep library preferences; dual-use home stays local', () => {
  const choices = createDefaultOnboardingChoices()
  choices.usage = 'both'
  choices.watchLibrary = false
  choices.autoAnalyzeBpm = false
  choices.onlineLyricsFallback = true
  choices.closeWindowBehavior = 'tray'
  choices.launchAtLogin = true
  choices.playerBar.mode = 'mini'
  choices.playerBar.visibility = 'autoHide'
  choices.miniPlayer.showInTaskbar = false
  choices.miniPlayer.alwaysOnTop = true
  choices.taskbarThumbarButtonsEnabled = false

  choices.playbackResumeMode = 'trackAndPosition'
  choices.globalShortcuts = true
  choices.smtcEnabled = false
  choices.discordRpcEnabled = true
  const patch = buildSettingsPatch(choices)
  assert.equal(patch.startupHomePage, 'local')
  assert.equal(patch.watchLibrary, false)
  assert.equal(patch.autoAnalyzeBpm, false)
  assert.equal(patch.onlineLyricsFallback, true)
  assert.equal(patch.closeWindowBehavior, 'tray')
  assert.equal(patch.closeToTray, true)
  assert.equal(patch.launchAtLogin, true)
  assert.equal(patch.playerBar?.mode, 'mini')
  assert.equal(patch.playerBar?.visibility, 'autoHide')
  assert.equal(patch.miniPlayer?.showInTaskbar, false)
  assert.equal(patch.miniPlayer?.alwaysOnTop, true)
  assert.equal(patch.taskbarThumbarButtonsEnabled, false)
  assert.equal(patch.playbackResumeMode, 'trackAndPosition')
  assert.equal(patch.globalShortcuts, true)
  assert.equal(patch.smtcEnabled, false)
  assert.equal(patch.discordRpcEnabled, true)
  assert.equal(resolveFinishAction(choices), 'local')

  choices.wantsStreamingLogin = true
  assert.equal(resolveFinishAction(choices), 'streaming-login')
})

test('system integration flags never persist when the wizard is skipped', () => {
  const choices = createDefaultOnboardingChoices()
  const patch = buildSettingsPatch(choices)
  assert.equal('globalShortcuts' in patch, false)
  assert.equal('smtcEnabled' in patch, false)
  assert.equal('discordRpcEnabled' in patch, false)
  assert.equal('playerBar' in patch, false)
  assert.equal('miniPlayer' in patch, false)
  assert.equal('taskbarThumbarButtonsEnabled' in patch, false)
})

test('a local-only user never writes streaming quality', () => {
  const choices = createDefaultOnboardingChoices()
  choices.usage = 'local'
  choices.ncmPlaybackQuality = 'hires'
  choices.cachePolicy.streamingAudio = 'off'
  const patch = buildSettingsPatch(choices)
  assert.equal('ncmPlaybackQuality' in patch, false)
  assert.equal('cachePolicy' in patch, false)
})
