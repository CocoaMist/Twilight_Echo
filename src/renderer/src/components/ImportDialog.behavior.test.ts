import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('first import defers folder registration and saves the chosen metadata scope before scanning', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-first-import-'))
  try {
    await writeFile(join(directory, 'entry.mjs'), runtime)
    const { build } = await import('vite')
    await build({ configFile: false, root: workspace, logLevel: 'error', plugins: [{
      name: 'first-import-boundary', enforce: 'pre',
      resolveId(source) {
        if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0import-core'
        if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0import-settings'
        if (/(?:^|\/)useMusicStore(?:\.ts)?$/.test(source)) return '\0import-music'
        return null
      },
      load(id) {
        if (id === '\0import-core') return 'export const useCoreConnection=()=>window.importCore'
        if (id === '\0import-settings') return 'export const useSettingsStore=()=>window.importSettings'
        if (id === '\0import-music') return 'export const useMusicStore=()=>window.importMusic'
        return null
      }
    }, vue()], resolve: { alias: {
      '@renderer': join(workspace, 'src/renderer/src'), vue: require.resolve('vue/dist/vue.esm-bundler.js')
    } }, define: { 'process.env.NODE_ENV': '"production"' }, build: {
      outDir: join(directory, 'bundle'), minify: false,
      lib: { entry: join(directory, 'entry.mjs'), name: 'ImportTest', formats: ['iife'], fileName: 'runtime' }
    } })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script src="bundle/${files.find(f => f.endsWith('.js'))}"></script></body></html>`)
    await writeFile(join(directory, 'runner.cjs'), `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,backgroundThrottling:false}});try{await w.loadFile(path.join(__dirname,'index.html'));await w.webContents.executeJavaScript('window.runImportTests()');console.log('FIRST_IMPORT_OK');app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}})`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [
      ...(process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []), join(directory, 'runner.cjs')
    ], { windowsHide: true, env, timeout: 45_000, maxBuffer: 1024 * 1024 })
    assert.match(result.stdout, /FIRST_IMPORT_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,ref,shallowRef,nextTick} from 'vue'
import ImportDialog from '@renderer/components/ImportDialog.vue'
const calls=[],settings=ref({libraryFolders:[],musicIdentification:{newImports:false,history:false,sources:['musicbrainz'],language:'zh-Hans'}})
let scanFail=false,picker=null
window.api={dialog:{openFolder:async options=>{calls.push(['picker',options]);return picker}}}
window.importSettings={settings,loaded:ref(true),removeLibraryFolder:async()=>{},updateSettings:async patch=>{calls.push(['settings',structuredClone(patch)]);settings.value={...settings.value,...patch}}}
window.importCore={state:shallowRef({epoch:'first-import'}),query:async(name)=>{
 if(name!=='metadata.entity.policy')throw Error(name)
 return {enabled:true,identity:true,introduction:true,reason:null,sources:[
  {provider:'platform.ncm',identification:[{kind:'artist',reason:null}],enrichment:[]},
  {provider:'discogs',identification:[{kind:'artist',reason:'discogs_token_required'}],enrichment:[]}
 ]}
}}
window.importMusic={libraryScanStatus:ref({state:'idle'}),scanLibraryDirectories:async request=>{calls.push(['scan',request]);if(scanFail)throw Error('test scan failure')}}
const show=ref(true);createApp({render:()=>h(ImportDialog,{show:show.value})}).mount('#app')
const settle=async()=>{await nextTick();await new Promise(r=>setTimeout(r,30));await nextTick()}
const expect=(ok,m)=>{if(!ok)throw Error(m)}
const click=async label=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);expect(b&&!b.disabled,'unavailable '+label);b.click();await settle()}
window.runImportTests=async()=>{
 await settle();expect(calls.length===0,'opening the dialog started import')
 expect(document.body.textContent.includes('网易云音乐'),'available source missing')
 picker='D:/Music';await click('添加文件夹')
 expect(calls.length===1&&calls[0][1].deferImport===true,'picker did not defer registration')
 expect(settings.value.libraryFolders.length===0,'selecting a folder started a watcher')
 expect(!settings.value.musicIdentification.newImports,'selection silently opted in')
 const checkbox=document.querySelector('.import-metadata input');checkbox.click();await settle()
 calls.length=0;await click('检查并导入所选文件夹')
 expect(calls.map(c=>c[0]).join(',')==='settings,scan,settings','metadata/scan/watch ordering changed')
 expect(calls[0][1].musicIdentification.newImports===true,'chosen scope not saved')
 expect(calls[0][1].musicIdentification.history===false,'new import enabled historical backfill')
 expect(calls[0][1].musicIdentification.sources.includes('platform.ncm')&&!calls[0][1].musicIdentification.sources.includes('discogs'),'unavailable source enabled')
 expect(calls[1][1].directories[0]==='D:/Music'&&calls[1][1].reason==='import','scan did not use chosen root')
 expect(settings.value.libraryFolders[0]==='D:/Music','accepted import not watched')
 show.value=false;await settle();show.value=true;await settle()
 picker='D:/Other';await click('添加文件夹');scanFail=true;calls.length=0
 await click('检查并导入所选文件夹')
 expect(calls.map(c=>c[0]).join(',')==='settings,scan','failed scan registered a new root')
 expect(document.querySelector('[role=alert]')?.textContent.includes('test scan failure'),'failure missing')
 expect(!settings.value.libraryFolders.includes('D:/Other'),'failed import changed watched roots')
}
`
