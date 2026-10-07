import { createApp, h, nextTick, ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import { mountWorkshopDecorations } from './theme-workshop/workshopDecorations.ts'
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
  const removeDecorations = mountWorkshopDecorations(document)
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
  const beforeWheel = page.scrollTop
  const readRect = Element.prototype.getBoundingClientRect
  let scrollGeometryReads = 0
  Element.prototype.getBoundingClientRect = function () {
    if (this === page || sections.includes(this)) scrollGeometryReads++
    return readRect.call(this)
  }
  try {
    for (let index = 0; index < 25; index++) {
      page.scrollTop = beforeWheel + index * 8
      page.dispatchEvent(new Event('scrollend'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    expect(
      scrollGeometryReads <= sections.length,
      `native scrollend repeatedly measured skipped sections: ${scrollGeometryReads} reads`
    )
    expect(nav('常规').getAttribute('aria-current') === 'location', 'scroll spy lost its section')
    expect(
      page.style.getPropertyValue('--te-workshop-scroll-y') === '',
      'decoration scrolling invalidated the settings controls through inheritance'
    )
    expect(
      page
        .querySelector(':scope > .workshop-decoration')
        ?.style.getPropertyValue('--te-workshop-scroll-y') === `${page.scrollTop}px`,
      'decoration scroll attachment did not follow the native container'
    )
  } finally {
    Element.prototype.getBoundingClientRect = readRect
    page.scrollTop = beforeWheel
  }
  await settle()
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
  removeDecorations()
  return `SETTINGS_SCROLL_OK: ${skippedRows}/405 rows skipped; stable height; resize/search/disclosure/input/navigation/cleanup verified`
}
