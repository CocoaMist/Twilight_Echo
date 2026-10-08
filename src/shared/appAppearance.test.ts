import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyAppearancePreset,
  backgroundEffect,
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings,
  normalizeBackgroundEffect,
  resolveBackground
} from './appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from './liquidGlass.ts'

test('legacy effects migrate per tone, and an explicit new profile wins without double application', () => {
  const legacy = {
    enabled: true,
    light: { blur: 12, brightness: 80, dim: 15 },
    dark: { blur: 20, brightness: 65, dim: 40 }
  }
  const migrated = normalizeAppBackgroundSettings({}, legacy)
  assert.equal(backgroundEffect(migrated.global, 'dark').dim, 40)
  assert.equal(backgroundEffect(resolveBackground(migrated, 'local'), 'light').blur, 12)
  const explicit = normalizeAppBackgroundSettings(
    { global: { effects: { dark: { dim: 3 } } } },
    legacy
  )
  assert.equal(backgroundEffect(explicit.global, 'dark').dim, 3)
  assert.equal(backgroundEffect(explicit.global, 'light').blur, 0)
  assert.deepEqual(normalizeAppBackgroundSettings(migrated, legacy), migrated)
})
test('background effects reject non-finite values, clamp bounds and keep safe asset handles', () => {
  const value = normalizeBackgroundEffect({
    blur: 100,
    brightness: NaN,
    scale: Infinity,
    dim: -2,
    positionX: 200,
    textTone: 'script'
  })
  assert.deepEqual(value, {
    blur: 30,
    brightness: 100,
    scale: 1,
    dim: 0,
    positionX: 100,
    positionY: 50,
    textTone: 'theme'
  })
  assert.equal(
    normalizeAppBackgroundSettings({ global: { image: 'file:///private.png' } }).global.image,
    ''
  )
  assert.equal(
    normalizeAppBackgroundSettings({ global: { image: 'background://wallpaper.webp' } }).global
      .image,
    'background://wallpaper.webp'
  )
})
test('page inheritance includes effects and independent pages survive settings round trips', () => {
  const background = normalizeAppBackgroundSettings({
    global: { kind: 'image', image: 'background://one.png', effects: { dark: { scale: 2 } } },
    pages: {
      settings: {
        inherit: false,
        kind: 'image',
        image: 'background://two.png',
        effects: { dark: { blur: 16, textTone: 'light' } }
      }
    }
  })
  assert.equal(resolveBackground(background, 'local').image, 'background://one.png')
  assert.equal(backgroundEffect(resolveBackground(background, 'local'), 'dark').scale, 2)
  assert.equal(backgroundEffect(resolveBackground(background, 'settings'), 'dark').blur, 16)
  assert.deepEqual(
    normalizeAppBackgroundSettings(JSON.parse(JSON.stringify(background))),
    background
  )
})
test('transparent material preserves saved tuning and switching back restores the profile', () => {
  const original = cloneAppearance({
    appBackground: normalizeAppBackgroundSettings({}),
    cardAppearance: defaultCardAppearance(),
    liquidGlass: DEFAULT_LIQUID_GLASS,
    surfaceMaterial: 'standard'
  })
  const frosted = applyAppearancePreset(original, 'frosted')
  assert.equal(frosted.cardAppearance.dark.backgroundOpacity, 60)
  frosted.cardAppearance.dark.blurRadius = 9
  frosted.liquidGlass.dark.tintOpacity = 17
  const transparent = applyAppearancePreset(frosted, 'transparent')
  assert.equal(transparent.surfaceMaterial, 'transparent')
  assert.deepEqual(transparent.cardAppearance, frosted.cardAppearance)
  const restored = applyAppearancePreset(transparent, 'frosted')
  assert.equal(restored.cardAppearance.dark.blurRadius, 9)
  assert.equal(restored.liquidGlass.dark.tintOpacity, 17)
  assert.equal(original.cardAppearance.dark.backgroundOpacity, 100)
})
