import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const source = (path) => JSON.stringify(join(root, path).replaceAll('\\', '/'))

/** Real component + real theme CSS, with all native actions bound to a local simulator. */
export async function createTitlebarFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'echora-titlebar-lab-'))
  const clean = async () => {
    const absolute = resolve(directory)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('echora-titlebar-lab-'))
      throw new Error('Unexpected UI Lab directory')
    await rm(absolute, { recursive: true, force: true })
  }
  try {
    const mockNcm = join(directory, 'ncm.ts')
    const entry = join(directory, 'entry.ts')
    const html = join(directory, 'test.html')
    const runner = join(directory, 'runner.cjs')
    const librarySearch = join(directory, 'LibrarySearch.vue')
    const songListSource = await readFile(
      join(root, 'src/renderer/src/components/SongList.vue'),
      'utf8'
    )
    // Exercise both actual search templates without bootstrapping the music library.
    const searchTemplates = [...songListSource.matchAll(/<div class="search-box"[\s\S]*?<\/div>/g)]
    if (searchTemplates.length !== 2) throw new Error('Expected both SongList search templates')
    await writeFile(
      librarySearch,
      `<script setup>import { ref } from 'vue'; import ThemeIcon from ${source('src/renderer/src/components/ThemeIcon.vue')}; const searchQuery = ref(''), searchInputFocused = ref(false)</script>
<template><section>${searchTemplates.map((match) => match[0]).join('')}</section></template>
<style scoped src=${source('src/renderer/src/components/song-list/SongList.css')}></style>`
    )
    await writeFile(
      mockNcm,
      `import { ref } from 'vue'; export const isLoggedIn=ref(false), profile=ref(null); export const useNcmStore=()=>({isLoggedIn,profile});`
    )
    await writeFile(
      entry,
      `
import { createApp, h, reactive, nextTick } from 'vue'
import TitleBar from ${source('src/renderer/src/components/TitleBar.vue')}
import StreamingTrackToolbar from ${source('src/renderer/src/components/streaming-page/StreamingTrackToolbar.vue')}
import LibrarySearch from ${JSON.stringify(librarySearch.replaceAll('\\', '/'))}
import { isLoggedIn, profile } from ${JSON.stringify(mockNcm.replaceAll('\\', '/'))}
import { pushBackHandler } from ${source('src/renderer/src/app/useBackStack.ts')}
import ${source('src/renderer/src/assets/base.css')}
import ${source('src/renderer/src/assets/theme-layouts/obsidian-glass.css')}
import ${source('src/renderer/src/assets/theme-layouts/paper-light.css')}
import ${source('src/renderer/src/assets/fluent.css')}
import ${source('src/renderer/src/assets/fluent-icons.css')}
const props = reactive({ menuOpen: true, glass: false, liquidMaterial: false, hideStart: false, streaming: false, titleSurface: 'default', notificationsOpen: false })
const toolbarProps = reactive({ query: '', sort: 'default', direction: 'asc', count: 1000, total: 1000, canLocate: false, refreshing: false })
createApp({ render: () => h('div', [h(StreamingTrackToolbar, { ...toolbarProps, 'onUpdate:query': value => toolbarProps.query = value }), h(LibrarySearch)]) }).mount('#search-fixtures')
const calls = { minimize: 0, maximize: 0, close: 0, read: 0, subscribe: 0, release: 0, commands: 0, back: 0 }
let nativeState, initialReply
window.api = { window: {
  getState: () => { calls.read++; return new Promise(resolve => initialReply = resolve) },
  onStateChanged: cb => { calls.subscribe++; nativeState = cb; return () => { calls.release++; nativeState = null } },
  minimize: () => calls.minimize++, toggleMaximize: () => calls.maximize++, close: () => calls.close++
} }
let app = createApp({ render: () => h(TitleBar, { ...props, onCommands: () => calls.commands++, onBack: () => calls.back++ }) })
app.mount('#app')
const checks = []
const check = (value, name) => { if (!value) throw Error(name); checks.push(name) }
const tick = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
const settle = async () => {
  // Hidden windows can suspend animation frames. Read geometry to flush styles,
  // then finish actual animations without depending on compositor visibility.
  document.querySelector('.title-bar').getBoundingClientRect()
  await new Promise(resolve => setTimeout(resolve, 16))
  document.querySelector('.title-bar').getAnimations({ subtree: true }).forEach(animation => animation.finish())
  await tick()
}
const anchors = () => [...document.querySelectorAll('.title-bar-start > button, .title-bar-controls > button')].map(button => {
  const rect = button.getBoundingClientRect()
  return { key: button.className, left: rect.left, top: rect.top, width: rect.width, height: rect.height }
})
const unchanged = (before, after, name) => {
  const stable = before.length === after.length && before.every((rect, index) =>
    rect.key === after[index].key && ['left', 'top', 'width', 'height'].every(key => Math.abs(rect[key] - after[index][key]) < .1))
  check(stable, name + (stable ? '' : ': ' + JSON.stringify({ before, after })))
}
window.runChecks = async () => {
  await tick()
  const rect = element => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, width: value.width, height: value.height } }
  for (const [index, field] of [...document.querySelectorAll('#search-fixtures input[type="text"], #search-fixtures .track-search input')].entries()) {
    const clear = field.parentElement.querySelector('button'), before = rect(field)
    const actions = [...document.querySelectorAll('.track-tool-actions > button, .track-tool-actions > select')]
    const beforeActions = actions.map(rect)
    check(clear.disabled && getComputedStyle(clear).visibility === 'hidden', 'empty-search-clear-is-not-focusable:' + index)
    field.value = 'UI Lab'; field.dispatchEvent(new Event('input', { bubbles: true })); await tick()
    check(!clear.disabled && getComputedStyle(clear).visibility === 'visible', 'search-clear-becomes-available:' + index)
    check(Math.abs(rect(field).width - before.width) < .1, 'typing-cannot-shrink-search-input:' + index)
    check(actions.every((action, i) => Math.abs(rect(action).left - beforeActions[i].left) < .1 && Math.abs(rect(action).top - beforeActions[i].top) < .1), 'search-does-not-displace-sort-or-refresh:' + index)
    clear.click(); await tick()
    check(field.value === '' && clear.disabled && Math.abs(rect(field).width - before.width) < .1, 'clearing-keeps-search-geometry:' + index)
  }
  check(calls.read === 1 && calls.subscribe === 1, 'subscribe-before-window-state-read')
  nativeState({ maximized: true }); initialReply({ maximized: false }); await tick()
  let maximize = document.querySelector('.maximize')
  check(maximize.getAttribute('aria-label') === '还原窗口' && !!maximize.querySelector('path'), 'late-initial-reply-cannot-overwrite-maximize-event')
  maximize.click(); await tick()
  check(calls.maximize === 1 && maximize.title === '还原窗口', 'caption-waits-for-native-acknowledgement')
  nativeState({ maximized: false }); await tick()
  check(maximize.title === '最大化窗口' && !!maximize.querySelector('rect'), 'restore-event-updates-caption-glyph-and-name')
  document.querySelector('.minimize').click(); document.querySelector('.close').click()
  document.querySelector('.command-palette-trigger').click()
  check(calls.minimize === 1 && calls.close === 1 && calls.commands === 1, 'window-and-command-buttons-dispatch-once')
  const releaseAction = pushBackHandler(() => {}, '返回场景')
  await tick(); document.querySelector('.back-btn').click()
  check(calls.back === 1 && document.querySelector('.back-btn').title === '返回场景', 'back-button-keeps-live-handler-and-hint')
  releaseAction(); await tick()
  document.querySelector('.back-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  check(calls.back === 1, 'leaving-back-button-cannot-dispatch-without-history')
  await settle()
  const leaving = document.querySelector('.back-btn')
  leaving?.focus()
  check(document.querySelector('.title-bar-back').inert && (!leaving || document.activeElement !== leaving), 'empty-back-slot-is-not-focusable')
  props.notificationsOpen = true; await tick()
  const bell = document.querySelector('.notification-btn')
  bell.getAnimations().forEach(animation => animation.finish()); await tick()
  check(getComputedStyle(bell).backgroundColor !== 'rgba(0, 0, 0, 0)', 'notification-selection-has-defined-surface-token')
  props.streaming = true; isLoggedIn.value = true
  profile.value = { userId: 1, nickname: 'UI Lab', avatarUrl: 'data:image/png;base64,invalid' }; await tick()
  document.querySelector('.user-avatar')?.dispatchEvent(new Event('error')); await tick()
  check(!document.querySelector('.user-avatar'), 'broken-avatar-falls-back-to-user-icon')
  profile.value = { userId: 2, nickname: 'UI Lab 2', avatarUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/%3E' }; await tick()
  check(!!document.querySelector('.user-avatar'), 'changed-account-retries-avatar')
  profile.value = null; isLoggedIn.value = false; props.streaming = false
  const inset = document.documentElement.style.getPropertyValue('--te-titlebar-inset')
  const staleListener = nativeState
  app.unmount(); staleListener({ maximized: true }); await tick()
  check(calls.release === 1, 'unmount-releases-window-state-listener')
  const releaseBack = pushBackHandler(() => {})
  const before = { ...calls }
  app = createApp({ render: () => h(TitleBar, { menuOpen: false, preview: true }) }); app.mount('#app'); await tick()
  const preview = document.querySelector('.title-bar')
  check(preview.classList.contains('no-drag') && !preview.classList.contains('drag-region'), 'preview-is-never-a-native-drag-region')
  check(!preview.querySelector('.back-btn') && preview.querySelector('.title-bar-back').getBoundingClientRect().width === 36, 'preview-keeps-fixed-slot-without-live-back-stack')
  for (const button of preview.querySelectorAll('.control-btn')) {
    check(button.disabled, 'preview-disables-' + button.className)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  check(JSON.stringify(calls) === JSON.stringify(before), 'preview-cannot-control-or-subscribe-to-live-window')
  check(document.documentElement.style.getPropertyValue('--te-titlebar-inset') === inset, 'preview-cannot-change-live-titlebar-inset')
  app.unmount(); releaseBack()
  app = createApp({ render: () => h(TitleBar, props) }); app.mount('#app'); await tick()
  const lateReply = initialReply
  app.unmount(); lateReply({ maximized: true }); await tick()
  app = createApp({ render: () => h(TitleBar, props) }); app.mount('#app'); await tick(); initialReply({ maximized: false }); await tick()
  check(document.querySelector('.maximize').title === '最大化窗口', 'unmounted-state-read-does-not-affect-next-mount')
  return checks
}
window.checkGeometry = async () => {
  const snapshots = []
  for (const [theme, preset] of [['dark', ''], ['pureWhite', ''], ['dark', 'obsidian-glass'], ['pureWhite', 'paper-light']]) {
    document.documentElement.dataset.theme = theme; document.documentElement.dataset.tePresetLayout = preset
    for (const mode of ['default', 'settings', 'streaming', 'playing', 'login', 'liquid']) {
      props.titleSurface = mode === 'settings' ? 'settings' : mode === 'streaming' ? 'streaming' : 'default'
      props.streaming = mode === 'streaming'; props.glass = mode === 'playing'; props.hideStart = mode === 'login'; props.liquidMaterial = mode === 'liquid'
      await tick(); await settle()
      const title = document.querySelector('.title-bar').getBoundingClientRect()
      check(title.height === 35, 'chrome-height:' + theme + ':' + preset + ':' + mode + ':' + innerWidth)
      const baseline = anchors(), backStates = [{ state: 'absent', anchors: baseline }]
      const record = state => {
        const current = anchors()
        unchanged(baseline, current, 'fixed-command-anchors:' + state + ':' + theme + ':' + preset + ':' + mode + ':' + innerWidth)
        check(document.querySelector('.title-bar-back').getBoundingClientRect().width === 36, 'fixed-back-slot:' + state)
        backStates.push({ state, anchors: current })
      }
      const release = pushBackHandler(() => {}, '返回矩阵场景')
      await tick(); record('entering'); await settle(); record('present')
      release(); await tick(); record('leaving'); await settle(); record('absent-again')
      props.menuOpen = false; props.notificationsOpen = false; await tick()
      unchanged(baseline, anchors(), 'menu-and-notification-state-keeps-anchors:' + mode)
      props.menuOpen = true; props.notificationsOpen = true; await tick()
      for (const [index, button] of [...document.querySelectorAll('.title-bar-start > button')].entries()) {
        check(button.getBoundingClientRect().left === 36 + index * 36, 'left-command-slot:' + button.className + ':' + mode)
      }
      const commandIcons = window.getCommandIconMetrics()
      for (const glyph of commandIcons) {
        check(glyph.size === 16 && glyph.nativeSize === 16, 'native-compact-command:' + glyph.key)
        check(glyph.inkWidth >= 9 && glyph.inkWidth <= 14 && glyph.inkHeight >= 9 && glyph.inkHeight <= 14, 'compact-command-ink-bounds:' + glyph.key)
        check(Math.abs(glyph.offsetX) <= .6 && Math.abs(glyph.offsetY) <= .6, 'compact-command-ink-center:' + glyph.key)
      }
      let edge = 0
      for (const button of document.querySelectorAll('.title-bar-controls button')) {
        const rect = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect()
        check(rect.width === 46 && rect.height === 35 && rect.left >= edge && rect.right <= innerWidth, 'caption-bounds:' + button.className + ':' + mode + ':' + innerWidth)
        check(icon.width === 12 && icon.height === 12 && Math.abs(icon.left + icon.width / 2 - rect.left - rect.width / 2) < .1 && Math.abs(icon.top + icon.height / 2 - rect.top - rect.height / 2) < .1, 'caption-glyph-center:' + button.className + ':' + mode)
        edge = rect.right
      }
      snapshots.push({ width: innerWidth, theme, preset, mode, height: title.height, backStates, commandIcons })
    }
  }
  return snapshots
}
window.getCommandIconMetrics = () => [...document.querySelectorAll('.title-bar-start > button, .title-bar-back > button')].map(button => {
  const svg = button.querySelector('svg'), bounds = svg.getBoundingClientRect(), ink = svg.getBBox(), parent = button.getBoundingClientRect(), nativeSize = svg.viewBox.baseVal.width
  const scale = bounds.width / nativeSize
  return { key: button.className, size: bounds.width, nativeSize, inkWidth: ink.width * scale, inkHeight: ink.height * scale,
    offsetX: bounds.left + (ink.x + ink.width / 2) * scale - parent.left - parent.width / 2,
    offsetY: bounds.top + (ink.y + ink.height / 2) * scale - parent.top - parent.height / 2 }
})
`
    )
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: {
        alias: [
          { find: /\.\.\/stores\/useNcmStore$/, replacement: mockNcm },
          {
            find: join(root, 'src/renderer/src/stores/useNcmStore.ts').replaceAll('\\', '/'),
            replacement: mockNcm
          },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') },
          { find: '@renderer', replacement: join(root, 'src/renderer/src') }
        ]
      },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: join(directory, 'bundle'),
        lib: {
          entry,
          name: 'TitlebarLab',
          formats: ['iife'],
          fileName: () => 'runtime.js',
          cssFileName: 'titlebar'
        }
      }
    })
    await writeFile(
      html,
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle/titlebar.css"></head><body><div id="app"></div><div id="search-fixtures" style="position:absolute;top:80px;left:0;width:680px"></div><script src="bundle/runtime.js"></script></body></html>'
    )
    await writeFile(
      runner,
      `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(async () => {
const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
try {
 await win.loadFile(process.argv.at(-1));
 const checks = await win.webContents.executeJavaScript('window.runChecks()');
 const matrix = [];
 for (const width of [760, 1024, 1280, 1920, 2560, 3840]) {
  win.setContentSize(width, 900); await new Promise(resolve => setTimeout(resolve, 80));
  matrix.push(...await win.webContents.executeJavaScript('window.checkGeometry()'));
 }
 console.log('TITLEBAR_LAB_RESULT ' + JSON.stringify({ checks, matrix, nativeDeviceValidation: false })); app.exit(0);
} catch (error) { console.error(error.stack); app.exit(1) }
});
`
    )
    return { html, runner, clean }
  } catch (error) {
    await clean()
    throw error
  }
}
