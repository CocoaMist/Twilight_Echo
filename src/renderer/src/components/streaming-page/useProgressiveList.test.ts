import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { getPlaybackQueueWindow } from '../../utils/playbackQueueVirtualization.ts'

test('streaming lists reuse the queue virtual window instead of a growing prefix', () => {
  const source = readFileSync(new URL('./useProgressiveList.ts', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('./StreamingDetailStage.vue', import.meta.url), 'utf8')
  const social = readFileSync(new URL('./StreamingSocialStage.vue', import.meta.url), 'utf8')

  assert.match(source, /getPlaybackQueueWindow/)
  assert.match(source, /visibleStart/)
  assert.doesNotMatch(source, /visibleCount\.value \+ step/)
  assert.match(detail, /trackIndex\(index\)/)
  assert.match(detail, /:ref="listRef"/)
  assert.match(social, /trackIndex\(index\)/)
  assert.match(social, /:ref="listRef"/)
})

test('a 3k streaming list window stays within viewport + overscan', () => {
  const rowHeight = 64
  const overscan = 8
  const viewportHeight = 720
  const total = 3_000
  const range = getPlaybackQueueWindow(total, 64_000, viewportHeight, rowHeight, overscan)
  const mounted = range.end - range.start
  const cap = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  assert.ok(mounted <= cap, `mounted ${mounted} exceeds ${cap}`)
  assert.ok(range.start > 0)
  assert.ok(range.end < total)
})

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('native wheel keeps streaming rows covered without measuring every virtual window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-stream-scroll-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      publicDir: false,
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
          entry: join(directory, 'entry.ts'),
          name: 'ScrollProbe',
          formats: ['iife'],
          fileName: () => 'probe.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<style>body{margin:20px;font:14px system-ui}.viewport{height:520px;width:640px;overflow:auto;outline:none}.stage-rows{list-style:none;padding:0;margin:0;display:flow-root}.stage-row{box-sizing:border-box;height:var(--row-height,64px);border-bottom:1px solid #ddd;display:flex;align-items:center}.prefix{height:96px}</style><div id="app"></div><script src="bundle/probe.js"></script>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const path=require('node:path');
      app.setPath('userData',path.join(__dirname,'profile'));
      app.whenReady().then(async()=>{try{
        const win=new BrowserWindow({show:false,width:900,height:700,opacity:0,focusable:false,skipTaskbar:true,webPreferences:{backgroundThrottling:false}});
        win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
        win.showInactive();await win.loadFile(process.argv.at(-1));
        await win.webContents.executeJavaScript('window.readyScrollProbe()');
        await win.webContents.executeJavaScript('window.startScrollProbe()');
        for(let i=0;i<90;i++){
          win.webContents.sendInputEvent({type:'mouseWheel',x:360,y:300,deltaY:-40,deltaX:0,canScroll:true});
          await new Promise(resolve=>setTimeout(resolve,12));
        }
        const metrics=await win.webContents.executeJavaScript('window.finishScrollProbe()');
        console.log('SCROLL_METRICS '+JSON.stringify(metrics));if(process.env.TWILIGHT_SCROLL_METRICS)require('node:fs').writeFileSync(process.env.TWILIGHT_SCROLL_METRICS,JSON.stringify(metrics,null,2));
        await win.webContents.executeJavaScript('window.checkScrollBehavior()');
        if(metrics.rectReads>12)throw new Error('scroll repeatedly measured virtual rows: '+metrics.rectReads);
        win.webContents.setBackgroundThrottling(true);win.hide();await win.webContents.executeJavaScript('window.checkHiddenScroll()');
        win.showInactive();await win.webContents.executeJavaScript('window.checkRestoredScroll()');
        await win.webContents.executeJavaScript('window.cleanupScrollProbe()');
        console.log('STREAM_SCROLL_OK');app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1)}});`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 30_000 }
    )
    assert.match(result.stdout, /STREAM_SCROLL_OK/)
    const metrics = JSON.parse(result.stdout.match(/SCROLL_METRICS (.+)/)?.[1] ?? '{}')
    assert.ok(metrics.scrollEvents >= 10, 'native wheel must produce continuous scroll commits')
    assert.ok(metrics.distance > 2000, 'native wheel must advance through multiple windows')
    assert.ok(metrics.frames >= 20, 'probe must capture actual rendered frame intervals')
    if (process.env.TWILIGHT_SCROLL_METRICS)
      await writeFile(process.env.TWILIGHT_SCROLL_METRICS, JSON.stringify(metrics, null, 2))
    console.log(metrics)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref}from'vue'
import{useProgressiveList}from'@renderer/components/streaming-page/useProgressiveList.ts'
const expect=(value,label)=>{if(!value)throw new Error(label)};
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const until=async(predicate,label)=>{const end=performance.now()+3000;while(!predicate()){if(performance.now()>end)throw new Error(label);await frame()}};
const items=ref(Array.from({length:4000},(_,id)=>({id})));
let list,viewport,reads=0,events=0,active=false,settled=true,raf=0,last=0;const intervals=[];
const original=Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect=function(){if(active&&(this.classList.contains('stage-row')||this.classList.contains('stage-rows')||this.classList.contains('viewport')))reads++;return original.call(this)};
const app=createApp({setup(){list=useProgressiveList(()=>items.value);return()=>h('div',{class:'viewport',tabindex:0},[h('div',{class:'prefix'},'4000 tracks'),h('ul',{ref:list.listRef,class:'stage-rows',style:{height:list.totalHeight.value+'px'}},list.visibleItems.value.map((item,index)=>h('li',{key:item.id,class:'stage-row','data-index':item.id,style:index===0?{marginTop:list.paddingTop.value+'px'}:undefined},'Track '+item.id)))])}});app.mount('#app');
function cover(){
 const rows=[...document.querySelectorAll('.stage-row')],height=parseFloat(getComputedStyle(rows[0]).height),first=Number(rows[0].dataset.index),last=Number(rows.at(-1).dataset.index);
 const start=Math.max(0,Math.floor((viewport.scrollTop-96)/height)),end=Math.min(items.value.length-1,Math.floor((viewport.scrollTop+viewport.clientHeight-97)/height));
 expect(rows.length<=Math.ceil(viewport.clientHeight/height)+18,'mounted rows grew beyond viewport and overscan');
 expect(first<=start&&last>=end,'virtual window left visible rows blank: '+JSON.stringify({first,last,start,end,top:viewport.scrollTop,height}));
}
function tick(time){if(!active)return;if(last)intervals.push(time-last);last=time;cover();raf=requestAnimationFrame(tick)}
window.readyScrollProbe=async()=>{viewport=document.querySelector('.viewport');viewport.addEventListener('scroll',()=>{events++;settled=false});viewport.addEventListener('scrollend',()=>settled=true);await frame();await frame();cover()};
window.startScrollProbe=()=>{reads=events=0;intervals.length=0;last=0;active=true;raf=requestAnimationFrame(tick)};
window.finishScrollProbe=async()=>{await until(()=>settled,'native wheel did not settle');await frame();active=false;cancelAnimationFrame(raf);cover();const sorted=[...intervals].sort((a,b)=>a-b);return{rectReads:reads,scrollEvents:events,distance:viewport.scrollTop,frames:intervals.length,p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),over25ms:sorted.filter(x=>x>25).length}};
window.checkScrollBehavior=async()=>{
 document.querySelector('.prefix').style.height='176px';await frame();await frame();viewport.scrollTop=176+50*64;await until(()=>list.visibleStart.value===42,'prefix growth kept a stale list offset');document.querySelector('.prefix').style.height='96px';await frame();await frame();
 viewport.style.setProperty('--row-height','80px');await until(()=>list.totalHeight.value===320000,'font/row height was not remeasured');cover();
 viewport.style.width='420px';viewport.style.height='360px';await frame();cover();
 list.scrollToIndex(2500);await frame();expect(Math.abs(viewport.scrollTop-(96+2500*80-(360-80)/2))<=1,'index jump drifted: '+JSON.stringify({actual:viewport.scrollTop,expected:96+2500*80-(360-80)/2}));cover();
 items.value=Array.from({length:60},(_,id)=>({id}));await frame();await frame();expect(list.totalHeight.value===4800,'source replacement kept old metrics');cover();
 const next=document.createElement('div');next.className='viewport';next.style.height='400px';next.style.setProperty('--row-height','80px');viewport.after(next);const prefix=document.createElement('div');prefix.style.height='120px';next.append(prefix,document.querySelector('.stage-rows'));viewport=next;items.value=[...items.value];await frame();await frame();list.scrollToIndex(30);await frame();expect(Math.abs(viewport.scrollTop-(120+30*80-(400-80)/2))<=1,'new scroll root retained old offset');
};
window.checkHiddenScroll=async()=>{if(!document.hidden)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('native hide did not publish visibility')),3000);const changed=()=>{if(document.hidden){clearTimeout(timer);document.removeEventListener('visibilitychange',changed);resolve()}};document.addEventListener('visibilitychange',changed)});const previous=list.paddingTop.value;viewport.scrollTop=900;window.dispatchEvent(new Event('resize'));await new Promise(resolve=>setTimeout(resolve,0));expect(list.paddingTop.value===previous,'hidden scroll still updated the virtual window')};
window.checkRestoredScroll=async()=>{await until(()=>!document.hidden,'native show did not restore visibility');await frame();await until(()=>list.paddingTop.value===80,'restored document kept the hidden scroll window')};
window.cleanupScrollProbe=async()=>{const startRange=list.paddingTop.value;app.unmount();const start=reads;active=true;viewport.scrollTop=400;window.dispatchEvent(new Event('resize'));await frame();active=false;expect(reads===start,'disposed list still read geometry');expect(list.paddingTop.value===startRange,'disposed list retained a scroll listener');Element.prototype.getBoundingClientRect=original};`
