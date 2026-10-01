import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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
    await writeFile(
      mockNcm,
      `import { ref } from 'vue'; export const isLoggedIn=ref(false), profile=ref(null); export const useNcmStore=()=>({isLoggedIn,profile});`
    )
    await writeFile(
      entry,
      `
import { createApp, h, reactive, nextTick } from 'vue'
import TitleBar from ${source('src/renderer/src/components/TitleBar.vue')}
import { isLoggedIn, profile } from ${JSON.stringify(mockNcm.replaceAll('\\', '/'))}
import { pushBackHandler } from ${source('src/renderer/src/app/useBackStack.ts')}
import ${source('src/renderer/src/assets/base.css')}
import ${source('src/renderer/src/assets/theme-layouts/obsidian-glass.css')}
import ${source('src/renderer/src/assets/theme-layouts/paper-light.css')}
import ${source('src/renderer/src/assets/fluent.css')}
import ${source('src/renderer/src/assets/fluent-icons.css')}
const props = reactive({ menuOpen: true, glass: false, liquidMaterial: false, hideStart: false, streaming: false, titleSurface: 'default', notificationsOpen: false })
const calls = { minimize: 0, maximize: 0, close: 0, read: 0, subscribe: 0, release: 0, commands: 0 }
let nativeState, initialReply
window.api = { window: {
  getState: () => { calls.read++; return new Promise(resolve => initialReply = resolve) },
  onStateChanged: cb => { calls.subscribe++; nativeState = cb; return () => { calls.release++; nativeState = null } },
  minimize: () => calls.minimize++, toggleMaximize: () => calls.maximize++, close: () => calls.close++
} }
let app = createApp({ render: () => h(TitleBar, { ...props, onCommands: () => calls.commands++ }) })
app.mount('#app')
const checks = []
const check = (value, name) => { if (!value) throw Error(name); checks.push(name) }
const tick = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
window.runChecks = async () => {
  await tick()
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
  check(!preview.querySelector('.back-btn') && !preview.querySelector('.title-bar-back-visible'), 'preview-does-not-inherit-live-back-stack')
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
      await tick()
      const title = document.querySelector('.title-bar').getBoundingClientRect()
      check(title.height === 35, 'chrome-height:' + theme + ':' + preset + ':' + mode + ':' + innerWidth)
      let edge = 0
      for (const button of document.querySelectorAll('.title-bar-controls button')) {
        const rect = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect()
        check(rect.width === 46 && rect.height === 35 && rect.left >= edge && rect.right <= innerWidth, 'caption-bounds:' + button.className + ':' + mode + ':' + innerWidth)
        check(icon.width === 12 && icon.height === 12 && Math.abs(icon.left + icon.width / 2 - rect.left - rect.width / 2) < .1 && Math.abs(icon.top + icon.height / 2 - rect.top - rect.height / 2) < .1, 'caption-glyph-center:' + button.className + ':' + mode)
        edge = rect.right
      }
      snapshots.push({ width: innerWidth, theme, preset, mode, height: title.height })
    }
  }
  return snapshots
}
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
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="bundle/titlebar.css"></head><body><div id="app"></div><script src="bundle/runtime.js"></script></body></html>'
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
