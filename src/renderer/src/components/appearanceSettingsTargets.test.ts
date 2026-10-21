import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appearancePartPanel,
  appearanceSettingsTarget,
  APPEARANCE_STUDIO_PARTS
} from './appearanceSettingsTargets.ts'
import { SETTINGS_SEARCH_INDEX } from './settings-page/types.ts'

test('existing settings resolve to visible part properties rather than hidden legacy sections', () => {
  for (const [id, part, panel] of [
    ['font-rendering', 'global-font', 'global-font'],
    ['player-page-mode', 'player-bar', 'player-bar'],
    ['player-bar-layout', 'player-bar', 'player-bar'],
    ['mini-player', 'player-bar', 'player-bar'],
    ['window-card-blur', 'outer-panel', 'outer-panel'],
    ['ui-density', 'overview', 'general'],
    ['motion', 'overview', 'general'],
    ['accent-dark', 'appearance-theme', 'appearance-theme'],
    ['appearance-editor-105', 'controls', 'appearance-surfaces'],
    ['appearance-editor-87', 'card', 'card'],
    ['appearance-editor-85', 'card', 'card']
  ]) {
    const entry = SETTINGS_SEARCH_INDEX.find((entry) => entry.id === id)
    assert.ok(entry, id)
    const destination = appearanceSettingsTarget(entry)
    assert.deepEqual({ part: destination.part, panel: destination.panel }, { part, panel }, id)
  }
  assert.equal(appearancePartPanel('background'), undefined)
  assert.equal(appearancePartPanel('outer-panel'), 'outer-panel')
  assert.equal(APPEARANCE_STUDIO_PARTS.library, 'card')
  assert.equal(APPEARANCE_STUDIO_PARTS.typography, 'global-font')
})

test('nested and conditional properties resolve to their disclosure chain and enabled fallback', () => {
  const target = (id: string) =>
    appearanceSettingsTarget(SETTINGS_SEARCH_INDEX.find((entry) => entry.id === id)!)
  assert.deepEqual(target('mini-taskbar').disclosures, ['workspace-mini-player', 'mini-player'])
  assert.deepEqual(target('player-page-mode').disclosures, [
    'player-bar',
    'player-bar-behavior-details'
  ])
  assert.deepEqual(target('appearance-editor-107').disclosures, [
    'workspace-liquid-glass',
    'liquid-glass'
  ])
  assert.equal(target('appearance-editor-107').settingId, 'glass-pointer')
  assert.equal(target('appearance-editor-107').fallbackId, 'glass-enabled')
  assert.equal(target('appearance-editor-87').settingId, 'card-saturation')
})
