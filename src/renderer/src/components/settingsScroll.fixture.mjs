/* eslint-disable vue/one-component-per-file -- Independent fixture mounts verify first-open and reopen behavior. */
import { createApp, h, nextTick, ref, Transition } from 'vue'
import SettingsPage from './SettingsPage.vue'
import '../assets/base.css'

const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  for (let frame = 0; frame < 3; frame++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const noop = async () => []
let resolveLoad
const loading = new Promise((resolve) => {
  resolveLoad = resolve
})
window.settingsScrollMocks = {
  useSettingsStore: new Proxy(
    {
      settings: ref({ cachePolicy: {}, desktopLyrics: {} }),
      paths: ref(null),
      appVersion: ref('1.0.0'),
      restartRequired: ref(false),
      restartReasons: ref([]),
      lastSettingsError: ref(null),
      loadSettings: () => loading,
      formattedCacheSize: ref('0 B'),
      formattedBpmAnalysisCacheSize: ref('0 B'),
      formattedLoudnessAnalysisCacheSize: ref('0 B')
    },
    { get: (target, key) => (key in target ? target[key] : noop) }
  ),
  useMusicStore: new Proxy(
    {
      libraryScanStatus: ref({ state: 'idle' }),
      libraryScanProgress: ref(null),
      libraryMetadataEnrichmentStatus: ref({ state: 'idle' })
    },
    { get: (target, key) => (key in target ? target[key] : noop) }
  ),
  useThemeStore: { load: noop },
  useAudioOutputDspStore: { refreshAudioOutputState: noop },
  registry: { uiContributions: ref([]), syncExtensions: noop }
}
window.api = { library: { getWatcherStatus: async () => null } }
const expanded = ref(false)
window.makeSettingsSection = (key) => () =>
  h(
    'section',
    {
      id: key,
      class: 'glass-card preview-section settings-section'
    },
    [
      h('h2', key),
      h(
        'button',
        {
          class: 'test-disclosure',
          onClick: () => {
            expanded.value = !expanded.value
          }
        },
        '展开'
      ),
      key === 'general' && expanded.value
        ? h('div', { style: { height: '370px' } }, '更多设置')
        : null,
      h(
        'div',
        { class: 'setting-list' },
        Array.from({ length: 45 }, (_, index) =>
          h(
            'div',
            {
              class: 'setting-item',
              style: { minHeight: '60px' }
            },
            [
              h('div', { class: 'setting-copy' }, [
                h(
                  'strong',
                  key === 'performance' && index === 20 ? '硬件加速' : `${key} 设置 ${index}`
                ),
                h(
                  'span',
                  '这是一段测试设置说明，用来验证调整窗口宽度和字体之后，设置卡片仍能按正确的位置滚动和定位。'.repeat(
                    2
                  )
                )
              ]),
              h('input', { value: '保留的设置值', 'aria-label': `${key}-${index}` })
            ]
          )
        )
      )
    ]
  )

window.runSettingsScrollTests = async () => {
  const mounted = ref(true)
  const app = createApp({ render: () => (mounted.value ? h(SettingsPage) : null) })
  app.mount('#app')
  await settle()
  expect(innerWidth === 1440, `unexpected desktop viewport: ${innerWidth}`)
  const page = document.querySelector('.settings-preview-page')
  const sections = [...page.querySelectorAll('.preview-section')]
  const nav = (label) =>
    [...page.querySelectorAll('.preview-nav-item')].find((button) =>
      button.textContent.includes(label)
    )
  const visibleRows = () =>
    [...page.querySelectorAll('.setting-item')].filter((row) =>
      row.checkVisibility({ contentVisibilityAuto: true })
    ).length
  expect(sections.length === 9, 'missing section fixtures')
  expect(
    sections.every((section) => section.classList.contains('settings-section-measured')),
    'rendering waited for settings IPC'
  )
  const skippedRows = 405 - visibleRows()
  expect(
    skippedRows >= 270,
    `distant controls still participate in rendering: ${skippedRows} skipped`
  )
  const height = page.scrollHeight
  page.classList.add('settings-resolving-navigation')
  const fullHeight = page.scrollHeight
  expect(
    Math.abs(height - fullHeight) <= 2,
    `skipping changed scroll height: ${height} vs ${fullHeight}`
  )
  page.classList.remove('settings-resolving-navigation')

  resolveLoad()
  await settle()
  nav('常规').click()
  await settle()
  const general = document.querySelector('#general')
  const beforeExpansion = page.scrollHeight
  general.querySelector('.test-disclosure').click()
  await settle()
  expect(page.scrollHeight >= beforeExpansion + 360, 'disclosure did not update section size')
  general.querySelector('input').value = '未保存的输入'

  nav('快捷键').click()
  await settle()
  const shortcuts = document.querySelector('#shortcuts')
  expect(
    Math.abs(shortcuts.getBoundingClientRect().top - page.getBoundingClientRect().top - 24) <= 3,
    'navigation missed distant card'
  )
  expect(
    nav('快捷键').getAttribute('aria-current') === 'location',
    'navigation lost active section'
  )

  // Remembered heights are now stale. Jumping to a section must first resolve
  // every preceding card at the new width, including skipped cards.
  await window.resizeTestWindow(760)
  await settle()
  expect(innerWidth === 760, `unexpected narrow viewport: ${innerWidth}`)
  nav('性能').click()
  await settle()
  const performance = document.querySelector('#performance')
  const navigation = page.querySelector('.settings-preview-nav')
  const offset = 24 + navigation.getBoundingClientRect().height
  expect(
    Math.abs(performance.getBoundingClientRect().top - page.getBoundingClientRect().top - offset) <=
      3,
    `narrow navigation used stale card heights: top=${performance.getBoundingClientRect().top}, page=${page.getBoundingClientRect().top}, offset=${offset}, scroll=${page.scrollTop}, position=${getComputedStyle(navigation).position}`
  )

  const search = page.querySelector('#settings-search-input')
  search.value = '硬件加速'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  page.querySelector('#settings-search-result-0').click()
  await settle()
  const target = page.querySelector('.search-target-flash')
  expect(target?.textContent.includes('硬件加速'), 'search highlight missing')
  const rect = target.getBoundingClientRect()
  expect(
    rect.top >= page.getBoundingClientRect().top + offset - 2 &&
      rect.bottom <= page.getBoundingClientRect().bottom,
    'search result is outside usable viewport'
  )

  search.focus({ preventScroll: true })
  search.value = '硬件加速'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await settle()
  expect(search.getAttribute('aria-activedescendant'), 'keyboard search selection is missing')
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  expect(page.querySelector('.search-target-flash') === target, 'keyboard search missed its target')
  expect(document.activeElement === search, 'keyboard search unexpectedly moved input focus')

  nav('常规').click()
  await settle()
  expect(
    general.querySelector('input').value === '未保存的输入',
    'skipping remounted an edited control'
  )
  expect(expanded.value, 'skipping reset disclosure state')
  await window.resizeTestWindow(1440)
  await settle()
  nav('播放').click()
  await settle()

  // Native scroll events must use the position cache, with no card measurements
  // on each frame once the layout is stable.
  let reads = 0
  for (const section of sections) {
    const read = section.getBoundingClientRect.bind(section)
    section.getBoundingClientRect = () => {
      reads++
      return read()
    }
  }
  for (let frame = 0; frame < 8; frame++) {
    page.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  expect(reads === 0, `scroll frames measured ${reads} section boxes`)

  document.documentElement.dataset.teMotion = 'full'
  nav('关于').click()
  nav('常规').click()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(
    !page.classList.contains('settings-resolving-navigation'),
    'interrupted smooth navigation kept all cards rendered'
  )
  nav('关于').click()
  mounted.value = false
  await settle()
  expect(
    !page.classList.contains('settings-resolving-navigation'),
    'unmount retained navigation rendering mode'
  )
  expect(
    sections.every((section) => !section.classList.contains('settings-section-measured')),
    'unmount retained rendering observers'
  )
  app.unmount()
  // Entry transforms change visual bounds without changing layout positions.
  const settleEntry = async () => {
    await nextTick()
    const deadline = window.performance.now() + 3000
    let stable = 0
    let previous = -1
    while (window.performance.now() < deadline) {
      await new Promise(requestAnimationFrame)
      const current = document.querySelector('.settings-preview-page')
      const running = current
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation.playState === 'running' &&
            animation.effect?.getComputedTiming().iterations !== Infinity
        )
      stable = !running && Math.abs(current.scrollTop - previous) < 0.1 ? stable + 1 : 0
      previous = current.scrollTop
      if (stable >= 5) return current
    }
    throw new Error('settings entry did not settle')
  }
  const pageDuration = getComputedStyle(document.documentElement)
    .getPropertyValue('--te-motion-page')
    .trim()
  const enterDuration = parseFloat(pageDuration) * (pageDuration.endsWith('ms') ? 1 : 1000) + 30
  for (const width of [800, 1440]) {
    await window.resizeTestWindow(width)
    for (const initialSection of [undefined, 'general', 'playback']) {
      const open = ref(true)
      const entryApp = createApp({
        render: () =>
          h(
            Transition,
            {
              name: 'settings-page',
              appear: true,
              duration: { enter: enterDuration, leave: 0 }
            },
            { default: () => (open.value ? h(SettingsPage, { initialSection }) : null) }
          )
      })
      entryApp.mount('#app')
      for (let opening = 0; opening < 2; opening++) {
        const entryPage = await settleEntry()
        const isDefault = !initialSection || initialSection === 'general'
        if (isDefault) {
          expect(entryPage.scrollTop === 0, 'default entry scrolled away from the page title')
          const title = entryPage.querySelector('.settings-page-header')
          expect(
            title.getBoundingClientRect().top >= entryPage.getBoundingClientRect().top,
            'default entry hid the page title'
          )
        } else {
          const heading = entryPage.querySelector('#playback h2')
          const entryNav = entryPage.querySelector('.settings-preview-nav')
          const lowerBound =
            width === 800
              ? entryNav.getBoundingClientRect().bottom
              : entryPage.getBoundingClientRect().top
          expect(
            heading.getBoundingClientRect().top >= lowerBound,
            'animated initial section landed behind the navigation'
          )
          expect(
            entryPage.querySelector('.preview-nav-item.active')?.textContent.includes('播放'),
            'animated initial section lost its active navigation item'
          )
        }
        open.value = false
        await nextTick()
        while (document.querySelector('.settings-preview-page'))
          await new Promise(requestAnimationFrame)
        if (opening === 0) open.value = true
      }
      entryApp.unmount()
    }
  }
  return `SETTINGS_SCROLL_OK: ${skippedRows}/405 rows skipped; stable height; resize/search/keyboard/disclosure/input/navigation/cleanup; 12 animated initial-link/open/reopen cases verified`
}
