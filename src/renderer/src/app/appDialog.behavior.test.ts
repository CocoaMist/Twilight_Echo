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

test('real dialog DOM protects nested surfaces, keeps focus inside, and restores focus after cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-hig-dialog-'))
  try {
    const entry = join(directory, 'entry.ts')
    const html = join(directory, 'test.html')
    const runner = join(directory, 'runner.cjs')
    const component = join(root, 'src/renderer/src/components/hig/AppDialogHost.vue').replaceAll(
      '\\',
      '/'
    )
    const dialogs = join(root, 'src/renderer/src/app/useAppDialog.ts').replaceAll('\\', '/')
    await writeFile(
      entry,
      `import { createApp, nextTick } from 'vue'
import AppDialogHost from ${JSON.stringify(component)}
import { confirmAction, promptAction, useAppDialog } from ${JSON.stringify(dialogs)}
createApp(AppDialogHost).mount('#app')
const tick = async () => { await nextTick(); await nextTick() }
const expect = (value, message) => { if (!value) throw new Error(message) }
window.runHigDialogTest = async () => {
  const app = document.querySelector('#app')
  const nested = document.querySelector('#nested-surface')
  const trigger = document.querySelector('#nested-trigger')
  app.inert = true
  trigger.focus()
  const decision = confirmAction({ title: '删除示例？', message: '仅用于测试', destructive: true })
  await tick()
  const panel = document.querySelector('[role="alertdialog"]')
  expect(panel, 'destructive decision requires an alert dialog')
  expect(app.inert && nested.inert, 'both app and teleported surface must be inert')
  const buttons = panel.querySelectorAll('button')
  expect(document.activeElement === buttons[0], 'cancel must receive initial focus')
  buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  expect(document.activeElement === buttons[1], 'reverse Tab must wrap inside the dialog')
  buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await tick()
  expect(useAppDialog().dialog.value, 'Escape cannot dismiss a destructive decision')
  buttons[0].click()
  expect(await decision === false, 'cancel must never authorize deletion')
  await tick()
  expect(app.inert && !nested.inert, 'original background inert states must be restored')
  expect(document.activeElement === trigger, 'focus must return to its teleported trigger')
  app.inert = false
  const rename = promptAction('歌单名称')
  await tick()
  const input = document.querySelector('#hig-dialog-input')
  expect(document.activeElement === input, 'text entry receives focus')
  expect(document.querySelector('.hig-button-primary').disabled, 'an empty name cannot be submitted')
  input.value = '  新名称  '
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  document.querySelector('.hig-button-primary').click()
  expect(await rename === '新名称', 'submitted names are trimmed')
  await tick()
  expect(!app.inert && !nested.inert, 'normal background must be restored')
  const ordinary = confirmAction('普通操作')
  await tick()
  document.querySelector('.hig-dialog button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(await ordinary === false, 'Escape cancels an ordinary dialog')
  return 'HIG_DIALOG_RUNTIME_OK'
}
`,
      'utf8'
    )
    await build({
      configFile: false,
      root,
      logLevel: 'error',
      plugins: [vue()],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: join(directory, 'bundle'),
        lib: { entry, name: 'HigDialogRuntime', formats: ['iife'], fileName: () => 'runtime.js' }
      }
    })
    await writeFile(
      html,
      '<!doctype html><html><body><div id="app"></div><div id="nested-surface"><button id="nested-trigger">Rename</button></div><script src="bundle/runtime.js"></script></body></html>'
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } })
  try {
    await win.loadFile(process.argv.at(-1))
    console.error(await win.webContents.executeJavaScript('window.runHigDialogTest()'))
    app.exit(0)
  } catch (error) { console.error(error.stack); app.exit(1) }
})`
    )
    const result = await promisify(execFile)(require('electron'), [runner, html], {
      timeout: 45_000,
      windowsHide: true
    })
    assert.match(result.stderr, /HIG_DIALOG_RUNTIME_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-hig-dialog-')))
    await rm(directory, { recursive: true, force: true })
  }
})
