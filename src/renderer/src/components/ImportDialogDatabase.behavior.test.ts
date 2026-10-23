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

test('import dialog operates Core scope/pause/cancel/continue and settings readiness in sandboxed Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-database-import-'))
  try {
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'import-store-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (!importer?.replaceAll('\\', '/').split('?')[0].endsWith('/ImportDialog.vue'))
              return null
            if (source === '../stores/useMusicStore') return '\0import-music-store'
            if (source === '../stores/useSettingsStore') return '\0import-settings-store'
            return null
          },
          load(id) {
            if (id === '\0import-music-store')
              return 'export const useMusicStore=()=>window.auditMusic'
            if (id === '\0import-settings-store')
              return 'export const useSettingsStore=()=>window.auditSettings'
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
          entry: fileURLToPath(new URL('./importDialogDatabase.fixture.mjs', import.meta.url)),
          name: 'ImportDatabaseTests',
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
        )}<style>body{margin:0;font-family:system-ui;background:#ebeef4}.modal-overlay,.import-dialog{animation:none!important;transition:none!important}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:760,height:720,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));const result=await win.webContents.executeJavaScript('window.runImportDatabaseTests()');if(process.env.TWILIGHT_IMPORT_SCREENSHOT)fs.writeFileSync(process.env.TWILIGHT_IMPORT_SCREENSHOT,(await win.webContents.capturePage()).toPNG());console.log('DATABASE_IMPORT_UI_OK '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--enable-logging=stderr', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env }
    )
    assert.match(result.stdout, /DATABASE_IMPORT_UI_OK/)
    console.log(result.stdout.trim())
  } finally {
    const target = resolve(directory)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep))
    await rm(target, { recursive: true, force: true })
  }
})
