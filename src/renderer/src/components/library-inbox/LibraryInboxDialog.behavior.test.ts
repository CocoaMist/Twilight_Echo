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

test('inbox pages, marks decisions and refreshes duplicate findings through Core', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-inbox-ui-'))
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
          name: 'InboxTest',
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
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runInboxTests()');if(process.env.TWILIGHT_INBOX_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_INBOX_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('INBOX_UI_OK');win.destroy();setTimeout(()=>process.exit(0),0)}catch(error){console.error(error.stack);win.destroy();setTimeout(()=>process.exit(1),0)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /INBOX_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick,ref} from 'vue'
import Dialog from '@renderer/components/library-inbox/LibraryInboxDialog.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,30));await nextTick()}
const button=text=>[...document.querySelectorAll('button')].find(el=>(el.textContent.trim()||'').startsWith(text)&&el.getClientRects().length)
const click=async text=>{const el=button(text);expect(el&&!el.disabled,'button unavailable: '+text);el.click();await tick()}
const setValue=async(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));await tick()}
window.runInboxTests=async()=>{
  const open=ref(true),decisions=new Map(),commands=[],queries=[]
  let duplicateCount=0,scanCount=0,scanFails=false,inboxMode=false,inboxRevision=1
  const track=id=>({id,title:'曲目 '+id,artist:'Artist',album:'Album',source:'local',duration:180,size:100})
  const state=()=>({id:'inbox',libraryRevision:1,revision:inboxRevision,total:10000,counts:{pending:{cover:0,tags:9999,enrichment:0,duplicate:inboxMode?10000:0},ignored:{cover:0,tags:0,enrichment:0,duplicate:0},done:{cover:0,tags:0,enrichment:0,duplicate:0}}})
  const coreState={protocolVersion:1,epoch:'fixture',sequence:0,phase:'ready',libraryRevision:1,playback:null,track:null,queue:null,error:null}
  window.api={core:{
    connect:async()=>({ok:true,value:{connectionId:'fixture',snapshot:coreState}}),disconnect:async()=>({ok:true,value:undefined}),cancel:async()=>({ok:true,value:undefined}),onMessage:()=>()=>{},onStatus:()=>()=>{},
    request:async(_id,request)=>{
      const p=request.payload;queries.push(request.name)
      if(request.kind==='command')commands.push(request)
      if(request.name==='library.inbox.refresh'){inboxMode=!!p.duplicatesId;return {ok:true,value:state()}}
      if(request.name==='library.inbox.page'){
        const all=Array.from({length:inboxMode?10000:10000},(_,i)=>({index:i,kind:inboxMode?'duplicate':i===0?'cover':'tags',status:decisions.get(i)||'pending',reason:'fixture',track:track(String(i))}))
        const filtered=all.filter(x=>(!p.status||x.status===p.status)&&(!p.kind||x.kind===p.kind));const offset=p.offset||0
        return {ok:true,value:{state:state(),offset,total:filtered.length,items:filtered.slice(offset,offset+(p.limit||50))}}
      }
      if(request.name==='library.inbox.mark'){for(const i of p.indexes)decisions.set(i,p.status);inboxRevision++;return {ok:true,value:state()}}
      if(request.name==='library.duplicates.start'){duplicateCount++;return {ok:true,value:{id:'dup',state:'completed',revision:1,candidates:10000,groups:3,unavailable:1}}}
      if(request.name==='library.duplicates.status')return {ok:true,value:{id:'dup',state:'completed',revision:1,candidates:10000,groups:3,unavailable:1}}
      return {ok:true,value:null}
    }
  }}
  document.getElementById('opener').focus()
  createApp({setup:()=>()=>open.value?h(Dialog,{tracks:[],scanning:false,rescan:async()=>{scanCount++;if(scanFails)throw new Error('fixture scan failure')},onClose:()=>open.value=false}):null}).mount('#app')
  await tick()
  expect(duplicateCount===0&&scanCount===0,'opening must only attach to existing Core data')
  expect(document.querySelectorAll('.inbox-row').length===50,'Core page bounds rendered rows')
  expect(document.querySelector('.inbox-row').textContent.includes('曲目 0'),'first Core row')
  document.querySelector('.inbox-list').scrollTop=300
  await click('下一页')
  expect(document.querySelector('.inbox-list').scrollTop===0,'page resets scroll')
  expect(document.querySelector('.inbox-row').textContent.includes('曲目 50'),'Core page changes')
  await click('上一页')
  document.querySelector('.inbox-row input').click();await tick();await click('忽略')
  await setValue(document.querySelectorAll('.inbox-controls select')[1],'ignored')
  expect(document.querySelectorAll('.inbox-row').length===1,'Core decision filters ignored issues')
  expect(commands.some(x=>x.name==='library.inbox.mark'&&x.payload.status==='ignored'),'decision is persisted by Core')
  await setValue(document.querySelectorAll('.inbox-controls select')[1],'pending')
  await click('选择本页');await click('下一页');await click('选择本页');await click('下一页');await click('选择本页')
  expect(document.querySelectorAll('.inbox-controls')[1].textContent.includes('150 首已选'),'selection remains across Core pages')
  await click('标记已处理')
  const chunks=commands.filter(x=>x.name==='library.inbox.mark'&&x.payload.status==='done').map(x=>x.payload.indexes.length)
  expect(chunks.join(',')==='128,22','Core mark limit is respected across revisions')
  await setValue(document.querySelectorAll('.inbox-controls select')[0],'duplicate')
  expect(document.querySelectorAll('.inbox-row').length===0,'duplicate results wait for inspection')
  await setValue(document.querySelectorAll('.inbox-controls select')[1],'pending')
  await click('检查疑似重复')
  expect(duplicateCount===1&&commands.some(x=>x.name==='library.inbox.refresh'&&x.payload.duplicatesId==='dup'),'duplicate results are refreshed through Core')
  expect(document.querySelectorAll('.inbox-row').length===50,'duplicate issues are paged by Core')
  expect(document.querySelector('[role="status"]').textContent.includes('无法读取'),'unavailable hash feedback')
  scanFails=true;await click('全库后台重扫');expect(document.querySelector('[role=alert]').textContent.includes('fixture scan failure'),'scan failure feedback')
  scanFails=false;await click('全库后台重扫');expect(scanCount===2,'explicit scan retry')
  expect(!queries.some(name=>name.startsWith('library.')&&!['library.inbox.refresh','library.inbox.page','library.inbox.mark','library.duplicates.start','library.duplicates.status'].includes(name)),'inbox uses bounded Core contracts')
}
`
