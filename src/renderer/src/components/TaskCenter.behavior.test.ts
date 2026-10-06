import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('one task center retains quiet outcomes, live progress and retryable notification actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-task-center-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'music.ts'), musicFixture)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: /^.*\/stores\/useMusicStore(?:\.ts)?$/,
            replacement: join(directory, 'music.ts')
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'TaskCenterTest',
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
        )}</head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));for(const dark of [false,true])await win.webContents.executeJavaScript('window.runTaskCenterTests('+dark+')');console.log('TASK_CENTER_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90000 }
    )
    assert.match(result.stdout, /TASK_CENTER_OK/)
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') ||
        resolve(directory).startsWith(resolve(tmpdir()) + '/')
    )
    await rm(directory, { recursive: true, force: true })
  }
})

const musicFixture = `import {ref} from 'vue'
export const scan=ref({state:'idle',current:0,total:10,error:''}),metadata=ref({state:'idle',completed:0,failed:0,skipped:0,total:0,error:''}),tracks=ref([]),calls=[]
export const useMusicStore=()=>({tracks,libraryScanStatus:scan,libraryMetadataEnrichmentStatus:metadata,pauseLibraryScan:async()=>{calls.push('pause');scan.value={...scan.value,state:'paused'}},resumeLibraryScan:async()=>{calls.push('resume');scan.value={...scan.value,state:'running'}},cancelLibraryScan:async()=>{calls.push('cancel');scan.value={...scan.value,state:'cancelled'}},startFullLibraryScan:async()=>{calls.push('retry');scan.value={...scan.value,state:'running',error:''}},cancelLibraryMetadataEnrichment:()=>{}})`

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick} from 'vue'
import TaskCenter from '@renderer/components/TaskCenter.vue'
import Host from '@renderer/components/AppNoticeHost.vue'
import {useAppNoticeStore} from '@renderer/stores/useAppNoticeStore'
import {createInitialAppUpdateSnapshot} from '@renderer/../../shared/appUpdate.ts'
import {scan,metadata,calls} from './music'
const expect=(ok,message)=>{if(!ok)throw new Error(message)}
const tick=async()=>{await nextTick();await nextTick();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
const button=(scope,label)=>[...document.querySelectorAll(scope+' button')].find(el=>el.textContent.trim()===label)
const noticeText=()=>document.querySelector('.notice-history-embedded')?.textContent||''
window.runTaskCenterTests=async dark=>{
  document.documentElement.dataset.theme=dark?'dark':'pureWhite';document.documentElement.dataset.teMotion='off';
  const store=useAppNoticeStore();store.clearNotices();store.setCenterOpen(false);scan.value={state:'idle',current:0,total:10,error:''};metadata.value={state:'idle',total:0,completed:0,failed:0,skipped:0};calls.length=0;
  let downloadsChanged,updateChanged,batchChanged,retries=0,revealed=0,library=0,stops=0;
  let snapshot=createInitialAppUpdateSnapshot();
  window.api={providerDownloads:{list:async()=>[],onChanged:fn=>{downloadsChanged=fn;return()=>stops++},cancel:async()=>{},retry:async()=>{retries++},result:async()=> 'D:/fixture/song.aac'},shell:{showItemInFolder:async()=>{revealed++}},app:{getUpdateState:async()=>snapshot,onUpdateState:fn=>{updateChanged=fn;return()=>stops++}},loudnessAnalysis:{getBatch:async()=>({status:{state:'idle',revision:0}}),onBatchProgress:fn=>{batchChanged=fn;return()=>stops++}}};
  const app=createApp({render:()=>h('div',{},[h(TaskCenter,{onLibrary:()=>library++}),h(Host)])});app.mount('#app');await tick();
  for(const kind of ['info','success','warning'])store.pushNotice({kind,message:'安静结果 '+kind});await tick();
  expect(document.querySelectorAll('.task-entry').length===1,'task center has duplicate entries');expect(!document.querySelector('.task-center'),'notification opened the center automatically');expect(!document.querySelector('.app-notice'),'routine information interrupted the page');expect(store.unreadCount.value===3,'quiet outcomes lost unread state');
  document.querySelector('.task-entry').click();await tick();
  expect(document.querySelectorAll('[role=dialog]').length===1,'notifications and tasks opened separate dialogs');expect(document.querySelectorAll('.notice-history').length===1,'history displayed twice');expect(noticeText().includes('安静结果 success'),'user result unavailable in shared panel');expect(store.unreadCount.value===0,'visible history was not marked read');expect(getComputedStyle(document.querySelector('.notice-history')).position==='static','embedded history still overlays a separate panel');
  scan.value={state:'running',current:4,total:10,error:''};await tick();
  expect(document.querySelector('progress[aria-label="曲库扫描"]').value===0.4,'live scan progress missing');button('.task-center','暂停').click();await tick();button('.task-center','继续').click();await tick();expect(calls.join(',')==='pause,resume','task controls lost behavior');
  scan.value={state:'completed',current:10,total:10,error:''};await tick();expect(noticeText().includes('曲库扫描：已完成'),'background completion disappeared');expect(!store.notices.value.length,'background completion became a toast');
  scan.value={state:'running',current:1,total:10,error:''};await tick();scan.value={state:'failed',current:1,total:10,error:'无法读取文件'};await tick();expect(noticeText().includes('无法读取文件'),'background error is not recoverable');expect(!store.notices.value.length,'failure already in task center duplicated as toast');
  const task=status=>({id:'download-'+dark,providerId:'fixture',providerJobId:'job',track:{id:'track',title:'下载旋律',artist:'艺人'},requestedQuality:'aac',actualQuality:'aac',status,progress:status==='completed'?1:0.2,targetPath:'D:/fixture/song.aac',fileSize:10,error:status==='failed'?'连接中断':null,createdAt:'2026-10-06',updatedAt:'2026-10-06'});
  downloadsChanged([task('downloading')]);await tick();downloadsChanged([task('failed')]);await tick();expect(noticeText().includes('下载失败'),'download failure has no retained result');button('.task-center','重新下载').click();await tick();expect(retries===1,'download retry lost');downloadsChanged([task('completed')]);await tick();button('.task-center','打开目录').click();await tick();expect(revealed===1,'completed download action lost');
  let attempts=0,reject;
  store.pushNotice({message:'用户操作可以重试',presentation:'center',action:{label:'恢复',run:()=>{attempts++;if(attempts===1)return new Promise((_,no)=>reject=no)}}});await tick();
  button('.notice-history','恢复').click();button('.notice-history','恢复').click();await tick();expect(attempts===1,'duplicate action ran concurrently');reject(new Error('设备不可用'));await tick();expect(button('.notice-history','恢复'),'failed action was consumed');expect(noticeText().includes('设备不可用'),'action failure is not visible');button('.notice-history','恢复').click();await tick();expect(attempts===2 && !button('.notice-history','恢复'),'retry action did not complete');
  const select=document.querySelector('.task-center select');select.value='active';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();store.pushNotice({message:'仍未阅读的用户结果'});await tick();expect(store.unreadCount.value===1,'hidden notification was incorrectly marked read');select.value='failed';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();expect(store.unreadCount.value===1,'attention filter swallowed an unseen normal result');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();expect(store.unreadCount.value===0,'all filter did not show/read result');
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();expect(!document.querySelector('.task-center'),'Escape did not close shared center');
  store.pushNotice({kind:'error',message:'播放被阻止'});await tick();expect([...document.querySelectorAll('.app-notice')].some(el=>el.textContent.includes('播放被阻止')),'necessary playback error was hidden');
  document.querySelector('.task-entry').click();await tick();button('.task-center','查看曲库').click();await tick();expect(library===1&&!document.querySelector('.task-center'),'library action did not navigate and close center');
  app.unmount();expect(stops===3,'shared services did not disconnect');store.clearNotices();
}`
