import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCommandPaletteActions,
  filterCommandPaletteActions
} from './commandPaletteActions.ts'
import { useAppNavigation } from './useAppNavigation.ts'

test('building and filtering commands is inert and unavailable actions explain why', () => {
  const navigation = useAppNavigation()
  let calls = 0
  const actions = createCommandPaletteActions({
    navigation,
    currentTrack: null,
    playing: false,
    loading: false,
    lyricsVisible: true,
    queue: {
      length: 0,
      canUndo: false,
      undoLabel: '',
      undo: () => false,
      clear: () => {
        calls++
      },
      showSessions: () => {
        calls++
      },
      showHistory: () => {
        calls++
      }
    },
    togglePlay: async () => {
      calls += 1
    },
    showLyrics: async () => {
      calls += 1
    }
  })
  assert.equal(calls, 0)
  assert.ok(actions.find((action) => action.id === 'save-queue-session')!.disabledReason)
  assert.ok(actions.find((action) => action.id === 'undo-queue')!.disabledReason)
  actions.find((action) => action.id === 'queue-sessions')!.run()
  actions.find((action) => action.id === 'playback-order')!.run()
  assert.equal(calls, 2)
  assert.equal(navigation.showSettingsPage.value, false)
  assert.match(actions.find((action) => action.id === 'now-playing')!.disabledReason!, /没有歌曲/)
  assert.match(actions.find((action) => action.id === 'lyrics')!.disabledReason!, /已显示/)
  assert.ok(filterCommandPaletteActions(actions, '').every((action) => action.group === '操作'))
  assert.ok(filterCommandPaletteActions(actions, '>eq').some((action) => action.id === 'equalizer'))
  for (const query of ['DSP 工作台', 'workbench', 'DSP Rack', '机架'])
    assert.ok(filterCommandPaletteActions(actions, query).some((action) => action.id === 'dsp'))
  const workbench = actions.find((action) => action.id === 'dsp')!
  assert.equal(workbench.title, '打开 DSP 工作台')
  assert.equal(workbench.disabledReason, undefined)
  workbench.run()
  assert.equal(navigation.showDspRackPage.value, true)
  navigation.closeDspRackPage()
  assert.ok(filterCommandPaletteActions(actions, '扫描').some((action) => action.group === '设置'))
  actions.find((action) => action.id === 'device-profiles')!.run()
  assert.equal(navigation.settingsInitialSection.value, 'playback')
  assert.equal(navigation.settingsNavigationTarget.value.anchor, 'device-profiles')
  filterCommandPaletteActions(actions, '扫描')[0].run()
  assert.ok(navigation.settingsNavigationTarget.value.entry)
  assert.equal(navigation.settingsNavigationTarget.value.anchor, undefined)
  actions.find((action) => action.id === 'appearance')!.run()
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.showSettingsPage.value, false)
})
