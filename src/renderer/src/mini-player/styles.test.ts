import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  createDefaultMiniPlayerThemeProfile
} from '../../../shared/miniPlayer.ts'
import {
  getNextMiniPlayerStyle,
  listMiniPlayerStyles,
  registerMiniPlayerStyle,
  resolveMiniPlayerStyle
} from './styles.ts'

test('mini player ships switchable built-in styles with declared window sizes', () => {
  const styles = listMiniPlayerStyles()
  assert.ok(styles.length >= 2)
  assert.equal(resolveMiniPlayerStyle('missing-style').id, 'aurora-glass')
  assert.notEqual(getNextMiniPlayerStyle('aurora-glass').id, 'aurora-glass')
  assert.ok(styles.every((style) => style.windowSize.width >= MINI_PLAYER_MIN_WIDTH))
  assert.ok(styles.every((style) => style.windowSize.height >= MINI_PLAYER_MIN_HEIGHT))
  assert.ok(styles.every((style) => /^#[\da-f]{6}$/i.test(style.nativeBackgroundColor)))
})

test('registered mini player styles expose isolated complete default profiles', () => {
  const aurora = resolveMiniPlayerStyle('aurora-glass')
  const porcelain = resolveMiniPlayerStyle('porcelain')
  assert.ok(aurora.defaultProfile)
  assert.ok(porcelain.defaultProfile)
  assert.equal(aurora.defaultProfile.appearance.accentMode, 'track')
  assert.equal(porcelain.defaultProfile.appearance.accentMode, 'custom')
  assert.notStrictEqual(aurora.defaultProfile, porcelain.defaultProfile)
})

test('mini player style registry supports future styles and reversible registration', () => {
  const unregister = registerMiniPlayerStyle({
    id: 'test-future-style',
    name: 'Future',
    description: 'Test style',
    className: 'mini-style-future',
    layout: 'artwork-card',
    windowSize: { width: 1, height: 1 },
    accentMode: 'fixed',
    fixedAccent: '#123456',
    nativeBackgroundColor: '#101820',
    defaultProfile: createDefaultMiniPlayerThemeProfile('aurora-glass'),
    tokens: { '--mini-surface': '#000' }
  })

  assert.deepEqual(resolveMiniPlayerStyle('test-future-style').windowSize, {
    width: MINI_PLAYER_MIN_WIDTH,
    height: MINI_PLAYER_MIN_HEIGHT
  })
  assert.throws(
    () =>
      registerMiniPlayerStyle({
        ...resolveMiniPlayerStyle('test-future-style'),
        name: 'Duplicate'
      }),
    /already registered/
  )

  unregister()
  assert.equal(resolveMiniPlayerStyle('test-future-style').id, 'aurora-glass')
})

const component = readFileSync(new URL('./MiniPlayerApp.vue', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./MiniPlayer.css', import.meta.url), 'utf8')

/** The top-level rule whose selector is exactly `selector`. */
function cssRule(selector: string): string {
  const start = styles.indexOf(`\n${selector} {\n`)
  if (start < 0) return ''
  return styles.slice(start + 1, styles.indexOf('\n}', start) + 2)
}

test('mini player no longer renders or reads lyrics', () => {
  assert.doesNotMatch(component, /lyric/i)
  assert.doesNotMatch(styles, /lyric/i)
})

test('mini player moves itself instead of using a drag region that swallows hover', () => {
  assert.doesNotMatch(styles, /-webkit-app-region:\s*drag/)
  assert.match(cssRule('.mini-player-root'), /-webkit-app-region:\s*no-drag/)
  assert.match(component, /@pointerdown="onPointerDown"/)
  assert.match(component, /window\.api\.miniPlayer\.moveTo\(/)
  assert.match(component, /window\.api\.miniPlayer\.moveEnd\(\)/)
  assert.match(component, /settings\.value\.positionLocked/)
  assert.match(component, /closest\('button, input, label, \[data-mini-interactive\]'\)/)
})

test('mini player lays out four forms from one grid', () => {
  const surfaceRule = cssRule('.mini-player-surface')
  assert.match(surfaceRule, /grid-template-areas:\s*'art info'\s*'art progress'\s*'art controls'/)
  for (const layout of ['compact', 'wide', 'poster']) {
    assert.ok(styles.includes(`.mini-player-root[data-layout='${layout}']`), layout)
  }
  assert.match(styles, /grid-template-areas: 'art info controls'/)
  assert.match(styles, /'art'\s*'info'\s*'progress'\s*'controls'/)
  assert.match(component, /:data-layout="resolvedLayout"/)
  assert.match(component, /resolveMiniPlayerLayout/)
  assert.match(component, /nextMiniPlayerSizePreset/)
})

test('mini player artwork stays square and concentric with the window corners', () => {
  const rootRule = cssRule('.mini-player-root')
  const artworkRule = cssRule('.mini-artwork-wrap')
  assert.match(rootRule, /container-type:\s*size/)
  assert.match(rootRule, /--mini-art-radius:\s*max\(6px, calc\(var\(--mini-window-radius\)/)
  assert.match(artworkRule, /aspect-ratio: 1/)
  assert.match(artworkRule, /width: var\(--mini-art-size\)/)
  assert.match(artworkRule, /height: var\(--mini-art-size\)/)
  assert.match(artworkRule, /border-radius: var\(--mini-art-radius\)/)
})

test('mini player window tools wait behind hover and share the kicker line', () => {
  const toolsRule = cssRule('.mini-tools')
  assert.match(toolsRule, /opacity: 0/)
  assert.match(toolsRule, /pointer-events: none/)
  assert.match(styles, /\.mini-player-root\.is-hovered \.mini-tools,\s*\.mini-tools:focus-within/)
  assert.match(styles, /is-hovered \.mini-kicker \{\s*opacity: 0/)
  assert.match(component, /@pointerenter="hovered = true"/)
  assert.match(component, /@pointerleave="hovered = false"/)
  // base.css styles every back control as a white chip with !important.
  assert.match(
    styles,
    /\.mini-tools \.mini-tool-button\[data-te-back-button\] \{[^}]*background: transparent !important/
  )
})

test('mini player sets titles as type and keeps the transport row symmetric', () => {
  assert.match(component, /class="mini-title-lines"/)
  assert.match(
    component,
    /resolvedLayout\.value === 'wide' \|\| resolvedLayout\.value === 'poster'/
  )
  assert.match(cssRule('.mini-title-lines'), /-webkit-line-clamp: 2/)
  const controlsStart = component.indexOf('<footer class="mini-controls">')
  const meta = component.slice(component.indexOf('class="mini-track-meta"'), controlsStart)
  const controls = component.slice(controlsStart, component.indexOf('</footer>'))
  assert.match(meta, /favorite-button/)
  assert.doesNotMatch(controls, /favorite-button/)
  assert.match(styles, /\.mini-volume\.has-slider:hover \.mini-volume-range/)
})

test('mini player progress keeps rounded ends while it fills', () => {
  const fillRule = cssRule('.mini-progress-fill')
  assert.match(
    fillRule,
    /clip-path: inset\(0 calc\(\(1 - var\(--mini-progress, 0\)\) \* 100%\) 0 0 round 999px\)/
  )
  assert.doesNotMatch(fillRule, /scaleX/)
  assert.match(component, /'--mini-progress':/)
})

test('mini player controls cover favourite, play mode, volume wheel and remaining time', () => {
  assert.match(component, /type: 'toggle-favorite'/)
  assert.match(component, /type: 'cycle-play-mode'/)
  assert.match(component, /@wheel\.passive="onWheel"/)
  assert.match(component, /class="mini-volume-hud"/)
  assert.match(component, /toggleRemainingTime/)
  assert.match(component, /MiniGlyph/)
})

test('mini player surface fills the native window without a rectangular backdrop wrapper', () => {
  const mainStyles = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
  const rendererEntry = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
  const miniPlayerWindow = readFileSync(
    new URL('../../../main/integrations/miniPlayer.ts', import.meta.url),
    'utf8'
  )
  const rootRule = cssRule('.mini-player-root')

  assert.doesNotMatch(rootRule, /padding:/)
  assert.match(rootRule, /border-radius: var\(--mini-window-radius\)/)
  assert.match(rootRule, /overflow: hidden/)
  assert.doesNotMatch(rootRule, /clip-path/)
  assert.match(rootRule, /contain: paint/)
  assert.match(
    styles,
    /\.mini-window-fill\s*\{[\s\S]*?background: var\(--mini-background-fallback\)/
  )
  assert.match(mainStyles, /html\.mini-player-document[\s\S]*background: transparent !important/)
  assert.match(
    mainStyles,
    /html\.mini-player-document body::before,\s*html\.mini-player-document body::after \{\s*display: none !important/
  )
  assert.doesNotMatch(mainStyles, /mini-player-native-corners/)
  assert.doesNotMatch(rendererEntry, /nativeCorners|mini-player-native-corners/)
  assert.doesNotMatch(miniPlayerWindow, /nativeCorners/)
  assert.match(miniPlayerWindow, /transparent: true/)
  assert.match(miniPlayerWindow, /roundedCorners: false/)
  assert.match(miniPlayerWindow, /hasShadow: false/)
  assert.doesNotMatch(miniPlayerWindow, /\.setShape\(/)
  assert.match(rendererEntry, /document\.addEventListener\(\s*'dragstart'/)
  assert.match(component, /MiniPlayerCustomizer/)
  assert.match(component, /class="mini-window-fill"/)
  assert.match(component, /mini-background-source/)
  assert.match(component, /mini-background-overlay/)
  assert.match(component, /trackQuality/)
  assert.match(styles, /\.mini-quality-badge/)
  assert.match(component, /settings\.profiles\[settings\.activeStyleId\]/)
  assert.doesNotMatch(component, /mini-player-backdrop/)
})
