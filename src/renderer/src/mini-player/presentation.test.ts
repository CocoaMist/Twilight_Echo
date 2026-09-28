import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultMiniPlayerThemeProfile } from '../../../shared/miniPlayer.ts'
import {
  buildMiniPlayerCssVariables,
  estimateMiniPlayerSurface,
  readableTextColors,
  resolveMiniPlayerLayout,
  resolveMiniPlayerVisibility
} from './presentation.ts'

test('responsive layout resolves the strip, card, stage and poster boundaries', () => {
  assert.equal(resolveMiniPlayerLayout(360, 88, 'auto'), 'compact')
  assert.equal(resolveMiniPlayerLayout(700, 149, 'auto'), 'compact')
  assert.equal(resolveMiniPlayerLayout(440, 150, 'auto'), 'standard')
  assert.equal(resolveMiniPlayerLayout(599, 260, 'auto'), 'standard')
  assert.equal(resolveMiniPlayerLayout(600, 230, 'auto'), 'wide')
  assert.equal(resolveMiniPlayerLayout(300, 440, 'auto'), 'poster')
  assert.equal(resolveMiniPlayerLayout(300, 319, 'auto'), 'standard')
  assert.equal(resolveMiniPlayerLayout(440, 440, 'auto'), 'standard')
})

test('forced layout preferences fall back when the window cannot hold them', () => {
  assert.equal(resolveMiniPlayerLayout(700, 300, 'compact'), 'compact')
  assert.equal(resolveMiniPlayerLayout(500, 100, 'standard'), 'compact')
  assert.equal(resolveMiniPlayerLayout(500, 190, 'wide'), 'standard')
  assert.equal(resolveMiniPlayerLayout(640, 300, 'standard'), 'standard')
  assert.equal(resolveMiniPlayerLayout(440, 360, 'poster'), 'poster')
  assert.equal(resolveMiniPlayerLayout(640, 260, 'poster'), 'wide')
})

test('responsive visibility never re-enables a user-hidden element', () => {
  const visibility = createDefaultMiniPlayerThemeProfile('aurora-glass').visibility
  const compact = resolveMiniPlayerVisibility({ ...visibility, artwork: false }, 'compact')
  assert.equal(compact.artwork, false)
  assert.equal(compact.album, false)
  assert.equal(compact.volume, false)
  assert.equal(compact.time, false)
  const poster = resolveMiniPlayerVisibility({ ...visibility, volume: false }, 'poster')
  assert.equal(poster.volume, false)
  assert.equal(poster.time, true)
})

test('standard visibility keeps optional controls except wide-only queue position', () => {
  const visibility = createDefaultMiniPlayerThemeProfile('aurora-glass').visibility
  const standard = resolveMiniPlayerVisibility({ ...visibility, queuePosition: true }, 'standard')
  assert.equal(standard.volume, true)
  assert.equal(standard.time, true)
  assert.equal(standard.queuePosition, false)
  assert.equal(
    resolveMiniPlayerVisibility({ ...visibility, queuePosition: true }, 'wide').queuePosition,
    true
  )
  assert.equal('playbackState' in standard, false)
})

test('presentation variables keep controls opaque while background opacity changes', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  profile.background.opacity = 25
  profile.appearance.cornerRadius = 36
  const variables = buildMiniPlayerCssVariables(profile, '#cc3366', 60)
  assert.equal(variables['--mini-background-opacity'], '0.25')
  assert.equal(variables['--mini-window-radius'], '36px')
  assert.equal(Object.hasOwn(variables, '--mini-progress'), false)
  assert.equal(variables['--mini-volume'], '60%')
  assert.equal(
    variables['--mini-bootstrap-surface'],
    'color-mix(in srgb, #0f172a 82%, transparent)'
  )
  assert.equal(variables['--mini-bootstrap-text'], '#f8fafc')
  assert.equal(
    variables['--mini-bootstrap-action-surface'],
    'color-mix(in srgb, #8fa8b5 88%, #fff)'
  )
  assert.equal(variables['--mini-bootstrap-action-text'], '#fff')
  assert.equal(variables['--mini-surface-backdrop'], 'rgba(12, 12, 18, 0.92)')
  assert.equal(Object.hasOwn(variables, 'opacity'), false)
})

test('automatic text colors choose readable light and dark families', () => {
  assert.equal(readableTextColors('#11121d').primary, '#ffffff')
  assert.equal(readableTextColors('#f4f5fb').primary, '#1b2034')
})

