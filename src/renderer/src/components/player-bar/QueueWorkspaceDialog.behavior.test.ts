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
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('Core queue workspace supports summary-only save/restore, undo, CRUD, failure retry and bounded history in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-queue-dialog-'))
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
          name: 'QueueDialogTest',
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
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">管理会话</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runQueueDialogTests()');if(process.env.TWILIGHT_QUEUE_DIALOG_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_QUEUE_DIALOG_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('QUEUE_DIALOG_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /QUEUE_DIALOG_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import QueueWorkspaceDialog from '@renderer/components/player-bar/QueueWorkspaceDialog.vue'
import {createCorePlayerPersonal} from '@renderer/stores/player/corePlayerPersonal.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(delay=30)=>new Promise(resolve=>setTimeout(resolve,delay))
const song=id=>({id,title:id,artist:'测试艺术家',album:'测试专辑',source:'local',duration:180})
window.runQueueDialogTests=async()=>{
  let fail=false,plays=0,bubbled=0,revision=0,sessions=[],recorded=[]
  const count=ref(20000),index=ref(19999),playing=ref(false),canUndo=ref(false)
  const state=shallowRef({phase:'ready',epoch:'test',workspaceRevision:0,workspaceContentRevision:0,lyricsRevision:null,bookmarksRevision:null})
  const core={state,query:async(name,input)=>{
    if(name==='workspace.state')return {revision,contentRevision:revision,error:''}
    if(name==='workspace.sessions')return {revision,contentRevision:revision,items:sessions.map(s=>({...s})),total:sessions.length,offset:0}
    if(name==='workspace.history')return {revision,contentRevision:revision,items:recorded.slice(-200),total:Math.min(recorded.length,200),offset:0}
    throw Error('Unexpected query '+name)
  },command:async(name,payload)=>{
    if(name==='lifecycle.flush')return
    expect(payload.revision===revision,'Core revision was not forwarded')
    if(name==='workspace.restore'){
      const saved=sessions.find(s=>s.id===payload.id);count.value=saved.count;index.value=saved.index;playing.value=payload.play;if(payload.play)plays++
      return {restored:saved.count,unavailable:0,deferred:0,issues:[]}
    }
    expect(name==='workspace.edit','unexpected command '+name)
    if(fail)throw Error('磁盘已满')
    const edit=payload.edit
    if(edit.kind==='saveCurrent'){
      const saved={id:edit.id??'saved:'+revision,name:edit.name,count:count.value,index:index.value,storage:'libraryQueue',playMode:'sequential'}
      const at=sessions.findIndex(s=>s.id===saved.id);if(at<0)sessions.push(saved);else sessions[at]=saved
    }
    if(edit.kind==='rename')sessions=sessions.map(s=>s.id===edit.id?{...s,name:edit.name}:s)
    if(edit.kind==='remove')sessions=sessions.filter(s=>s.id!==edit.id)
    revision++;state.value={...state.value,workspaceRevision:revision,workspaceContentRevision:revision}
  }}
  const {queueWorkspace:workspace,queueSessions:controller}=createCorePlayerPersonal(core,error=>{throw error})
  const app=createApp({render:()=>controller.open.value?h(QueueWorkspaceDialog,{workspace,controller,queueLength:count.value,canUndo:canUndo.value,undoLabel:'清空队列',undo:async()=>{count.value=20000;index.value=19999;playing.value=false;canUndo.value=false;return true},onClose:()=>controller.open.value=false}):null})
  const opener=document.querySelector('#opener');opener.focus();controller.show();app.mount('#app');await pause()
  const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===text)
  const click=async text=>{const target=button(text);expect(target&&!target.disabled,'missing or disabled button: '+text);target.click();await pause(70)}
  const type=async text=>{const input=document.querySelector('input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()}
  expect(document.querySelector('dialog').matches(':modal'),'not a modal dialog')
  expect(document.activeElement===document.querySelector('input'),'name input not focused')
  await type('工作');await click('保存为新会话')
  expect(workspace.sessions.value[0]?.count===20000&&!('entries' in workspace.sessions.value[0]),'large queue summary failed')
  expect(document.querySelectorAll('.session-row').length===1,'saved session missing')
  document.querySelector('.session-row').click();await pause()
  count.value=0;index.value=-1;canUndo.value=true;await pause()
  await click('撤销队列操作');expect(count.value===20000&&index.value===19999&&!playing.value,'undo did not recover paused cursor')
  await click('恢复队列');expect(index.value===19999&&plays===0&&!playing.value,'restore started playback or reused a wrong index')
  await click('恢复并播放');expect(plays===1&&playing.value,'explicit restore play failed')
  count.value=1;index.value=0;await pause()
  await click('用当前队列覆盖');expect(workspace.sessions.value[0].count===1,'overwrite failed')
  await type('睡前');await click('应用新名称');expect(workspace.sessions.value[0].name==='睡前','rename failed')
  await click('删除会话');await click('确认删除');expect(workspace.sessions.value.length===0,'delete failed')
  fail=true;await type('工作');await click('保存为新会话')
  expect(document.querySelector('[role="alert"]').textContent.includes('磁盘已满'),'write failure hidden')
  fail=false;await click('保存为新会话');expect(workspace.sessions.value.length===1,'save retry failed')
  for(let i=0;i<205;i++)recorded.push({id:'history:'+i,track:song('实际 '+i),playMode:i%2?'shuffle':'heart',playedAt:Date.now()})
  revision++;state.value={...state.value,workspaceRevision:revision,workspaceContentRevision:revision};await pause()
  await click('实际播放顺序')
  expect(document.querySelector('.history-list').textContent.includes('实际 204'),'latest playback order missing')
  expect(document.querySelectorAll('[data-playback-history-row]').length<=12,'history DOM not bounded')
  const history=document.querySelector('.history-list');history.scrollTop=200*54;history.dispatchEvent(new Event('scroll'));await pause()
  expect(history.textContent.includes('实际 5'),'oldest retained playback not reachable')
  window.addEventListener('keydown',()=>bubbled++)
  history.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));expect(bubbled===0,'dialog key reached playback shortcuts')
  history.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await pause()
  expect(!controller.open.value&&document.activeElement===opener,'Escape or focus restore failed')
  await workspace.flush()
  controller.show();await pause()
  document.querySelector('.session-row').click();await pause()
  await click('恢复队列')
  window.disposeQueueDialog=()=>app.unmount()
}
`
