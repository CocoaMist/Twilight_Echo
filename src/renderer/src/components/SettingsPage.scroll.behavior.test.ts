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
const sectionKeys: Record<string, string> = {
  General: 'general',
  Playback: 'playback',
  Dsp: 'dsp',
  Cache: 'cache',
  Performance: 'performance',
  Appearance: 'appearance',
  DesktopLyrics: 'desktopLyrics',
  Shortcuts: 'shortcuts',
  About: 'about'
}

test('settings skip distant content without shifting scroll height or breaking navigation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-settings-scroll-'))
  try {
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'settings-scroll-native-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (!importer?.split('?')[0].replaceAll('\\', '/').endsWith('/SettingsPage.vue'))
              return null
            const section = source.match(/\/([A-Za-z]+)SettingsSection\.vue$/)?.[1]
            if (section && sectionKeys[section]) return `\0settings-section:${sectionKeys[section]}`
            const store = source.match(
              /\/(useSettingsStore|useMusicStore|useThemeStore|useAudioOutputDspStore|registry)$/
            )?.[1]
            return store ? `\0settings-store:${store}` : null
          },
          load(id) {
            if (id.startsWith('\0settings-section:')) {
              const key = id.split(':')[1]
              return `export default {inheritAttrs:false,setup(){return window.makeSettingsSection('${key}')}}`
            }
            if (id.startsWith('\0settings-store:')) {
              const key = id.split(':')[1]
              const name = key === 'registry' ? 'useExtensionRegistry' : key
              return `export const ${name}=()=>window.settingsScrollMocks.${key}`
            }
            return null
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
          entry: fileURLToPath(new URL('./settingsScroll.fixture.mjs', import.meta.url)),
          name: 'SettingsScrollTests',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}.settings-preview-page{scroll-behavior:auto}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
 ipcMain.handle('settings:resize',async(_event,width)=>{win.setSize(width,900);await new Promise(resolve=>setTimeout(resolve,80))});
 try {
  await win.loadFile(require('node:path').join(__dirname,'index.html'));
  await win.webContents.executeJavaScript("window.resizeTestWindow=width=>require('electron').ipcRenderer.invoke('settings:resize',width);void 0");
  console.log(await win.webContents.executeJavaScript('window.runSettingsScrollTests()'));
  app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      windowsHide: true,
      timeout: 60_000,
      env
    })
    assert.match(result.stdout, /SETTINGS_SCROLL_OK/)
    console.log(result.stdout.trim())
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    assert.ok(directory.includes('twilight-settings-scroll-'))
    await rm(directory, { recursive: true, force: true })
  }
})
