import { createApp, h, nextTick, ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import SettingsDisclosure from './settings-page/SettingsDisclosure.vue'
import { useSettingsSearchDisclosure } from './settings-page/settingsSearchDisclosure'
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
let searchPanel
window.makeSettingsSection = (key) => {
  const panelOpen = ref(false)
  const draftValues = ref({})
  useSettingsSearchDisclosure('playerBar', panelOpen)
  if (key === 'appearance') searchPanel = panelOpen
  return () =>
    h(
      'section',
      {
        id: key,
        class: 'glass-card preview-section settings-section'
      },
      [
        h('h2', key),
        key === 'appearance'
          ? h(
              SettingsDisclosure,
              { open: panelOpen.value },
              {
                default: () => [
                  h('div', { class: 'setting-item' }, [
                    h('div', { class: 'setting-copy' }, [h('strong', '播放条可见性')])
                  ]),
                  h('div', { class: 'setting-item' }, [
                    h('div', { class: 'setting-copy' }, [h('strong', '背景模糊与暗化')])
                  ]),
                  h('div', { class: 'setting-item' }, [
                    h('div', { class: 'setting-copy' }, [h('strong', '背景模糊')])
                  ])
                ]
              }
            )
          : null,
        key === 'dsp'
          ? h('details', [
              h('summary', '格式与频谱（高级）'),
              h('label', [h('span', 'DSD 采样率策略'), h('select', [h('option', '自动')])])
            ])
          : null,
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
                    key === 'performance' && index === 20
                      ? '硬件加速'
                      : key === 'playback' && index === 20
                        ? '无缝播放 (Gapless Playback)'
                        : key === 'playback' && index === 21
                          ? '交叉淡入淡出'
                          : `${key} 设置 ${index}`
                  ),
                  h(
                    'span',
                    '这是一段测试设置说明，用来验证调整窗口宽度和字体之后，设置卡片仍能按正确的位置滚动和定位。'.repeat(
                      2
                    )
                  )
                ]),
                index === 0
                  ? h('select', { class: 'preview-select', 'aria-label': '测试选择框' }, [
                      h('option', '跟随系统')
                    ])
                  : null,
                index === 1
                  ? h('div', { class: 'path-control' }, [
                      h('input', { readonly: true, value: 'D:\\Music' }),
                      h('button', '选择文件夹'),
                      h('button', '恢复默认')
                    ])
                  : null,
                h('input', {
                  value: draftValues.value[index] ?? '保留的设置值',
                  'aria-label': `${key}-${index}`,
                  onInput: (event) => {
                    draftValues.value[index] = event.target.value
                  }
                })
              ]
            )
          )
        )
      ]
    )
}

