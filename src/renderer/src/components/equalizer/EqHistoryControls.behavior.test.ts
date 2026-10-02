import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('EQ history controls switch snapshots, undo, redo and copy through real DOM buttons', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-eq-history-ui-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'EqHistoryTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">曲库整理</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',(_e,_l,message)=>console.error(message));try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runEqHistoryTests()');if(process.env.TWILIGHT_EQ_HISTORY_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_EQ_HISTORY_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('EQ_HISTORY_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /EQ_HISTORY_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick} from 'vue'
import Controls from '@renderer/components/equalizer/EqHistoryControls.vue'
import {useEqualizerHistory} from '@renderer/composables/useEqualizerHistory.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,10));await nextTick()}
const button=label=>document.querySelector('[aria-label="'+label+'"]')
window.runEqHistoryTests=async()=>{
  const initial={eqEnabled:true,eqMode:'parametric',eqPreamp:0,eqBands:[]}
  let applied=initial,pending=Promise.resolve()
  const history=useEqualizerHistory(initial,async value=>{applied=value})
  const command=action=>{pending=action==='undo'||action==='redo'?history.travel(action):action==='copy'?history.copyToOther():history.switchSlot(action)}
  const app=createApp({setup:()=>()=>h(Controls,{activeSlot:history.activeSlot.value,canUndo:history.canUndo.value,canRedo:history.canRedo.value,onCommand:command})})
  app.mount('#app');await tick()
  const click=async label=>{button(label).click();await pending;await tick()}
  expect(button('撤销').disabled&&button('重做').disabled,'initial history is disabled')
  await history.commit({...initial,eqPreamp:-6});await tick()
  expect(!button('撤销').disabled,'edit enables undo')
  button('撤销').focus();await click('撤销')
  expect(applied.eqPreamp===0,'undo restores preamp')
  await click('重做');expect(applied.eqPreamp===-6,'redo restores edit')
  await click('切换到 B 组');expect(applied.eqPreamp===0,'B starts from initial snapshot')
  expect(button('切换到 B 组').getAttribute('aria-pressed')==='true','B is selected')
  await click('切换到 A 组')
  document.querySelector('button[title="将当前参数复制到 B 组"]').click();await pending;await tick()
  expect(history.activeSlot.value==='A','copy does not switch')
  await click('切换到 B 组');expect(applied.eqPreamp===-6,'copy reaches B')
  expect(button('撤销').disabled,'copy clears inactive history')
  const controls=document.querySelector('.eq-history-controls');controls.parentElement.style.width='320px';await tick()
  expect(controls.scrollWidth<=320,'controls fit a narrow toolbar')
  app.unmount()
}
`
