import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { installAutoHideScrollbars } from './autoHideScrollbars.ts'

const runtime = readFileSync(new URL('./autoHideScrollbars.ts', import.meta.url), 'utf8')
const baseStyles = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')

test('auto-hide scrollbar runtime discovers nested scroll containers through event delegation', () => {
  assert.match(runtime, /findScrollableAncestor/)
  assert.match(runtime, /document\.addEventListener\('pointermove'/)
  assert.match(runtime, /document\.addEventListener\('scroll',[\s\S]*capture: true/)
  assert.match(runtime, /SCROLLBAR_PROXIMITY_PX = 28/)
  assert.match(runtime, /is-scrollbar-near/)
  assert.match(runtime, /is-scrollbar-active/)
  assert.match(runtime, /ancestorCache/)
  assert.match(runtime, /SCROLLBAR_FAR_SKIP_PX/)
  assert.match(runtime, /invalidateAutoHideScrollbarCache/)
})

test('global scrollbar styling is hidden by default and uses neutral reveal tokens', () => {
  assert.match(baseStyles, /--te-scrollbar-thumb:/)
  assert.match(baseStyles, /--te-scrollbar-thumb-hover:/)
  assert.match(baseStyles, /scrollbar-color: transparent transparent !important/)
  assert.match(baseStyles, /\.te-auto-scrollbar\.is-scrollbar-near/)
  assert.match(baseStyles, /background: var\(--te-scrollbar-thumb\) !important/)
  assert.doesNotMatch(baseStyles, /--te-scrollbar-thumb:\s*rgba\(var\(--te-primary-rgb\)/)

  assert.match(baseStyles, /-webkit-user-drag: none/)
  assert.match(baseStyles, /user-drag: none/)

  const scrollbarSources = [
    baseStyles,
    '../components/RadioPodcastPage.vue',
    '../components/player-bar/PlayerBar.css',
    '../components/song-list/SongList.css',
    '../components/streaming-page/StreamingPage.css'
  ].map((source) =>
    source === baseStyles ? source : readFileSync(new URL(source, import.meta.url), 'utf8')
  )

  for (const source of scrollbarSources) {
    assert.doesNotMatch(
      source,
      /scrollbar-(?:color|thumb)[^\n]*(?:te-primary|hifi-accent|124,\s*77,\s*255|purple)/i
    )
    assert.doesNotMatch(
      source,
      /::-webkit-scrollbar-thumb[\s\S]{0,180}background[^;]*(?:te-primary|hifi-accent|124,\s*77,\s*255|purple)/i
    )
  }
})

test('back button tokens use a blue icon with neutral surfaces instead of the theme accent', () => {
  assert.match(baseStyles, /--te-back-button-bg:/)
  assert.match(baseStyles, /--te-back-button-border:/)
  assert.match(baseStyles, /--te-back-button-color:\s*#2563eb/)
  assert.match(baseStyles, /--te-back-button-color:\s*#60a5fa/)
  assert.match(baseStyles, /\[data-te-back-button\]/)
})

test('in-flow back controls still opt in to the shared minimal style', () => {
  // Only in-flow controls keep carrying a back affordance: the onboarding
  // wizard stepper, the mini player's "return to main window", and the login
  // page's error-state recovery CTA. Page-level chrome moved to the title bar.
  const componentSources = [
    '../components/LoginPage.vue',
    '../components/onboarding/OnboardingWizard.vue',
    '../mini-player/MiniPlayerApp.vue'
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

  for (const source of componentSources) assert.match(source, /data-te-back-button=/)
})

test('page-level back buttons are gone; the title bar owns the global back affordance', () => {
  const componentSources = [
    '../components/SongList.vue',
    '../components/NetworkSourcesPage.vue',
    '../components/RadioPodcastPage.vue',
    '../components/LoginPage.vue',
    '../components/PluginExtensionPage.vue',
    '../components/ThemeStudioPage.vue',
    '../components/DspRackPage.vue',
    '../components/EqualizerPage.vue',
    '../components/aggregate-playlist/AggregatePlaylistPage.vue',
    '../components/streaming-page/StreamingContentHeader.vue'
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

  for (const source of componentSources) assert.doesNotMatch(source, /data-te-page-back-button=/)

  const titleBar = readFileSync(new URL('../components/TitleBar.vue', import.meta.url), 'utf8')
  assert.match(titleBar, /useBackStack/)
  assert.match(titleBar, /class="back-btn"/)
  assert.match(titleBar, /\$emit\('back'\)/)

  const appShell = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  assert.match(appShell, /backStack\.useBackHandler\(showPlayingPage, closePlayingPage\)/)
  // Alt+Left is the keyboard path into the same stack.
  assert.match(appShell, /onGlobalBackKeydown/)
})

test('pointer frames only mutate changed classes and cannot reveal scrollbars after leaving', () => {
  const previous = new Map(
    ['window', 'document', 'Element', 'HTMLElement'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name)
    ])
  )
  let writes = 0
  class TestElement extends EventTarget {
    tokens = new Set<string>()
    parentElement = null
    clientHeight = 300
    clientWidth = 300
    scrollHeight = 900
    scrollWidth = 300
    classList = {
      contains: (token: string) => this.tokens.has(token),
      toggle: (token: string, enabled: boolean) => {
        writes++
        if (enabled) this.tokens.add(token)
        else this.tokens.delete(token)
        return enabled
      }
    }
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 300, bottom: 300 }
    }
  }
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  let id = 0
  const win = Object.assign(new EventTarget(), {
    getComputedStyle: () => ({ overflowY: 'auto', overflowX: 'hidden' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: () => void) => {
      timers.set(++id, callback)
      return id
    },
    clearTimeout: (id: number) => timers.delete(id)
  })
  const scroller = new TestElement()
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    scrollingElement: scroller,
    documentElement: new TestElement(),
    body: new TestElement()
  })
  Object.defineProperties(
    globalThis,
    Object.fromEntries(
      Object.entries({
        window: win,
        document: doc,
        Element: TestElement,
        HTMLElement: TestElement
      }).map(([name, value]) => [name, { configurable: true, value }])
    )
  )
  const flush = (): void => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  }
  const move = (): void => {
    doc.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 298, clientY: 80 }))
  }
  const near = (): boolean => scroller.classList.contains('is-scrollbar-near')
  let cleanup: (() => void) | undefined
  try {
    cleanup = installAutoHideScrollbars()
    move()
    flush()
    assert.equal(near(), true)
    const firstWrites = writes
    for (let i = 0; i < 100; i++) {
      move()
      flush()
    }
    assert.equal(writes, firstWrites, 'stationary proximity must not churn DOM attributes')
    for (const [surface, event] of [
      [doc, 'pointerleave'],
      [win, 'blur']
    ] as const) {
      move()
      surface.dispatchEvent(new Event(event))
      assert.equal(frames.size, 0)
      flush()
      assert.equal(near(), false)
      move()
      flush()
      assert.equal(near(), true)
    }
    doc.dispatchEvent(new Event('scroll'))
    assert.equal(scroller.classList.contains('is-scrollbar-active'), true)
    assert.equal(timers.size, 1)
    move()
    doc.hidden = true
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(frames.size, 0)
    assert.equal(timers.size, 0)
    assert.equal(near(), false)
    assert.equal(scroller.classList.contains('is-scrollbar-active'), false)
    doc.hidden = false
    move()
    cleanup()
    cleanup = undefined
    assert.equal(frames.size, 0)
    move()
    assert.equal(frames.size, 0, 'uninstall must remove pointer handlers')
  } finally {
    cleanup?.()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
