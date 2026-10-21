import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MATERIAL_DECLARATIONS,
  MATERIAL_FOUNDATION,
  MATERIAL_ROLES,
  compileMaterialCss,
  materialContract,
  resolveMaterialMode
} from './materials.ts'

test('default navigation samples the background without a dark overlay', () => {
  assert.equal(MATERIAL_FOUNDATION['--te-window-foundation-tint'], 'transparent')
  assert.equal(
    MATERIAL_FOUNDATION['--te-chrome-navigation-surface'],
    'var(--te-window-foundation-tint)'
  )
})

test('optics belong to chrome; reading surfaces and flat transport cannot acquire them', () => {
  for (const role of MATERIAL_ROLES) {
    assert.equal(
      resolveMaterialMode(role, { mode: 'liquidGlass' }),
      MATERIAL_DECLARATIONS[role].optical ? 'liquidGlass' : 'standard'
    )
    for (const flag of [
      'blurDisabled',
      'reducedEffects',
      'reducedTransparency',
      'increasedContrast',
      'forcedColors'
    ] as const) {
      assert.equal(resolveMaterialMode(role, { mode: 'liquidGlass', [flag]: true }), 'standard')
      assert.equal(resolveMaterialMode(role, { mode: 'transparent', [flag]: true }), 'standard')
    }
  }
  for (const role of ['dialog', 'popover', 'panel', 'control'] as const)
    assert.equal(resolveMaterialMode(role, { mode: 'transparent' }), 'standard')
  assert.equal(
    resolveMaterialMode('transport', { mode: 'liquidGlass', flatTransport: true }),
    'standard'
  )
  assert.equal(resolveMaterialMode('titlebar', { immersive: true }), 'transparent')
})
test('CSS and plugin manifests are generated from the same contract', async () => {
  assert.equal(
    await readFile(new URL('../renderer/src/assets/materials.css', import.meta.url), 'utf8'),
    compileMaterialCss()
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(
        new URL('../../packages/plugin-api/material-contract.json', import.meta.url),
        'utf8'
      )
    ),
    materialContract()
  )
})