window.runSettingsScrollTests = async () => {
  const mounted = ref(true)
  const props = ref({})
  const app = createApp({ render: () => (mounted.value ? h(SettingsPage, props.value) : null) })
  app.mount('#app')
  await settle()
  const page = document.querySelector('.settings-preview-page')
  const sections = [...page.querySelectorAll('.preview-section')]
  const nav = (label) =>
    [...page.querySelectorAll('.preview-nav-item')].find((button) =>
      button.textContent.includes(label)
    )
  const visible = () => sections.filter((section) => getComputedStyle(section).display !== 'none')
  const selected = (label) => nav(label).getAttribute('aria-current') === 'page'
  const assertPanel = (key) => {
    expect(
      visible().length === 1 && visible()[0].id === key,
      `category ${key} is mixed with another panel`
    )
    const hiddenControls = sections
      .filter((section) => section.id !== key)
      .flatMap((section) => [...section.querySelectorAll('input,button,select')])
    expect(
      hiddenControls.every((control) => !control.checkVisibility()),
      'inactive controls remain visible/focusable'
    )
  }
  expect(sections.length === 9, 'missing categories')
  assertPanel('general')
  // Real Chromium hover must not make labels look selected or move nested controls.
  const hoverFixture = document.createElement('div')
  hoverFixture.className = 'setting-item'
  hoverFixture.innerHTML =
    '<span class="setting-copy">静态说明</span><button class="toggle-switch" role="switch" aria-checked="false" aria-label="悬停测试"></button><button class="swatch" aria-label="颜色测试"></button>'
  document.querySelector('#general').prepend(hoverFixture)
  const switchControl = hoverFixture.querySelector('.toggle-switch')
  const swatchControl = hoverFixture.querySelector('.swatch')
  const moveTo = async (element) => {
    const rect = element.getBoundingClientRect()
    await window.sendSettingsTestInput({
      type: 'mouseMove',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    })
    await settle()
  }
  const bounds = (element) => {
    const rect = element.getBoundingClientRect()
    return [rect.x, rect.y, rect.width, rect.height].join(',')
  }
  for (const theme of ['pureWhite', 'dark']) {
    document.documentElement.dataset.theme = theme
    for (const motion of ['full', 'reduced', 'off']) {
      document.documentElement.dataset.teMotion = motion
      await moveTo(page.querySelector('h1'))
      const rowStyle = getComputedStyle(hoverFixture)
      const rowPaint = [rowStyle.backgroundColor, rowStyle.boxShadow].join(',')
      const switchBounds = bounds(switchControl),
        swatchBounds = bounds(swatchControl)
      await moveTo(hoverFixture.querySelector('.setting-copy'))
      expect(hoverFixture.matches(':hover'), 'hover fixture did not receive pointer')
      expect(
        [rowStyle.backgroundColor, rowStyle.boxShadow].join(',') === rowPaint,
        'hover paints a static settings row'
      )
      await moveTo(switchControl)
      expect(bounds(switchControl) === switchBounds, 'switch moves or scales on hover')
      switchControl.disabled = true
      await settle()
      expect(
        getComputedStyle(switchControl).filter === 'none',
        'disabled switch receives hover feedback'
      )
      switchControl.disabled = false
      await moveTo(swatchControl)
      expect(bounds(swatchControl) === swatchBounds, 'swatch moves or scales on hover')
      const category = nav('播放'),
        categoryBounds = bounds(category)
      await moveTo(category)
      expect(bounds(category) === categoryBounds, 'category moves on hover')
      await window.sendSettingsTestInput({ type: 'keyDown', keyCode: 'Tab' })
      await window.sendSettingsTestInput({ type: 'keyUp', keyCode: 'Tab' })
      await settle()
      switchControl.focus()
      await settle()
      expect(document.activeElement === switchControl, 'switch cannot receive focus')
      expect(
        [rowStyle.backgroundColor, rowStyle.boxShadow].join(',') === rowPaint,
        'focused control paints the whole row'
      )
      switchControl.blur()
    }
  }
  hoverFixture.remove()
  document.documentElement.dataset.theme = 'pureWhite'
  document.documentElement.dataset.teMotion = 'off'
  // Slow startup must not undo a user's category choice.
  nav('外观').click()
  await settle()
  resolveLoad()
  await settle()
  assertPanel('appearance')
  expect(selected('外观'), 'loading reset the selected category')
  nav('常规').click()
  await settle()
  const general = document.querySelector('#general')
  general.querySelector('.test-disclosure').click()
  await settle()
  general.querySelector('input').value = '未保存的输入'
  general.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }))
  nav('快捷键').click()
  await settle()
  assertPanel('shortcuts')
  expect(page.scrollTop === 0 && selected('快捷键'), 'category did not start at its heading')
  page.scrollTo({ top: 800, behavior: 'instant' })
  await settle()
  expect(selected('快捷键'), 'scrolling changed the category selection')
  nav('快捷键').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await settle()
  assertPanel('desktopLyrics')
  expect(document.activeElement === nav('桌面歌词'), 'arrow navigation lost focus')
  expect(
    page.querySelectorAll('.preview-nav-item[tabindex="0"]').length === 1,
    'navigation has multiple tab stops'
  )
  nav('桌面歌词').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  await settle()
  assertPanel('general')
  expect(
    general.querySelector('input').value === '未保存的输入' && expanded.value,
    'category change lost drafts or disclosure state'
  )

  const search = page.querySelector('#settings-search-input')
  expect(search.placeholder.length > 0, 'search has no visible prompt')
  expect(
    getComputedStyle(search).webkitTextFillColor !== 'rgba(0, 0, 0, 0)',
    'search text is transparent'
  )
  const selectSearch = async (query) => {
    search.value = query
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    const result = page.querySelector('#settings-search-result-0')
    expect(result, `no search results for ${query}`)
    const popup = result.getBoundingClientRect()
    const hit = document.elementFromPoint(
      popup.left + popup.width / 2,
      popup.top + popup.height / 2
    )
    expect(result.contains(hit), 'search result is clipped or covered')
    result.click()
    await settle()
  }
  const assertTargetVisible = () => {
    const target = page.querySelector('.search-target-flash')
    expect(target && target.checkVisibility(), 'search target is hidden')
    const rect = target.getBoundingClientRect(),
      frame = page.getBoundingClientRect()
    const navigation = page.querySelector('.settings-preview-nav').getBoundingClientRect()
    const offset = navigation.right > rect.left ? navigation.height + 16 : 0
    expect(
      rect.top >= frame.top + offset - 2 && rect.bottom <= frame.bottom + 2,
      'search target is obscured or offscreen'
    )
  }
  for (const query of ['交叉淡化', 'crossfade']) {
    await selectSearch(query)
    assertPanel('playback')
    expect(
      page.querySelector('.search-target-flash')?.textContent.includes('交叉淡入淡出'),
      'crossfade search missed its row'
    )
    assertTargetVisible()
  }
  // A manual category selection cancels a pending search, even in the same panel.
  search.value = '交叉淡化'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  page.querySelector('#settings-search-result-0').click()
  nav('播放').click()
  await settle()
  expect(!page.querySelector('.search-target-flash'), 'stale search overrode manual navigation')
  expect(!searchPanel.value, 'advanced appearance panel started open')
  await selectSearch('播放条可见性')
  assertPanel('appearance')
  expect(searchPanel.value, 'search did not reveal its collapsed panel')
  assertTargetVisible()
  searchPanel.value = false
  await settle()
  await selectSearch('播放条可见性')
  expect(searchPanel.value, 'repeated search did not reopen the panel')
  await selectSearch('触发距离')
  expect(
    page.querySelector('.search-target-flash')?.textContent === '播放条可见性',
    'unavailable option missed its prerequisite'
  )
  await selectSearch('DSD 采样率策略')
  assertPanel('dsp')
  expect(document.querySelector('#dsp details').open, 'native advanced details stayed closed')

  await window.resizeTestWindow(760)
  await settle()
  const picker = page.querySelector('.settings-category-select')
  expect(
    picker.checkVisibility() && !nav('常规').checkVisibility(),
    'narrow navigation did not adapt'
  )
  picker.value = 'performance'
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  assertPanel('performance')
  const selectRect = page.querySelector('#performance .preview-select').getBoundingClientRect()
  expect(
    selectRect.height >= 28 && selectRect.height <= 64,
    'narrow select uses its width as height'
  )
  const path = page.querySelector('#performance .path-control')
  expect(
    path.parentElement.querySelector('.setting-copy').getBoundingClientRect().width >
      path.parentElement.clientWidth * 0.7,
    'narrow folder controls squeeze their explanation'
  )
  document.documentElement.style.setProperty('--te-font-size-body', '20px')
  await selectSearch('硬件加速')
  assertTargetVisible()
  expect(page.scrollWidth <= page.clientWidth + 1, 'enlarged text overflows narrow settings')
  document.documentElement.style.removeProperty('--te-font-size-body')
  await window.resizeTestWindow(1440)
  await settle()
  for (const category of [
    '常规',
    '播放',
    '音效',
    '缓存',
    '性能',
    '外观',
    '桌面歌词',
    '快捷键',
    '关于'
  ]) {
    nav(category).click()
    await settle()
    expect(
      visible().length === 1 && selected(category),
      'rapid navigation did not settle in one category'
    )
  }
  nav('关于').click()
  nav('常规').click()
  await settle()
  assertPanel('general')
  expect(
    general.querySelector('input').value === '未保存的输入',
    'repeated navigation changed a draft'
  )

  // External deep links select a hidden category before measuring and focusing it.
  props.value = {
    initialSection: 'dsp',
    navigationTarget: {
      revision: 1,
      entry: { section: 'dsp', label: 'DSD 采样率策略', match: 'DSD 采样率策略', keywords: [] }
    }
  }
  await settle()
  assertPanel('dsp')
  assertTargetVisible()
  mounted.value = false
  await settle()
  app.unmount()
  return 'SETTINGS_SCROLL_OK: single-panel navigation; drafts; slow startup; keyboard; scrolling; search; advanced controls; 760/1440 resize; external links; cleanup verified'
}
