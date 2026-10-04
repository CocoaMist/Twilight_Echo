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
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('search pagination, native keyboard, download focus, radio races and podcast undo work in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-ux-core-'))
  try {
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'ux-audio-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (
              importer?.replaceAll('\\', '/').endsWith('/RadioPodcastPage.vue') &&
              source === '../stores/usePlayerStore'
            )
              return '\0ux-audio-boundary'
            return null
          },
          load(id) {
            return id === '\0ux-audio-boundary'
              ? 'export const usePlayerStore = () => ({playTrack(){},playTrackFromPosition(){}})'
              : null
          }
        },
        vue()
      ],
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
          entry: fileURLToPath(new URL('./uxCoreFlows.fixture.mjs', import.meta.url)),
          name: 'UxCoreTests',
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
        )}<style>body{font-family:system-ui;--te-font-size-body:14px;--te-card-bg:white}button,input{font:inherit}</style></head><body><button id="opener">Open</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',require('node:path').join(process.argv.at(-1),'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
 ipcMain.handle('ux:key',async(_event,key,shift)=>{
   if(key.startsWith('Arrow')) key=key.slice(5);
   const modifiers=shift?['shift']:[];
   win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});
   if(key==='Enter'||key==='Space') win.webContents.sendInputEvent({type:'char',keyCode:key==='Enter'?String.fromCharCode(13):' ',modifiers});
   win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});
   await new Promise(resolve=>setTimeout(resolve,30));
 });
 try {
  await win.loadFile(require('node:path').join(process.argv.at(-1),'index.html'));
  await win.webContents.executeJavaScript("window.pressKey=(key,shift=false)=>require('electron').ipcRenderer.invoke('ux:key',key,shift); void 0");
  console.log(await win.webContents.executeJavaScript('window.runUxCoreTests()'));
  app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), directory],
      { windowsHide: true, timeout: 60_000, env }
    )
    assert.match(result.stdout, /UX_CORE_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
