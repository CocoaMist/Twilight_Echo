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

test('loudness dialog handles scope, progress, cancel, retry, stale queries and a bounded keyboard grid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-loudness-ui-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'coreConnection.ts'),
      'export const useCoreConnection = () => globalThis.__core\n'
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer/stores/coreConnection.ts': join(directory, 'coreConnection.ts'),
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
          name: 'LoudnessTest',
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
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">响度分析</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runLoudnessTests()');if(process.env.TWILIGHT_LOUDNESS_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_LOUDNESS_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('LOUDNESS_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /LOUDNESS_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import Dialog from '@renderer/components/library-loudness/LibraryLoudnessDialog.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=()=>new Promise(resolve=>setTimeout(resolve,20))
const until=async(predicate,message)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error(message);await pause()}await nextTick()}
const measured=lufs=>({source:'analyzed',available:true,algorithmVersion:2,integratedLufs:lufs,truePeakDb:-1,analyzedAt:'2026-09-14T00:00:00Z'})
window.runLoudnessTests=async()=>{
  const callbacks=new Set(),starts=[],clears=[]
  let plan=null,groups=[],cancelCount=0,failQuery=false,holdFirstResult=true,releaseOld
  const results=new Map()
  const status=(state='idle',jobId=null,total=0,processed=0,failed=0,currentTitle='')=>({revision:0,jobId,state,total,processed,failed,currentTitle})
  const publish=()=>{for(const callback of callbacks)callback({kind:'state',snapshot:{libraryLoudness:structuredClone(plan)}})}
  const makeGroups=(selection,mode)=>{
    const ids=selection.query.ids||[]
    if(mode==='album')return [{id:'album:release',title:'示例专辑',trackCount:2,state:'queued',tracks:[{},{}],mode}]
    return ids.map(id=>({id:'track:'+id,title:'曲目 '+id,trackCount:1,state:'queued',tracks:[{}],mode}))
  }
  const core={
    state:shallowRef({epoch:'test'}),attach:async()=>{},
    subscribe(callback){callbacks.add(callback);return()=>callbacks.delete(callback)},
    async command(name,input){
      if(name==='library.loudness.prepare'){
        groups=makeGroups(input.selection,input.mode)
        plan={id:'plan:'+input.mode+':'+groups.length+':'+Date.now(),libraryRevision:1,groups:groups.length,tracks:groups.reduce((sum,group)=>sum+group.trackCount,0),skipped:0,status:status(),items:groups.map(group=>({...group,state:input.mode==='track'&&groups.length===1?'cached':'queued'}))}
        publish();return structuredClone(plan)
      }
      if(name==='library.loudness.start'){
        starts.push(groups);plan.status=status('running','job:'+starts.length,groups.length,0,0,groups[0]?.title||'')
        plan.items=groups.map(group=>({...group,state:'queued'}));if(plan.items[0])plan.items[0].state='analyzing'
        publish();return structuredClone(plan)
      }
      if(name==='library.loudness.cancel'){
        expect(input.id===plan.id,'cancel used the wrong plan');cancelCount++
        plan.status=status('cancelled',plan.status.jobId,groups.length,0,0);plan.items=groups.map(group=>({...group,state:'cancelled'}))
        publish();return structuredClone(plan)
      }
      if(name==='library.loudness.clear'){
        expect(input.id===plan.id,'clear used the wrong plan');clears.push([plan.id]);results.clear();return
      }
      throw new Error('unexpected command '+name)
    },
    async query(name,input){
      if(name==='library.loudness.state')return structuredClone(plan)
      if(name==='library.loudness.page'){
        if(failQuery)throw new Error('fixture offline')
        expect(input.id===plan.id,'page used the wrong plan')
        return {id:plan.id,offset:input.offset,total:groups.length,items:plan.items.slice(input.offset,input.offset+input.limit).map((item,index)=>({...item,index:input.offset+index}))}
      }
      if(name==='library.loudness.result'){
        if(holdFirstResult){holdFirstResult=false;return new Promise(resolve=>releaseOld=()=>resolve({index:input.index,status:'measured',measurement:measured(-99)}))}
        return results.get(input.index)||{index:input.index,status:'missing'}
      }
      throw new Error('unexpected query '+name)
    }
  }
  globalThis.__core=core
  const selection=shallowRef({query:{ids:['one'],contentRevision:1,sort:'insertion'},total:1,ranges:[[0,1]]})
  const visible=ref(true),opener=document.querySelector('#opener');opener.focus()
  createApp({render:()=>visible.value?h(Dialog,{selection:selection.value,onClose:()=>visible.value=false}):null}).mount('#app')
  const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===text)
  const enabled=text=>button(text)?.disabled===false
  const click=async text=>{button(text).click();await nextTick()}
  await until(()=>releaseOld,'initial query not sent')
  expect(document.querySelector('dialog').matches(':modal'),'dialog is not modal')
  expect(document.activeElement===document.querySelector('input[value="track"]'),'radio did not receive focus')
  document.querySelector('input[value="album"]').click();await pause();releaseOld();await until(()=>enabled('开始分析'),'initial refresh did not finish')
  expect(!document.querySelector('.loudness-results').textContent.includes('-99'),'stale track query leaked into album view')
  expect(document.querySelectorAll('.loudness-row').length===1,'album plan did not produce one group')
  expect(document.querySelector('.loudness-results').textContent.includes('未分析'),'tag gains were treated as measured evidence')
  await click('开始分析');await until(()=>enabled('取消分析'),'start did not settle')
  expect(starts[0][0].tracks.length===2,'selected subset was analyzed as a complete album')
  document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));await pause()
  expect(!visible.value&&cancelCount===0,'closing cancelled a background job')
  expect(callbacks.size===0&&document.activeElement===opener,'close leaked the listener or failed focus restore')
  visible.value=true;await until(()=>enabled('取消分析'),'background task was not reattached')
  await click('取消分析');await until(()=>enabled('开始分析'),'cancel did not finish')
  expect(cancelCount===1,'cancel was not sent once')
  await click('开始分析');await until(()=>starts.length===2&&enabled('取消分析'),'second start did not finish')
  plan.items[0].state='failed';plan.items[0].reason='fixture decode failed';plan.status=status('completed',plan.status.jobId,1,1,1);publish();await until(()=>button('重试未完成项'),'retry missing')
  expect(document.querySelector('.loudness-results').textContent.includes('fixture decode failed'),'failure reason missing')
  await click('重试未完成项');await until(()=>starts.length===3&&enabled('取消分析'),'retry did not start')
  expect(starts[2].length===1&&starts[2][0].mode==='album','retry lost the full album scope')
  results.set(0,{index:0,status:'measured',measurement:measured(-21),tracks:[measured(-20),measured(-24)]})
  plan.items[0].state='completed';plan.status=status('completed',plan.status.jobId,1,1,0);publish()
  await until(()=>document.querySelector('.loudness-results').textContent.includes('-21.00'),'measured results missing')
  expect(document.querySelector('[aria-label^="综合响度"]').getAttribute('aria-label').includes('-21.00'),'accessible cell name omits the measured value')
  await click('清理此范围结果');await until(()=>clears.length===1&&enabled('刷新结果'),'clear did not finish')
  expect(clears[0][0]===plan.id&&!document.querySelector('.loudness-results').textContent.includes('-21.00'),'clear ignored current scope')
  failQuery=true;await click('刷新结果');await until(()=>document.querySelector('[role="alert"]'),'query error missing')
  expect(document.querySelector('[role="alert"]').textContent.includes('fixture offline'),'query failure not explained')
  failQuery=false;await click('重试操作');await until(()=>!document.querySelector('[role="alert"]')&&enabled('开始分析'),'query retry failed')
  document.querySelector('input[value="track"]').click();selection.value={query:{ids:Array.from({length:10000},(_,index)=>String(index)),contentRevision:1,sort:'insertion'},total:10000,ranges:[[0,10000]]};await until(()=>document.querySelector('[role="grid"]').getAttribute('aria-rowcount')==='10000'&&enabled('刷新结果'),'large scope did not load')
  const grid=document.querySelector('[role="grid"]')
  const maxMountedRows=Math.ceil(grid.clientHeight/64)+8
  expect(document.querySelectorAll('.loudness-row').length<=maxMountedRows,'large results mounted unbounded rows')
  grid.focus();grid.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));await pause()
  expect(grid.scrollTop>600000,'End did not reach the virtual tail')
  expect(document.querySelector('[aria-selected="true"]').textContent.includes('曲目 9999'),'keyboard selection lost last row')
  expect(document.querySelectorAll('.loudness-row').length<=maxMountedRows,'tail rendered unbounded rows')
  selection.value={query:{ids:['one'],contentRevision:1,sort:'insertion'},total:1,ranges:[[0,1]]};document.querySelector('input[value="album"]').click();await until(()=>document.querySelector('[role="grid"]').getAttribute('aria-rowcount')==='1','final plan did not load')
  await click('开始分析');await until(()=>enabled('取消分析'),'remeasure did not start')
  plan.items[0].state='failed';plan.items[0].reason='source changed';plan.status=status('completed',plan.status.jobId,1,1,1);publish();await pause()
  expect(!document.querySelector('.loudness-results').textContent.includes('-21.00'),'failure published a previous complete album')
  await click('刷新结果');await until(()=>!document.querySelector('[role="alert"]'),'final refresh failed')
}
`
