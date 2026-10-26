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

test(
  'background revisions keep the rendered album header, introduction, tint and scroll position stable',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-album-refresh-'))
    try {
      await writeFile(join(directory, 'entry.mjs'), runtime)
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'background-core-fixture',
            enforce: 'pre',
            resolveId(source) {
              if (/\/stores\/coreConnection(?:\.ts)?$/.test(source)) return '\0fixture-core'
              if (/\/stores\/useSettingsStore(?:\.ts)?$/.test(source)) return '\0fixture-settings'
              return null
            },
            load(id) {
              if (id === '\0fixture-core')
                return 'export const useCoreConnection = () => window.backgroundCore'
              if (id === '\0fixture-settings')
                return 'export const useSettingsStore = () => window.backgroundSettings'
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
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          minify: false,
          lib: {
            entry: join(directory, 'entry.mjs'),
            name: 'BackgroundRefreshTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8">${files
          .filter((f) => f.endsWith('.css'))
          .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
          .join(
            ''
          )}<style>body{margin:0;font-family:'Microsoft YaHei',system-ui}#app{height:100vh}.fixture-page{height:100%;overflow:auto;padding:24px 32px;box-sizing:border-box;background:var(--te-app-bg)}.track-marker{height:800px;border-top:1px solid #ddd;padding-top:24px}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const args = [
        ...(process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
        join(directory, 'runner.cjs'),
        directory
      ]
      const result = await promisify(execFile)(require('electron'), args, {
        windowsHide: true,
        timeout: 50_000,
        env,
        maxBuffer: 1024 * 1024
      })
      assert.match(result.stdout, /ALBUM_BACKGROUND_REFRESH_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runtime = `
import {createApp,h,ref,shallowRef,watch,nextTick} from 'vue'
import AlbumDetailHeader from '@renderer/components/song-list/AlbumDetailHeader.vue'
import EntityMetadataPanel from '@renderer/components/music-metadata/EntityMetadataPanel.vue'
import {createLibraryCollectionPages} from '@renderer/stores/library/libraryCollectionPages.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const expect=(ok,message)=>{if(!ok)throw Error(message)}
const errors=[]
const canvas=document.createElement('canvas');canvas.width=canvas.height=320
const paint=canvas.getContext('2d');paint.fillStyle='#4caa90';paint.fillRect(0,0,320,320)
paint.strokeStyle='#c9efdd';paint.lineWidth=4
for(let i=0;i<9;i++){paint.beginPath();paint.arc(160,160,24+i*17,0,Math.PI*2);paint.stroke()}
const cover=canvas.toDataURL()
const album={id:'album-a',name:'[BOF21] 般舟 · Pratyutpanna',artist:'ZAWA',trackCount:1,duration:180,cover}
const target={kind:'release',sourceProvider:'local',context:{type:'collection',collection:'albums',id:album.id}}
const summary={name:album.name,artist:album.artist,trackCount:1,durationText:'3 分钟',formatText:'FLAC · 48 kHz · 24 bit',typeText:'单曲 / EP'}
let revision=1,delay=0,commands=0
const entity={id:'release-a',kind:'release',title:album.name,artist:album.artist,identity:'source',sourceCount:1}
const introduction='这是一段已经显示的专辑介绍。后台持续核对身份与补全资料时，页面应保持当前位置，封面、文字和操作区不应消失或跳动。'
window.api={}
window.backgroundSettings={settings:ref({musicIdentification:{language:'zh-Hans'}})}
const state=shallowRef({epoch:'fixture',libraryRevision:1,catalogRevision:1,entityMetadataRevision:1,settingsRevision:1})
window.backgroundCore={state,query:async(name,payload,signal)=>{
  const captured=revision
  if(delay)await pause(delay)
  signal?.throwIfAborted()
  if(name==='catalog.query')return {revision:captured,offset:0,total:1,items:[{...entity}]}
  if(name==='catalog.sources')return {revision:captured,offset:0,total:0,items:[]}
  if(name==='metadata.entity.detail')return {entityId:entity.id,targetId:null,link:null,revision:0,name:album.name,introduction:{value:introduction,language:'zh-Hans',origin:'manual',attribution:null},override:null,facts:[]}
  if(name==='identification.detail')return {entityId:entity.id,kind:'release',link:null,references:[]}
  if(name==='identification.candidates')return {revision:0,offset:0,total:0,items:[]}
  if(name==='albums.browse')return {token:{expiresAt:null},project:null,projectCount:0,currentRelease:null,offset:0,total:0,items:[],externalCatalog:'unavailable'}
  throw Error('Unexpected query '+name)
},command:async()=>{commands++;throw Error('Unexpected write')}}
const pages=createLibraryCollectionPages({queryCollections:async()=>{
  const captured=revision
  if(delay)await pause(delay)
  return {revision:captured,offset:0,total:1,items:[{...album}]}
}},1)
pages.setQuery('albums',{albumId:album.id})
watch(()=>state.value.libraryRevision,r=>pages.invalidate(r))
const app=createApp({setup:()=>()=>h('main',{class:'fixture-page'},[
  pages.state.value.page?.items[0]?h(AlbumDetailHeader,{album:pages.state.value.page.items[0],durationText:'3 分钟',canPlay:true,formatText:summary.formatText,typeText:summary.typeText,showOverview:false}):null,
  h(EntityMetadataPanel,{target,albumSummary:summary}),
  h('div',{class:'track-marker'},'01  般舟 · Pratyutpanna    ZAWA    3:00')
])})
app.config.errorHandler=e=>errors.push(String(e));app.mount('#app')
window.backgroundReady=async()=>{
  for(let i=0;i<100;i++){
    if(document.querySelector('.metadata-introduction')?.textContent===introduction&&document.querySelector('.album-detail-header')?.style.getPropertyValue('--album-tint'))return true
    await pause(30)
  }
  throw Error('Page did not settle: '+errors.join(';')+'; '+document.body.innerText)
}
window.backgroundTest=async()=>{
  await window.backgroundReady();await pause(100)
  const header=document.querySelector('.album-detail-header'),intro=document.querySelector('.metadata-introduction'),page=document.querySelector('.fixture-page'),marker=document.querySelector('.track-marker')
  page.scrollTop=110
  const top=marker.getBoundingClientRect().top,scroll=page.scrollTop,tint=header.style.getPropertyValue('--album-tint')
  let samples=0,maxShift=0,stopped=false,frame
  const sample=()=>{
    try{
      expect(header.isConnected&&document.querySelector('.album-detail-header')===header,'album header remounted')
      expect(intro.isConnected&&intro.textContent===introduction,'introduction removed during background read')
      expect(header.style.getPropertyValue('--album-tint')===tint,'artwork tint flashed')
      expect(page.scrollTop===scroll,'scroll position jumped')
      maxShift=Math.max(maxShift,Math.abs(marker.getBoundingClientRect().top-top))
      expect(maxShift<1,'content shifted by '+maxShift+'px')
      samples++
    }catch(e){errors.push(String(e));stopped=true}
    if(!stopped)frame=requestAnimationFrame(sample)
  }
  frame=requestAnimationFrame(sample)
  delay=75
  for(let i=0;i<6;i++){
    revision++;state.value={...state.value,libraryRevision:revision,catalogRevision:revision,entityMetadataRevision:revision}
    await pause(340)
  }
  stopped=true;cancelAnimationFrame(frame)
  expect(errors.length===0,errors.join(';'))
  expect(samples>20,'insufficient rendered samples: '+samples)
  const edit=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='编辑介绍')
  edit.click();await nextTick()
  const textarea=document.querySelector('textarea');textarea.value='保留这段草稿';textarea.dispatchEvent(new Event('input',{bubbles:true}))
  state.value={...state.value,entityMetadataRevision:++revision};await nextTick()
  expect([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存介绍').disabled,'stale editor remained writable')
  await pause(160)
  expect(textarea.isConnected&&textarea.value==='保留这段草稿','background read discarded editor draft')
  expect(commands===0,'refresh triggered a business command')
  expect(errors.length===0,errors.join(';'))
  return {samples,maxShift,scroll,tint,commands}
}
`

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs')
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{backgroundThrottling:false,offscreen:true}})
 try{
  await win.loadFile(path.join(directory,'index.html'))
  await win.webContents.executeJavaScript('window.backgroundReady()')
  if(process.env.TWILIGHT_BACKGROUND_EVIDENCE_DIR){fs.mkdirSync(process.env.TWILIGHT_BACKGROUND_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_BACKGROUND_EVIDENCE_DIR,'album-before.png'),(await win.webContents.capturePage()).toPNG())}
  const result=await win.webContents.executeJavaScript('window.backgroundTest()')
  if(process.env.TWILIGHT_BACKGROUND_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.TWILIGHT_BACKGROUND_EVIDENCE_DIR,'album-after.png'),(await win.webContents.capturePage()).toPNG())
  console.log('ALBUM_BACKGROUND_REFRESH_OK',JSON.stringify(result));app.exit(0)
 }catch(e){console.error(e.stack);app.exit(1)}
})
`