test('track accent is lifted off the surface when the cover colour would vanish into it', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  const dim = buildMiniPlayerCssVariables(profile, '#121320', 70)
  assert.notEqual(dim['--mini-accent'], '#121320')
  assert.equal(dim['--mini-track-accent'], '#121320')
  const vivid = buildMiniPlayerCssVariables(profile, '#ff5a8a', 70)
  assert.equal(vivid['--mini-accent'], '#ff5a8a')
})

test('near-grey cover colours keep neutral controls without a saved accent tint', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  profile.appearance.accentMode = 'custom'
  profile.appearance.accentColor = '#7c4dff'
  for (const grey of ['#151515', '#5b5b5b', '#f2f2f2']) {
    const variables = buildMiniPlayerCssVariables(profile, grey, 70)
    assert.equal(variables['--mini-track-accent'], grey)
    const accentChannels = channels(variables['--mini-accent']!)
    assert.ok(Math.max(...accentChannels) - Math.min(...accentChannels) < 0.01)
  }
})

test('saved purple settings cannot tint a cover background or its controls', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  profile.background.fallbackColor = '#11121d'
  profile.appearance.accentMode = 'custom'
  profile.appearance.accentColor = '#7c4dff'
  profile.appearance.textMode = 'custom'
  profile.appearance.primaryTextColor = '#ffffff'

  const variables = buildMiniPlayerCssVariables(profile, '#00a6d6', 70, '#f6fafe')
  assert.equal(variables['--mini-background-fallback'], '#f6fafe')
  assert.equal(variables['--mini-track-accent'], '#00a6d6')
  assert.equal(variables['--mini-text'], '#1b2034')
  assert.ok(Math.abs(hueOf(variables['--mini-accent']!) - hueOf('#00a6d6')) < 4)
  assert.ok(contrast(variables['--mini-accent']!, '#f6fafe') >= 3)

  profile.background.kind = 'solid'
  const solidVariables = buildMiniPlayerCssVariables(profile, '#00a6d6', 70)
  assert.equal(solidVariables['--mini-background-fallback'], '#11121d')
  assert.equal(solidVariables['--mini-track-accent'], '#7c4dff')
  assert.equal(solidVariables['--mini-text'], '#ffffff')
})

test('dark cover backgrounds retain light text', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  const variables = buildMiniPlayerCssVariables(profile, '#218fbd', 70, '#132b3b')
  assert.equal(variables['--mini-background-fallback'], '#132b3b')
  assert.equal(variables['--mini-text'], '#ffffff')
  assert.ok(contrast(variables['--mini-accent']!, '#132b3b') >= 3)
})

test('dark saturated covers keep their hue while the accent is lifted to 3:1', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  for (const cover of ['#3a0a14', '#0b1a4a']) {
    const variables = buildMiniPlayerCssVariables(profile, cover, 70, cover)
    const accent = variables['--mini-accent']!
    const surface = estimateMiniPlayerSurface(profile, cover)
    assert.ok(contrast(accent, surface) >= 3, `${cover} -> ${accent} on ${surface}`)
    assert.ok(Math.abs(hueOf(accent) - hueOf(cover)) < 4, `${cover} -> ${accent}`)
  }
})

test('the cover surface estimate follows the cover while ignoring saved background controls', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  const bright = estimateMiniPlayerSurface(profile, '#f6fafe')
  const dark = estimateMiniPlayerSurface(profile, '#132b3b')
  assert.ok(luminance(bright) > luminance(dark))
  profile.background.fallbackColor = '#11121d'
  profile.background.opacity = 0
  profile.background.overlayOpacity = 0
  assert.equal(estimateMiniPlayerSurface(profile, '#f6fafe'), bright)
})

test('the shadow strength setting drives the artwork shadow', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  assert.equal(
    buildMiniPlayerCssVariables(profile, '#cc3366', 60)['--mini-art-shadow'],
    'rgba(0, 0, 0, 0.496)'
  )
  profile.appearance.shadowStrength = 0
  assert.equal(
    buildMiniPlayerCssVariables(profile, '#cc3366', 60)['--mini-art-shadow'],
    'rgba(0, 0, 0, 0)'
  )
})

function channels(color: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255)
}

function hueOf(color: string): number {
  const [red, green, blue] = channels(color) as [number, number, number]
  const max = Math.max(red, green, blue)
  const delta = max - Math.min(red, green, blue)
  if (delta === 0) return 0
  const sector =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4
  return (sector * 60 + 360) % 360
}

function luminance(color: string): number {
  const [red, green, blue] = channels(color).map((value) =>
    value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  ) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number
  ]
  return (light + 0.05) / (dark + 0.05)
}
