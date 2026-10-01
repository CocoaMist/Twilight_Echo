import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const source = (file: string): string => JSON.stringify(join(root, file).replaceAll('\\', '/'))

test('actual plugin page and title bar preserve geometry, pending actions, search and notification dismissal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-native-shell-'))
  try {
    const entry = join(directory, 'entry.ts')
    const mockSettings = join(directory, 'settings.ts')
    const mockNcm = join(directory, 'ncm.ts')
    const mockMusic = join(directory, 'music.ts')
    const shellCss = join(directory, 'shell.css')
    const html = join(directory, 'test.html')
    const runner = join(directory, 'runner.cjs')
    const styles = await Promise.all(
      ['App.vue', 'components/SideMenu.vue'].map(async (file) => {
        const text = await readFile(join(root, 'src/renderer/src', file), 'utf8')
        return parse(text)
          .descriptor.styles.map((style) => style.content)
          .join('\n')
      })
    )
    await writeFile(shellCss, styles.join('\n'))
    await writeFile(
      mockSettings,
      `import { ref } from 'vue'; const settings = ref({ developerMode: false }); export const useSettingsStore = () => ({ settings, updateSettings: async patch => Object.assign(settings.value, patch) });`
    )
    await writeFile(
      mockNcm,
      `import { ref } from 'vue'; export const useNcmStore = () => ({ isLoggedIn: ref(false), profile: ref(null) });`
    )
    await writeFile(
      entry,
      `
import { createApp, h, ref, nextTick } from 'vue'
import PluginPage from ${source('src/renderer/src/components/PluginPage.vue')}
import TitleBar from ${source('src/renderer/src/components/TitleBar.vue')}
import AppNoticeHost from ${source('src/renderer/src/components/AppNoticeHost.vue')}
import ProviderSidebar from ${source('src/renderer/src/components/streaming-page/ProviderSidebar.vue')}
import ImportDialog from ${source('src/renderer/src/components/ImportDialog.vue')}
import DesktopLyricsToolbar from ${source('src/renderer/src/desktop-lyrics/components/DesktopLyricsToolbar.vue')}
import TrayPlayer from ${source('src/renderer/src/tray-player/TrayPlayerApp.vue')}
import { DEFAULT_DESKTOP_LYRICS_SETTINGS } from ${source('src/shared/desktopLyrics.ts')}
import { EMPTY_MINI_PLAYER_STATE } from ${source('src/shared/miniPlayer.ts')}
import { useAppNoticeStore } from ${source('src/renderer/src/stores/useAppNoticeStore.ts')}
import ${JSON.stringify(shellCss.replaceAll('\\', '/'))}
import ${source('src/renderer/src/assets/base.css')}
import ${source('src/renderer/src/assets/theme-layouts/obsidian-glass.css')}
import ${source('src/renderer/src/assets/theme-layouts/paper-light.css')}
import ${source('src/renderer/src/components/streaming-page/StreamingPage.css')}
import ${source('src/renderer/src/assets/fluent.css')}
import ${source('src/renderer/src/assets/fluent-icons.css')}
import ${source('src/renderer/src/mini-player/MiniPlayer.css')}
import ${source('src/renderer/src/mini-player/MiniPlayerCustomizer.css')}
import ${source('src/renderer/src/desktop-lyrics/desktopLyrics.css')}
const host = ref(null), menu = ref(true), showImport = ref(false)
let resolveEnable, resolveInstall
const calls = { enable: 0, install: 0, list: 0, minimize: 0, maximize: 0, close: 0 }
const installed = [{ id: 'sample', name: '示例插件', author: '作者', type: ['provider'], version: '1.0', enabled: false, builtIn: false, description: '测试音乐源', error: '暂时失败' }]
const verification = { level: 'unverified', official: false, officialSource: false, indexClaimed: false, signatureStatus: 'missing', keyId: null, keyFingerprintSha256: null, revalidateAt: null, reason: '测试' }
const entries = ['Alpha', 'Beta'].map((name, index) => ({ id: 'update' + index, name, author: '作者', version: '2.0', installedVersion: '1.0', type: ['provider'], description: '可用更新', installState: 'update-available', verification }))
window.api = { fs: { onScanProgress: () => () => {} }, window: { minimize() { calls.minimize++ }, toggleMaximize() { calls.maximize++ }, close() { calls.close++ } }, trayPlayer: { onState: () => () => {}, getBootstrap: async () => ({ state: EMPTY_MINI_PLAYER_STATE }), hide() {}, command() {}, navigate() {} }, plugins: {
  list: async () => { calls.list++; return installed.map(plugin => ({ ...plugin })) }, listIndex: async () => entries,
  getIndexStatus: async () => null, refreshIndex: async () => entries, onChanged: () => () => {},
  enable: () => { calls.enable++; return new Promise(resolve => resolveEnable = () => { installed[0].enabled = true; installed[0].error = ''; resolve({}) }) },
  disable: async () => {}, openLog: async () => {}, chooseAndInstall: () => { calls.install++; return new Promise(resolve => resolveInstall = () => resolve(null)) }
} }
const noticeStore = useAppNoticeStore()
createApp({ render: () => h('div', { class: 'hig-navigation-open' }, [
  h(TitleBar, { menuOpen: menu.value, activeTool: 'plugins', notificationsOpen: host.value?.historyOpen ?? false, onNotifications: () => host.value.toggleHistory() }),
  h('aside', { class: 'side-menu open' }, [h('nav', { class: 'menu-items' }, [h('h2', { class: 'menu-group-label', id: 'group-label' }, '聆听'), h('div', { class: 'menu-bottom', id: 'nav-bottom' }, '来源')])]),
  h('div', { class: ['main-content', { 'menu-open': menu.value }] }, [h(PluginPage),
    h('div', { class: 'streaming-page', id: 'streaming-fixture' }, [h(ProviderSidebar, { menuOpen: false, items: [], isActive: () => false })])]),
  h(AppNoticeHost, { ref: host }), h('button', { id: 'outside', style: 'position:fixed;bottom:0;left:0' }, '外部'),
  h(ImportDialog, { show: showImport.value, onClose: () => showImport.value = false }),
  h('section', { id: 'control-fixtures', style: 'position:fixed;top:200px;left:0;width:460px;height:400px;z-index:-1;--dl-ui-font:Segoe UI' }, [
    h('button', { class: 'mini-tool-button', id: 'mini-icon-fixture' }, [h('i', { class: 'ph ph-sliders-horizontal' })]),
    h('button', { class: 'customizer-icon-button', id: 'customizer-icon-fixture' }, [h('i', { class: 'ph ph-x' })]),
    h(DesktopLyricsToolbar, { settings: DEFAULT_DESKTOP_LYRICS_SETTINGS, playing: false }), h(TrayPlayer)
  ])
]) }).mount('#app')
const teleportedButton = document.createElement('button'); teleportedButton.className = 'hig-icon-button'; teleportedButton.id = 'teleported-close'; teleportedButton.innerHTML = '<i class="pi pi-times"></i>'; document.body.append(teleportedButton)
const tick = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
const expect = (value, message) => { if (!value) throw Error(message) }
const key = (element, name) => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
window.runChecks = async () => {
  await tick()
  await new Promise(resolve => setTimeout(resolve, 180))
  const pluginToggle = document.querySelector('.switch-wrap')
  expect(pluginToggle.tagName === 'BUTTON', 'plugin switch uses native button')
  pluginToggle.click(); pluginToggle.click(); await tick()
  expect(calls.enable === 1 && pluginToggle.disabled, 'enable is locked while pending')
  resolveEnable(); await tick(); await tick()
  expect(pluginToggle.getAttribute('aria-checked') === 'true' && !pluginToggle.disabled, 'enabled state refreshes and unlocks')
  expect(!document.querySelector('.plugin-desc').textContent.includes('暂时失败'), 'old plugin error clears after recovery')
  const packageButton = [...document.querySelectorAll('.top-actions button')].find(button => button.textContent.includes('.tep'))
  packageButton.click(); packageButton.click(); await tick()
  expect(calls.install === 1 && packageButton.disabled, 'local package chooser cannot be duplicated')
  resolveInstall(); await tick()
  expect(!packageButton.disabled, 'cancelling chooser unlocks it')
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  tabs[0].focus(); key(tabs[0], 'End'); await tick()
  expect(tabs[2].getAttribute('aria-selected') === 'true' && document.activeElement === tabs[2], 'End selects and focuses Updates')
  expect(document.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby') === tabs[2].id, 'tabpanel follows selected tab')
  const input = document.querySelector('[aria-label="搜索插件"]')
  input.value = 'Alpha'; input.dispatchEvent(new Event('input', { bubbles: true })); await tick()
  expect(document.querySelectorAll('.plugin-card').length === 1 && document.querySelector('.plugin-card').textContent.includes('Alpha'), 'updates search actually filters updates')
  tabs[0].click(); await tick(); expect(input.value === '', 'tab search is scoped to its destination')
  const bell = document.querySelector('.notification-btn')
  bell.focus(); bell.click(); await tick()
  expect(bell.getAttribute('aria-expanded') === 'true' && document.querySelector('.hig-notice-history').textContent.includes('暂无通知'), 'empty notification drawer is useful')
  key(document.activeElement, 'Escape'); await tick()
  expect(!document.querySelector('.hig-notice-history') && document.activeElement === bell, 'Escape closes drawer and restores trigger focus')
  bell.click(); await tick()
  document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await tick()
  expect(!document.querySelector('.hig-notice-history'), 'outside click dismisses drawer')
  const titleRect = document.querySelector('.title-bar').getBoundingClientRect()
  expect(titleRect.height === 35, 'titlebar is 35px')
  const bellIcon = bell.querySelector('svg').getBoundingClientRect()
  expect(bellIcon.width === 12 && bellIcon.height === 12 && bell.getBoundingClientRect().width === 46, 'notification uses the same icon and button scale as window controls')
  for (const action of ['minimize', 'maximize', 'close']) {
    const button = document.querySelector('.control-btn.' + action)
    const rect = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect()
    expect(rect.width === 46 && rect.height === 35 && getComputedStyle(button).borderRadius === '0px', action + ' shares window-control geometry')
    expect(icon.width === 12 && icon.height === 12 && Math.abs((icon.left + icon.right) / 2 - (rect.left + rect.right) / 2) < 0.1 && Math.abs((icon.top + icon.bottom) / 2 - (rect.top + rect.bottom) / 2) < 0.1, action + ' icon is centered')
    button.click()
    expect(calls[action] === 1, action + ' retains its window action')
  }
  expect(bell.getBoundingClientRect().bottom <= titleRect.bottom, 'notification trigger belongs to chrome')
  for (const button of document.querySelectorAll('.title-bar-start button')) {
    const icon = button.querySelector('svg').getBoundingClientRect()
    expect(icon.width === 16 && icon.height === 16, 'titlebar uses native compact Fluent command icons consistently')
  }
  // Measure final geometry after the real tray entry transition has settled.
  expect(document.querySelector('.tray-player.ready'), 'tray bootstrap completes before geometry checks')
  document.querySelector('#control-fixtures').getAnimations({ subtree: true }).forEach(animation => animation.finish()); await tick()
  for (const [selector, size] of [['#mini-icon-fixture', 16], ['#customizer-icon-fixture', 16], ['.dl-toolbar .is-close', 16], ['.tray-player .close-button', 18], ['#teleported-close', 16]]) {
    const button = document.querySelector(selector), icon = button.querySelector('i'), rect = icon.getBoundingClientRect(), parent = button.getBoundingClientRect()
    expect(Math.abs(rect.width - size) < 0.1 && Math.abs(rect.height - size) < 0.1, selector + ' icon follows its control size: ' + rect.width + 'x' + rect.height)
    expect(Math.abs((rect.left + rect.right) / 2 - (parent.left + parent.right) / 2) < 0.1, selector + ' icon stays centered')
    expect(getComputedStyle(icon).maskImage !== 'none', selector + ' retains Fluent icon mapping outside the main root')
  }
  expect(getComputedStyle(document.querySelector('.dl-toolbar')).fontFamily.includes('Segoe UI'), 'desktop lyrics toolbar retains its configured UI font')
  for (const [theme, preset] of [['dark', 'obsidian-glass'], ['pureWhite', 'paper-light']]) {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.tePresetLayout = preset
    await tick()
    expect(document.querySelector('.title-bar').getBoundingClientRect().height === 35, preset + ' cannot enlarge titlebar')
    for (const action of ['notification-btn', 'minimize', 'maximize', 'close']) {
      const button = document.querySelector('.control-btn.' + action)
      expect(getComputedStyle(button).borderRadius === '0px' && getComputedStyle(button).transform === 'none', preset + ' keeps window controls uniform')
    }
    expect(getComputedStyle(document.querySelector('.title-bar-start')).transform === 'none', preset + ' cannot shift command icons above window controls')
  }
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.tePresetLayout
  showImport.value = true; await tick()
  document.querySelector('.import-dialog').getAnimations({ subtree: true }).forEach(animation => animation.finish()); await tick()
  const dialog = document.querySelector('.import-dialog'), dialogRect = dialog.getBoundingClientRect(), heading = dialog.querySelector('h2').getBoundingClientRect(), close = dialog.querySelector('[aria-label="关闭导入音乐"]')
  expect(Math.abs(heading.left - dialogRect.left - 25) < 1 && heading.right < close.getBoundingClientRect().left, 'import dialog keeps title left and close action right with shared inset')
  expect(Math.abs(close.querySelector('i').getBoundingClientRect().width - 16) < 0.1 && getComputedStyle(close.querySelector('i')).maskImage !== 'none', 'teleported import dialog uses the shared Fluent dismiss icon')
  expect([...dialog.querySelectorAll('.dialog-footer button')].every(button => getComputedStyle(button).borderRadius === '4px'), 'dialog actions use the shared button geometry')
  close.click(); await tick()
  const inset = document.documentElement.style.getPropertyValue('--te-titlebar-inset')
  const previewRoot = document.createElement('div'); document.body.append(previewRoot)
  const preview = createApp({ render: () => h(TitleBar, { menuOpen: false, preview: true }) }); preview.mount(previewRoot); await tick()
  expect(document.documentElement.style.getPropertyValue('--te-titlebar-inset') === inset, 'theme preview cannot change live titlebar clearance')
  preview.unmount()
  return 'NATIVE_SHELL_CHECKS_OK'
}
window.checkGeometry = async () => {
  await tick(); await new Promise(resolve => requestAnimationFrame(resolve))
  const rect = document.querySelector('.plugin-page').getBoundingClientRect()
  const expectedLeft = innerWidth >= 1024 ? 260 : 0
  expect(Math.abs(rect.left - expectedLeft) <= 1, 'plugin page has one sidebar inset at ' + innerWidth + ': ' + rect.left)
  expect(rect.right <= innerWidth + 1, 'plugin page does not overflow viewport')
  const streamingRect = document.querySelector('#streaming-fixture').getBoundingClientRect()
  expect(Math.abs(streamingRect.left - expectedLeft) <= 1 && streamingRect.right <= innerWidth + 1, 'streaming page has one sidebar inset')
  expect(document.querySelector('.provider-navigation').getBoundingClientRect().top >= 35, 'streaming tabs stay below the titlebar')
  expect(document.querySelector('.side-menu').getBoundingClientRect().top === 35, 'sidebar clears the titlebar')
  expect(document.querySelector('.title-bar').getBoundingClientRect().height === 35, 'titlebar height stays fixed across resolutions')
  const content = document.querySelector('.plugin-main-content')
  expect(getComputedStyle(content).display === 'flex', 'plugin content is not shell grid')
  expect(content.scrollWidth <= content.clientWidth + 1, 'plugin content fits its width')
  expect(getComputedStyle(document.querySelector('#group-label')).fontSize === '12px', 'navigation label is not overwritten by h2 ramp')
  expect(getComputedStyle(document.querySelector('#nav-bottom')).marginTop === '16px', 'navigation groups stay together')
  expect(document.querySelector('.plugin-grid').getBoundingClientRect().right <= innerWidth + 1, 'cards fit viewport')
  return innerWidth
}
`
    )
    await writeFile(
      mockMusic,
      `import { ref } from 'vue'; export const useMusicStore = () => ({ scannedFolders: ref([]), isScanning: ref(false), addFolder() {}, addTracks() {}, saveLibrary() {}, refreshLibraryIndex() {}, syncFolders() {} });`
    )
    await build({
      configFile: false,
      root,
      logLevel: 'error',
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: join(root, 'src/renderer/src/stores/useSettingsStore.ts').replaceAll('\\', '/'),
            replacement: mockSettings
          },
          {
            find: join(root, 'src/renderer/src/stores/useNcmStore.ts').replaceAll('\\', '/'),
            replacement: mockNcm
          },
          { find: /\.\.\/stores\/useSettingsStore$/, replacement: mockSettings },
          { find: /\.\.\/stores\/useNcmStore$/, replacement: mockNcm },
          { find: /\.\.\/stores\/useMusicStore$/, replacement: mockMusic },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') },
          { find: '@renderer', replacement: join(root, 'src/renderer/src') }
        ]
      },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: join(directory, 'bundle'),
        lib: {
          entry,
          name: 'ShellChecks',
          formats: ['iife'],
          fileName: () => 'runtime.js',
          cssFileName: 'shell'
        }
      }
    })
    await writeFile(
      html,
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle/shell.css"></head><body><div id="app"></div><script src="bundle/runtime.js"></script></body></html>'
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(async () => { const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
try { await win.loadFile(process.argv.at(-1)); console.error(await win.webContents.executeJavaScript('window.runChecks()'));
for(const width of [760, 1024, 1280, 1920, 2560, 3840]) { win.setContentSize(width, 900); await new Promise(resolve => setTimeout(resolve, 450)); const actual = await win.webContents.executeJavaScript('window.checkGeometry()'); if(actual !== width) throw Error('Viewport mismatch: ' + actual); console.error('GEOMETRY_OK ' + actual) } app.exit(0) }
catch(error) { console.error(error.stack); app.exit(1) } })`
    )
    const result = await promisify(execFile)(require('electron'), [runner, html], {
      timeout: 60_000,
      windowsHide: true
    })
    assert.match(result.stderr, /NATIVE_SHELL_CHECKS_OK/)
    for (const width of [760, 1024, 1280, 1920, 2560, 3840])
      assert.match(result.stderr, new RegExp(`GEOMETRY_OK ${width}`))
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-native-shell-')))
    await rm(directory, { recursive: true, force: true })
  }
})
