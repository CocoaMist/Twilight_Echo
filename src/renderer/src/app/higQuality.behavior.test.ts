import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const source = (file: string): string => JSON.stringify(join(root, file).replaceAll('\\', '/'))

test('HIG components handle dismissal, tab keys, graph selection, palette focus and responsive CSS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-hig-quality-'))
  try {
    const entry = join(directory, 'entry.ts')
    const html = join(directory, 'test.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      entry,
      `
import { createApp, h, ref, nextTick } from 'vue'
import MessageBar from ${source('src/renderer/src/components/hig/MessageBar.vue')}
import SearchControls from ${source('src/renderer/src/components/streaming-page/StreamingSearchControls.vue')}
import Graph from ${source('src/renderer/src/components/dsp-rack/DspGraphCanvas.vue')}
import Toolbar from ${source('src/renderer/src/desktop-lyrics/components/DesktopLyricsToolbar.vue')}
import { DEFAULT_DESKTOP_LYRICS_SETTINGS } from ${source('src/shared/desktopLyrics.ts')}
import { createDspFactoryScene } from ${source('src/shared/dspGraph.ts')}
import ${source('src/renderer/src/assets/fluent.css')}
import ${source('src/renderer/src/mini-player/MiniPlayer.css')}
const error = ref('首次错误')
const type = ref('songs')
const sourceId = ref('all')
const selected = ref(null)
const moves = []
const settings = ref({ ...DEFAULT_DESKTOP_LYRICS_SETTINGS, palette: 'warm' })
const scene = createDspFactoryScene('transparent')
scene.graph.nodes = [
  { id: 'eq', type: 'parametricEq', enabled: true, params: {} },
  { id: 'meter', type: 'meter', enabled: true, params: {} }
]
createApp({ render: () => h('main', [
  h(MessageBar, { intent: 'error' }, { default: () => error.value, actions: () => h('button', { id: 'retry' }, '重试') }),
  h(SearchControls, { searchType: type.value, availableSearchTypes: ['songs', 'artists'],
    searchSource: sourceId.value, searchSources: [
      { id: 'all', label: '旧名称', available: true },
      { id: 'local', label: '旧名称', available: true },
      { id: 'offline', label: '离线平台', available: false }
    ], 'onUpdate:searchType': value => type.value = value, onSelectSource: value => sourceId.value = value }),
  h(Graph, { scene, selectedNodeId: selected.value, nodeTypeToAdd: 'meter', busy: false, isPinned: false,
    snapshotA: false, state: null, vst3HelpersNotice: '', soxrFallbackActive: false,
    onSelectNode: id => selected.value = id, onMoveNode: (id, destination) => moves.push([id, destination]) }),
  h(Toolbar, { settings: settings.value, playing: false, onPatch: patch => settings.value = { ...settings.value, ...patch } }),
  h('button', { id: 'outside' }, '外部'),
  h('h1', { id: 'main-heading' }, '主标题'),
  h('div', { class: 'mini-player-root', 'data-layout': 'compact', style: '--mini-font-family: monospace' }, [
    h('div', { class: 'mini-track-meta' }, [h('h1', { id: 'mini-heading', class: 'mini-title' }, '歌曲'), h('p', { id: 'mini-caption', class: 'mini-artist' }, '歌手')])
  ]),
  h('section', { class: 'theme-studio-page', 'data-workspace-view': 'editor', id: 'studio-fixture' }, [
    h('div', { class: 'theme-studio-workspace' }, [h('aside', { class: 'theme-editor-pane', id: 'editor-fixture' }), h('main', { class: 'theme-preview-pane', id: 'preview-fixture' })])
  ])
]) }).mount('#app')
const tick = async () => { await nextTick(); await nextTick() }
const expect = (value, message) => { if (!value) throw new Error(message) }
const key = (element, name, extra = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }))
window.runQualityTest = async () => {
  await tick()
  const bar = document.querySelector('.hig-message-bar')
  expect(bar.getAttribute('role') === 'alert', 'errors announce as alerts')
  bar.querySelector('[aria-label="关闭提示"]').click()
  await tick()
  expect(getComputedStyle(bar).display === 'none', 'dismiss really hides the message')
  error.value = '新的错误'
  await tick()
  expect(getComputedStyle(bar).display !== 'none', 'a new error reappears after dismissal')
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  tabs[0].focus()
  key(tabs[0], 'ArrowRight')
  await tick()
  expect(type.value === 'artists' && document.activeElement === tabs[2], 'arrows skip unavailable search types')
  expect(tabs[2].tabIndex === 0 && tabs[0].tabIndex === -1, 'only selected tab is in Tab order')
  key(tabs[2], 'Home')
  await tick()
  expect(type.value === 'songs', 'Home selects first tab')
  const scope = document.querySelector('.hig-search-scope select')
  expect(scope.options[0].text === '全部来源' && scope.options[1].text === '当前音乐库', 'scope terminology is unified')
  expect(scope.options[2].disabled, 'unavailable platforms cannot be selected')
  scope.value = 'local'
  scope.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
  expect(sourceId.value === 'local', 'scope selection reaches the page')
  const nodes = [...document.querySelectorAll('.graph-node')]
  nodes[0].focus()
  key(nodes[0], 'Enter')
  await tick()
  expect(selected.value === 'eq', 'node keyboard selection reaches its editor')
  key(nodes[0], 'ArrowDown')
  expect(document.activeElement === nodes[1], 'node arrows move focus')
  key(nodes[1], 'ArrowUp', { altKey: true })
  expect(moves.length === 1 && moves[0][0] === 'meter' && moves[0][1] === 'eq', 'Alt arrow requests node reorder')
  nodes[1].querySelector('.node-edit-button').click()
  await tick()
  expect(selected.value === 'meter', 'explicit edit button selects the node')
  const trigger = document.querySelector('[aria-label="歌词配色"]')
  trigger.click()
  await tick()
  expect(document.activeElement.getAttribute('aria-checked') === 'true' && document.activeElement.textContent.includes('暖白'), 'palette focuses its current selection')
  key(document.activeElement, 'Escape')
  await tick()
  expect(trigger.getAttribute('aria-expanded') === 'false' && document.activeElement === trigger, 'Escape closes palette and restores focus')
  trigger.click()
  await tick()
  key(document.activeElement, 'Home')
  expect(document.activeElement.getAttribute('aria-label') === '封面强调色', 'palette keyboard navigation moves focus')
  document.activeElement.click()
  await tick()
  expect(settings.value.palette === 'accent' && document.activeElement === trigger, 'palette commit patches settings and restores focus')
  trigger.click()
  await tick()
  document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await tick()
  expect(trigger.getAttribute('aria-expanded') === 'false', 'outside pointer closes palette')
  trigger.click()
  await tick()
  expect(document.activeElement.getAttribute('role') === 'menuitemradio', 'reopened palette receives focus: ' + document.activeElement.outerHTML)
  document.querySelector('#outside').focus()
  // A hidden test window can update activeElement without dispatching OS focus events.
  document.querySelector('#outside').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await tick()
  expect(trigger.getAttribute('aria-expanded') === 'false', 'leaving the palette closes it: ' + document.activeElement.outerHTML)
  document.documentElement.classList.add('mini-player-document')
  expect(getComputedStyle(document.querySelector('#mini-heading')).fontSize === '14.5px', 'mini title is not overwritten by the main title scale')
  expect(getComputedStyle(document.querySelector('#mini-heading')).fontFamily.includes('monospace'), 'mini title preserves the selected font')
  expect(getComputedStyle(document.querySelector('#mini-caption')).fontSize === '12px', 'mini caption remains readable')
  document.documentElement.classList.remove('mini-player-document')
  expect(getComputedStyle(document.querySelector('#main-heading')).fontSize === '28px', 'main title keeps the shared scale')
  return 'HIG_QUALITY_RUNTIME_OK'
}
window.checkResponsive = async () => {
  const page = document.querySelector('#studio-fixture')
  const preview = document.querySelector('#preview-fixture')
  const editor = document.querySelector('#editor-fixture')
  page.dataset.workspaceView = 'editor'
  expect(getComputedStyle(editor).display !== 'none', 'editor stays available')
  if (innerWidth <= 1440) expect(getComputedStyle(preview).display === 'none', 'compact editor mode dedicates space to editing')
  page.dataset.workspaceView = 'preview'
  expect(getComputedStyle(preview).display !== 'none', 'preview is accessible at every width')
  if (innerWidth <= 1440) expect(getComputedStyle(editor).display === 'none', 'compact preview mode dedicates space to preview')
  return innerWidth
}
`
    )
    await build({
      configFile: false,
      root,
      logLevel: 'error',
      plugins: [vue()],
      resolve: {
        alias: {
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          '@renderer': join(root, 'src/renderer/src')
        }
      },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: join(directory, 'bundle'),
        lib: {
          entry,
          name: 'QualityRuntime',
          formats: ['iife'],
          fileName: () => 'runtime.js',
          cssFileName: 'quality'
        }
      }
    })
    await writeFile(
      html,
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle/quality.css"></head><body><div id="app"></div><script src="bundle/runtime.js"></script></body></html>'
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await win.loadFile(process.argv.at(-1))
    console.error(await win.webContents.executeJavaScript('window.runQualityTest()'))
    for (const width of [640, 760, 1280, 1440, 1920, 2560, 3840]) {
      win.setContentSize(width, 900)
      await new Promise(resolve => setTimeout(resolve, 450))
      const actual = await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(async () => resolve(await window.checkResponsive())))')
      if (actual !== width) throw new Error('Viewport mismatch: ' + actual)
      console.error('RESPONSIVE_OK ' + actual)
    }
    app.exit(0)
  } catch (error) { console.error(error.stack); app.exit(1) }
})`
    )
    const result = await promisify(execFile)(require('electron'), [runner, html], {
      timeout: 45_000,
      windowsHide: true
    })
    assert.match(result.stderr, /HIG_QUALITY_RUNTIME_OK/)
    for (const width of [640, 760, 1280, 1440, 1920, 2560, 3840])
      assert.match(result.stderr, new RegExp(`RESPONSIVE_OK ${width}`))
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-hig-quality-')))
    await rm(directory, { recursive: true, force: true })
  }
})
