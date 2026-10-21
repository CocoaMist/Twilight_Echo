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

const require=createRequire(import.meta.url),workspace=fileURLToPath(new URL('../../../../',import.meta.url))
test('external playlist preview and gray-row playback behavior run in Electron',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'twilight-external-playlist-'))
  try{
    await build({
      configFile:false,root:workspace,logLevel:'error',
      plugins:[{
        name:'external-playlist-test-boundaries',enforce:'pre',
        resolveId(source,importer){
          const path=importer?.replaceAll('\\','/').split('?')[0]||''
          if(path.endsWith('/ExternalPlaylistImportDialog.vue')&&source==='../stores/useMusicStore')return '\0import-music-store'
          if((path.endsWith('/PlaylistLibraryPage.vue')||path.endsWith('/CreateAggregatePlaylistDialog.vue'))&&source==='../../stores/useMusicStore')return '\0import-music-store'
          if(path.endsWith('/externalPlaylistReader.ts')&&source==='@renderer/providers/index.ts')return '\0test-providers'
          if(path.endsWith('/ImportedPlaylistDetail.vue')){
            if(source==='../stores/useMusicStore')return '\0import-music-store'
            if(source==='../stores/usePlayerStore')return '\0import-player-store'
            if(source==='../stores/library/libraryPlaylistView.ts')return '\0test-playlist-view'
            if(source==='../stores/library/externalPlaylistService.ts')return '\0test-playlist-service'
            if(source==='../providers/index.ts')return '\0test-providers'
          }
          return null
        },
        load(id){
          if(id==='\0import-music-store')return 'export const useMusicStore=()=>window.auditMusic'
          if(id==='\0import-player-store')return 'export const usePlayerStore=()=>window.auditPlayer'
          if(id==='\0test-providers')return 'export const useMediaProviders=()=>window.auditProviderRegistry;export const syncPluginProviders=async()=>{}'
          if(id==='\0test-playlist-view')return "import {shallowRef} from 'vue';export function createLibraryPlaylistView(){return {state:shallowRef({id:'view',pending:false,error:''}),setPlaylist:async()=>{},retry:async()=>{},dispose:async()=>{}}}"
          if(id==='\0test-playlist-service')return 'export const externalMatchProgress={value:{}};export const getExternalPlaylistService=()=>window.auditService'
          return null
        }
      },vue()],
      resolve:{alias:{'@renderer':join(workspace,'src/renderer/src'),vue:require.resolve('vue/dist/vue.esm-bundler.js')}},
      define:{'process.env.NODE_ENV':'"production"'},
      build:{outDir:join(directory,'bundle'),emptyOutDir:true,minify:false,lib:{entry:fileURLToPath(new URL('./externalPlaylistImport.fixture.mjs',import.meta.url)),name:'ExternalPlaylistTests',formats:['iife'],fileName:'runtime'}}
    })
    const files=await readdir(join(directory,'bundle'))
    await writeFile(join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8">${files.filter(file=>file.endsWith('.css')).map(file=>`<link rel="stylesheet" href="bundle/${file}">`).join('')}<style>body{margin:0;background:#f4f5f8;font-family:Inter,system-ui}.external-import-overlay,.match-overlay{animation:none!important;transition:none!important}</style></head><body><div id="app"></div><script src="bundle/${files.find(file=>file.endsWith('.js'))}"></script></body></html>`)
    await writeFile(join(directory,'runner.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:920,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));const screenshots=process.env.TWILIGHT_EXTERNAL_PLAYLIST_SCREENSHOT;const capture=async name=>console.log('EXTERNAL_PLAYLIST_SCREENSHOT '+name+' '+(await win.webContents.capturePage()).toPNG().toString('base64'));const running=win.webContents.executeJavaScript('window.runExternalPlaylistImportTests(Boolean('+JSON.stringify(Boolean(process.env.TWILIGHT_EXTERNAL_PLAYLIST_SCREENSHOT))+'))');if(screenshots){const waiting=win.webContents.executeJavaScript("new Promise(resolve=>{if(window.__externalPlaylistPhase==='preview')resolve();else window.addEventListener('external-playlist-phase',event=>event.detail==='preview'&&resolve(),{once:true})})");await Promise.race([waiting,running.then(()=>{throw new Error('tests ended before preview capture')})]);await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await capture('preview');await win.webContents.executeJavaScript('window.__resumeAfterImportPreview()')}const result=await running;if(screenshots){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await capture('detail')}console.log('EXTERNAL_PLAYLIST_UI_OK '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`)
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    let result
    try{result=await promisify(execFile)(require('electron'),['--no-sandbox','--enable-logging=stderr',join(directory,'runner.cjs'),join(directory,'index.html')],{windowsHide:true,timeout:60_000,env})}
    catch(error){if(error&&typeof error==='object'){const hideImages=value=>typeof value==='string'?value.replace(/^EXTERNAL_PLAYLIST_SCREENSHOT (?:preview|detail) [^\r\n]+$/gm,'EXTERNAL_PLAYLIST_SCREENSHOT [omitted]'):value;error.stdout=hideImages(error.stdout);error.message=hideImages(error.message);if(error.stack)error.stack=hideImages(error.stack)}throw error}
    assert.match(result.stdout,/EXTERNAL_PLAYLIST_UI_OK/)
    if(env.TWILIGHT_EXTERNAL_PLAYLIST_SCREENSHOT){const captures=[...result.stdout.matchAll(/^EXTERNAL_PLAYLIST_SCREENSHOT (preview|detail) ([A-Za-z0-9+/=]+)$/gm)];assert.equal(captures.length,2,'Electron should capture both the preview and imported song list');for(const capture of captures)await writeFile(env.TWILIGHT_EXTERNAL_PLAYLIST_SCREENSHOT.replace(/\.png$/,`-${capture[1]}.png`),Buffer.from(capture[2],'base64'))}
    console.log(result.stdout.match(/^EXTERNAL_PLAYLIST_UI_OK .*$/m)?.[0])
  }finally{const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep));await rm(target,{recursive:true,force:true})}
})
