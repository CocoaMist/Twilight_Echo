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

test('simplified library dialog keeps optional work folded and exercises completion, review, retry and file controls through Core', async () => {
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
          'primeicons/primeicons.css': require.resolve('primeicons/primeicons.css'),
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
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
  const run=code=>win.webContents.executeJavaScript(code);
  const shot=async name=>{await run('new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),180))');fs.writeFileSync(path.join(process.env.TWILIGHT_INBOX_EVIDENCE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
  try{
    await win.loadFile(process.argv.at(-1));await run('window.runInboxTests()');
    if(process.env.TWILIGHT_INBOX_SCREENSHOT)fs.writeFileSync(process.env.TWILIGHT_INBOX_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    if(process.env.TWILIGHT_INBOX_EVIDENCE){
      fs.mkdirSync(process.env.TWILIGHT_INBOX_EVIDENCE,{recursive:true});
      await shot('files');
      await run('window.showInboxStage("default")');await shot('default-light');
      await run('window.showInboxStage("records")');await shot('records-light');
      await run('window.showInboxStage("candidate")');await shot('candidate-light');
      await run('window.showInboxStage("default").then(()=>document.documentElement.setAttribute("data-theme","dark"))');
      win.setSize(430,780);await run('new Promise(r=>setTimeout(r,100))');
      await run('window.assertInboxFits()');await shot('narrow-dark');
      await run('window.showInboxStage("candidate").then(()=>window.assertInboxFits())');await shot('narrow-candidate-dark');
      await run('window.showInboxStage("empty")');await shot('empty-dark');
    }
    console.log('INBOX_UI_OK');win.destroy();setTimeout(()=>process.exit(0),0)
  }catch(error){console.error(error.stack);win.destroy();setTimeout(()=>process.exit(1),0)}
})`
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
import 'primeicons/primeicons.css'
import {createApp,h,nextTick,ref} from 'vue'
import Dialog from '@renderer/components/library-inbox/LibraryInboxDialog.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,30));await nextTick()}
const button=text=>[...document.querySelectorAll('button')].find(el=>(el.textContent.trim()||'').startsWith(text)&&el.getClientRects().length)
const click=async text=>{const el=button(text);expect(el&&!el.disabled,'button unavailable: '+text);el.click();await tick()}
const setValue=async(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));await tick()}
const disclose=async selector=>{document.querySelector(selector).open=true;await tick()}
window.runInboxTests=async()=>{
  const open=ref(true),decisions=new Map(),commands=[],queries=[],pageCalls=[],inboxCalls=[]
  let duplicateCount=0,scanCount=0,scanFails=false,inboxMode=false,inboxRevision=1,slowCover=false,pageFails=false
  const entity={id:'artist-a',kind:'artist',title:'陈奕迅',artist:''}
  let inboxItems=[{entity,candidateCount:2,sample:null},{entity:{id:'release-b',kind:'release',title:'Random Access Memories',artist:'Daft Punk'},candidateCount:3,sample:null}]
  const categories=['track_tags','track_cover','track_genre','artist_identity','artist_name','artist_image','artist_intro','album_identity','album_intro','release_identity']
  const health=()=>({phase:'ready',inspected:10000,error:'',repair:null,report:{id:'health',checkedAt:1720000000000,libraryRevision:1,catalogRevision:1,metadataRevision:1,language:'zh-Hans',totals:{tracks:10000,artists:780,albums:1450,releases:1500},metrics:Object.fromEntries(categories.map(key=>[key,{total:1000,present:750,missing:200,hidden:50,repairable:100}])),states:{ready:100,processing:0,review:2,unavailable:100,blocked:0,failed:0,manual:200},policy:{enabled:true,identity:true,introduction:true,reason:null}}})
  const task={id:'failed-source',type:'identify',provider:'musicbrainz',language:'zh-Hans',state:'failed',generation:1,attempts:1,nextAttemptAt:0,outcome:null,reason:'metadata_http_503',updatedAt:1720000000000,title:'宇多田ヒカル',kind:'artist',entity:{...entity,id:'failed-artist',title:'宇多田ヒカル'},demandCount:1}
  const tasks=()=>({offset:0,total:2,counts:{queued:0,running:0,retry_wait:0,needs_review:0,blocked:0,failed:1,completed:1,cancelled:0},items:[task,{...task,id:'not-found',state:'completed',outcome:'not_found',reason:null,title:'无名专辑'}]})
  const track=id=>({id,title:'曲目 '+id,artist:'Artist',album:'Album',source:'local',duration:180,size:100})
  const state=()=>({id:'inbox',libraryRevision:1,revision:inboxRevision,total:10000,counts:{pending:{cover:0,tags:9999,enrichment:0,duplicate:inboxMode?10000:0},ignored:{cover:0,tags:0,enrichment:0,duplicate:0},done:{cover:0,tags:0,enrichment:0,duplicate:0}}})
  const coreState={protocolVersion:1,epoch:'fixture',sequence:0,phase:'ready',libraryRevision:1,playback:null,track:null,queue:null,error:null}
  window.api={core:{
    connect:async()=>({ok:true,value:{connectionId:'fixture',snapshot:coreState}}),disconnect:async()=>({ok:true,value:undefined}),cancel:async()=>({ok:true,value:undefined}),onMessage:()=>()=>{},onStatus:()=>()=>{},
    request:async(_id,request)=>{
      const p=request.payload;queries.push(request.name)
      if(request.kind==='command')commands.push(request)
      if(request.name==='library.health.status'||request.name==='library.health.start'||request.name==='library.health.repair')return {ok:true,value:health()}
      if(request.name==='library.health.page')return {ok:true,value:{id:'health',offset:p.offset||0,total:0,items:[]}}
      if(request.name==='identification.inbox'){inboxCalls.push(p);return {ok:true,value:{offset:0,total:inboxItems.length,items:inboxItems}}}
      if(request.name==='identification.detail')return {ok:true,value:{entityId:p.entityId,kind:'artist',link:null,references:[]}}
      if(request.name==='identification.candidates')return {ok:true,value:{total:2,items:['1','2'].map((id,i)=>({id,entityId:p.entityId,kind:'artist',name:i?'Eason Chan':'陈奕迅',provider:'musicbrainz',summary:i?'另一份同名候选，请结合曲目核对。':'香港流行音乐歌手，候选依据已保存。',references:[],state:'candidate',revision:1,linkRevision:0,inputVersion:'fixture',evidence:{origin:'search',matches:['name'],missing:['cross_reference'],conflicts:[],incomplete:true,provenance:'fixture'}}))}}
      if(request.name==='identification.history')return {ok:true,value:{total:0,offset:0,items:[]}}
      if(request.name==='metadata.entity.tasks')return {ok:true,value:tasks()}
      if(request.name==='identification.start')return {ok:true,value:{batchId:p.batchId,jobs:[]}}
      if(request.name==='library.inbox.refresh'){inboxMode=!!p.duplicatesId;return {ok:true,value:state()}}
      if(request.name==='library.inbox.page'){
        pageCalls.push({...p})
        if(pageFails){pageFails=false;return {ok:false,error:{code:'INTERNAL',message:'fixture page failure'}}}
        if(slowCover&&p.kind==='cover'){slowCover=false;await new Promise(r=>setTimeout(r,100))}
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
  expect(duplicateCount===0&&scanCount===0&&commands.length===0,'opening must only read existing Core data')
  expect(!queries.includes('library.health.page')&&!queries.includes('metadata.entity.tasks'),'coverage and history are lazy')
  expect(document.querySelectorAll('.compact-entities>li').length===2,'decisions are entity rows, not provider tasks or missing fields: '+document.body.innerText+'; queries: '+queries.join(','))
  expect(inboxCalls[0].unresolvedOnly===true,'compact decisions are filtered before SQL pagination')
  expect(!document.querySelector('.coverage-content'),'coverage begins folded')
  await click('补充资料')
  expect(commands.filter(x=>x.name==='library.health.repair'&&x.payload.refresh===true).length===1,'one command owns fresh completion')
  await click('查看候选');expect(document.querySelector('[aria-label="身份与候选复核"]'),'candidate opens existing evidence controls');await click('收起候选')
  await disclose('.records-disclosure')
  expect(document.querySelector('.metadata-task-record').textContent.includes('查询未成功'),'failure is distinct from identity review')
  expect(!button('核对身份'),'failed network query does not invent a candidate review')
  await click('重新查询')
  expect(commands.some(x=>x.name==='identification.start'&&x.payload.entityId==='failed-artist'&&x.payload.batchId.startsWith('retry:')),'retry uses exact source with a new explicit demand')
  expect(!queries.includes('metadata.entity.demands'),'technical demand reads require explicit expansion')
  await disclose('.coverage-disclosure');expect(document.querySelectorAll('.metric').length===10,'coverage remains available on demand')
  await disclose('.tools-menu');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();expect(document.querySelector('.inbox-dialog')&&!document.querySelector('.tools-menu').open,'Escape closes more tools before the dialog')
  await disclose('.tools-menu');await click('音乐资料复核');expect(document.querySelector('.identity-inbox-controls'),'advanced review remains available');expect(!inboxCalls.at(-1).unresolvedOnly,'advanced review retains original query semantics')
  await click('文件问题')
  expect(document.querySelectorAll('.inbox-row').length===0,'optional missing covers and tags are excluded by default')
  expect(!document.querySelector('.files-evidence-column'),'file evidence requires explicit inspection')
  await disclose('.optional-files')
  expect(document.querySelectorAll('.inbox-row').length===50,'Core page bounds rendered rows')
  expect(document.querySelector('.inbox-row').textContent.includes('曲目 0'),'first Core row')
  slowCover=true;await setValue(document.querySelector('.filter-block select'),'cover');await setValue(document.querySelector('.filter-block select'),'tags');await new Promise(r=>setTimeout(r,120));await tick()
  expect(document.querySelectorAll('.inbox-row').length===50&&!document.querySelector('.inbox-row').textContent.includes('曲目 0'),'late response cannot replace current filter')
  pageFails=true;await setValue(document.querySelector('.filter-block select'),'cover');expect(document.querySelector('[role=alert]'),'page read errors have recovery');document.querySelector('.alert-note button').click();await tick();expect(document.querySelectorAll('.inbox-row').length===1,'explicit retry recovers file page; calls:'+JSON.stringify(pageCalls)+' error:'+document.querySelector('[role=alert]')?.textContent)
  await setValue(document.querySelector('.filter-block select'),'')
  document.querySelector('.inbox-list').scrollTop=300
  await click('下一页')
  expect(document.querySelector('.inbox-list').scrollTop===0,'page resets scroll')
  expect(document.querySelector('.inbox-row').textContent.includes('曲目 50'),'Core page changes')
  await click('上一页')
  document.querySelector('.inbox-row input').click();await tick();await click('忽略')
  await setValue(document.querySelectorAll('.filter-block select')[1],'ignored')
  expect(document.querySelectorAll('.inbox-row').length===1,'Core decision filters ignored issues')
  expect(commands.some(x=>x.name==='library.inbox.mark'&&x.payload.status==='ignored'),'decision is persisted by Core')
  await setValue(document.querySelectorAll('.filter-block select')[1],'pending')
  await click('选择本页');await click('下一页');await click('选择本页');await click('下一页');await click('选择本页')
  expect(document.querySelector('.batch-bar').textContent.includes('150 首已选'),'selection remains across Core pages')
  await click('标记已处理')
  const chunks=commands.filter(x=>x.name==='library.inbox.mark'&&x.payload.status==='done').map(x=>x.payload.indexes.length)
  expect(chunks.join(',')==='128,22','Core mark limit is respected across revisions')
  await setValue(document.querySelectorAll('.filter-block select')[0],'duplicate')
  expect(document.querySelectorAll('.inbox-row').length===0,'duplicate results wait for inspection')
  await setValue(document.querySelectorAll('.filter-block select')[1],'pending')
  await click('检查疑似重复')
  expect(duplicateCount===1&&commands.some(x=>x.name==='library.inbox.refresh'&&x.payload.duplicatesId==='dup'),'duplicate results are refreshed through Core')
  expect(document.querySelectorAll('.inbox-row').length===50,'duplicate issues are paged by Core')
  expect(document.querySelector('[role="status"]').textContent.includes('无法读取'),'unavailable hash feedback')
  scanFails=true;await click('全库后台重扫');expect(document.querySelector('[role=alert]').textContent.includes('fixture scan failure'),'scan failure feedback')
  scanFails=false;await click('全库后台重扫');expect(scanCount===2,'explicit scan retry')
  await click('需要你决定');await click('文件问题');expect(document.querySelector('.optional-files').open&&document.querySelector('.filter-block select').value==='duplicate','explicit optional disclosure and filter stay aligned across sections')
  expect(!queries.some(name=>name.startsWith('library.')&&!['library.health.status','library.health.start','library.health.repair','library.health.page','library.inbox.refresh','library.inbox.page','library.inbox.mark','library.duplicates.start','library.duplicates.status'].includes(name)),'inbox uses bounded Core contracts')
  window.showInboxStage=async stage=>{
    await click('文件问题');await click('需要你决定')
    if(stage==='records')await disclose('.records-disclosure')
    if(stage==='candidate'){await click('查看候选');expect(document.querySelector('[aria-label="身份与候选复核"]'),'candidate evidence is rendered before capture')}
    if(stage==='empty'){inboxItems=[];await click('文件问题');await click('需要你决定')}
    await tick()
  }
  window.assertInboxFits=()=>{const node=document.querySelector('.inbox-dialog'),panel=node.getBoundingClientRect();expect(panel.left>=0&&panel.right<=innerWidth&&panel.top>=0&&panel.bottom<=innerHeight,'dialog fits narrow viewport');expect(document.documentElement.scrollWidth<=innerWidth&&node.scrollWidth<=node.clientWidth+1,'no dialog horizontal overflow');const content=document.querySelector('.health-panel');expect(!content||content.scrollWidth<=content.clientWidth+1,'expanded review does not overflow its scroll pane')}
}
`
