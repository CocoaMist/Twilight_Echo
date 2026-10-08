import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings,
  type AppearanceDraft
} from '../../shared/appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from '../../shared/liquidGlass.ts'
import { loadSettingsFile, writeSettingsFile } from './settingsFile.ts'

test('appearance settings survive disk reloads and legacy migration is applied only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-appearance-settings-'))
  try {
    const defaults: AppearanceDraft = {
      appBackground: normalizeAppBackgroundSettings({}),
      cardAppearance: defaultCardAppearance(),
      surfaceMaterial: 'standard',
      liquidGlass: DEFAULT_LIQUID_GLASS
    }
    const normalize = (value: Partial<AppearanceDraft>): AppearanceDraft =>
      cloneAppearance({ ...defaults, ...value })
    const file = join(directory, 'settings.json')
    const legacy = {
      ...defaults,
      appBackground: {
        global: { kind: 'image', image: 'background://saved.webp' },
        pages: { player: { inherit: false, dark: '#123456' } }
      },
      cardAppearance: {
        ...defaultCardAppearance(),
        background: {
          enabled: true,
          light: { blur: 9, dim: 20, brightness: 90 },
          dark: { blur: 15, dim: 40, brightness: 80 }
        }
      }
    }
    writeSettingsFile(file, legacy)
    const migrated = loadSettingsFile(file, defaults, normalize).settings
    assert.equal(migrated.appBackground.global.effects!.dark.blur, 15)
    migrated.surfaceMaterial = 'transparent'
    migrated.appBackground.global.effects!.dark.scale = 1.5
    migrated.appBackground.global.effects!.light.textTone = 'dark'
    migrated.appBackground.pages.player.effects!.dark.blur = 3
    migrated.cardAppearance.enabled = true
    migrated.cardAppearance.dark.backgroundOpacity = 60
    writeSettingsFile(file, migrated)
    const restarted = loadSettingsFile(file, defaults, normalize)
    assert.equal(restarted.issue, null)
    assert.deepEqual(restarted.settings, migrated)
    assert.equal(restarted.settings.cardAppearance.background.enabled, false)
    assert.equal(restarted.settings.appBackground.pages.player.inherit, false)
    assert.equal(restarted.settings.appBackground.global.image, 'background://saved.webp')
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-appearance-settings-'))
    await rm(directory, { recursive: true, force: true })
  }
})
