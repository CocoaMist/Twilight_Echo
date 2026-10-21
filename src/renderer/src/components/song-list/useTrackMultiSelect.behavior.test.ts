import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('mounted paged selection handles real DOM shortcuts, local anchors, action records and teardown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-selection-ui-'))
  try {
    await writeFile(join(directory, 'entry.mjs'), runtime)
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.mjs'),
          name: 'PagedSelectionTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><meta charset="utf-8"><button id="outside">Outside</button><div id="app"></div><script src="bundle/runtime.js"></script>'
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript('window.runSelectionTests()');console.log('PAGED_SELECTION_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      env,
      windowsHide: true,
      timeout: 60_000
    })
    assert.match(result.stdout, /PAGED_SELECTION_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

// This mounts the production composable, not the complete SongList component.
// Full-table rendering and actual database IPC retain their separate UI gate.
const runtime = `
import {createApp,h,computed,ref,nextTick} from 'vue'
import {useTrackMultiSelect} from '@renderer/components/song-list/useTrackMultiSelect.ts'
import {toPlaylistTrackSnapshot} from '@renderer/stores/library/musicStoreData.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=()=>nextTick()
const row=(key)=>({id:'same-recording',queueEntryId:key,title:key,artist:'Artist',album:'Album',filePath:'D:/disc.flac',fileName:'disc.flac',source:'local',duration:90,size:1,cover:null,lyrics:'heavy lyrics',cueRange:{startSeconds:90,endSeconds:180}})
window.runSelectionTests=async()=>{
  const page=ref(0),revision=ref(1),preserve=ref(true),root=ref(null),actions=[]
  const pages=[Array.from({length:4},(_,i)=>row('first:'+i)),Array.from({length:4},(_,i)=>row('next:'+i))]
  const tracks=computed(()=>pages[page.value])
  let multi
  const app=createApp({setup(){
    multi=useTrackMultiSelect({tracks,root,keyForTrack:track=>track.queueEntryId,preserveSelectedTracks:preserve,snapshotTrack:toPlaylistTrackSnapshot,selectionOrder:(_track,index)=>page.value*200+index,rangeContext:page,resetSources:[revision]})
    return()=>h('section',{ref:root,tabindex:0},[
      h('input',{id:'editable'}),
      h('button',{id:'page',onClick:()=>{page.value=1-page.value}},'Change page'),
      h('output',{id:'count'},String(multi.selectedCount.value)),
      ...tracks.value.map((track,index)=>h('button',{class:'row',key:track.queueEntryId,onClick:event=>multi.onRowClick(track,index,event)},track.title)),
      h('button',{id:'batch',onClick:()=>actions.push(multi.getSelectedTracks())},'Batch')
    ])
  }})
  app.mount('#app');await tick()
  const rows=()=>document.querySelectorAll('.row')
  const click=async(index,options={})=>{rows()[index].dispatchEvent(new MouseEvent('click',{bubbles:true,...options}));await tick()}
  const shortcut=async(target,key='a')=>{target.focus();const event=new KeyboardEvent('keydown',{key,ctrlKey:key==='a',bubbles:true,cancelable:true});target.dispatchEvent(event);await tick();return event.defaultPrevented}
  await click(3,{ctrlKey:true})
  expect(document.querySelector('#count').textContent==='1','initial checkbox-style selection missing')
  document.querySelector('#page').click();await tick()
  await click(1,{shiftKey:true})
  expect(multi.selectedCount.value===2,'previous-page anchor leaked into the new Shift range')
  const input=document.querySelector('#editable')
  expect(!await shortcut(input),'editable Ctrl+A intercepted')
  expect(!await shortcut(document.querySelector('#outside')),'another surface Ctrl+A intercepted')
  const menu=document.createElement('div');menu.setAttribute('role','menu');document.body.append(menu)
  expect(!await shortcut(rows()[0]),'menu did not own shortcuts');menu.remove()
  expect(await shortcut(rows()[0]),'owning row Ctrl+A was not handled')
  expect(multi.selectedCount.value===5,'Ctrl+A must add this page, not replace off-page selection or select the full query')
  document.querySelector('#batch').click();await tick()
  expect(actions[0].map(track=>track.queueEntryId).join(',')==='first:3,next:0,next:1,next:2,next:3','batch lost occurrence identity or query order')
  expect(actions[0].every(track=>track.lyrics===null&&track.cueRange.startSeconds===90),'batch records retained lyrics or lost CUE ranges')
  expect(await shortcut(rows()[0],'Escape'),'Escape did not clear the owning list')
  expect(multi.selectedCount.value===0,'Escape left selected records')
  await click(0,{ctrlKey:true});revision.value++
  expect(multi.selectedCount.value===0,'revision fence was not synchronous')
  await click(0,{ctrlKey:true});preserve.value=false
  expect(multi.selectedCount.value===0,'storage switch kept old records')
  preserve.value=true;await click(0,{ctrlKey:true});app.unmount()
  expect(multi.getSelectedTracks().length===0,'unmount retained selected records')
}
`
