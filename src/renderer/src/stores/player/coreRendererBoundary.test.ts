import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('normal renderer attaches and migrates before importing business UI; App has no playback owner', () => {
  const main = source('main.ts')
  assert.ok(main.indexOf('await initializeCoreWindow(') < main.indexOf("import('./App.vue')"))
  const app = source('App.vue')
  assert.doesNotMatch(app, /createPlaybackSessionPersistence|setupListeningStatsTracking|useMiniPlayerSync|useDynamicIslandSync|useDesktopLyricsSync|startStartupLibraryScan|startPluginPlaylistImports|afterglowSnapshot/)
  const player = source('stores/usePlayerStore.ts')
  assert.match(player, /useCorePlayerStore as usePlayerStore/)
  assert.doesNotMatch(player, /audioEngine|Audio\(|watch\(/)
})

test('audio UI commands go through finite Core contracts, not the native preload API', () => {
  for (const component of [
    'DspRackPage.vue', 'EqualizerPage.vue', 'AudioVisualizerPanel.vue',
    'LocalDashboard.vue', 'PlayerBar.vue', 'dsp-rack/DspAuditionPanel.vue',
    'settings-page/PlaybackSettingsSection.vue', 'settings-page/DspSettingsSection.vue',
    'settings-page/AudioDeviceProfilesPanel.vue', 'onboarding/steps/StepAudio.vue'
  ]) assert.doesNotMatch(source(`components/${component}`), /window\.api\.audioEngine/)
  assert.doesNotMatch(source('components/EqualizerPage.vue'), /localStorage|syncActiveSceneEq|watch\(autoPreampTargetDb/)
  assert.doesNotMatch(source('extensions/experienceBridge.ts'), /player\.queue\.value|window\.api\.audioEngine/)
})
