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
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('native modal lifecycle and reversible settings disclosures preserve focus and geometry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-disclosure-motion-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'FixtureDialog.vue'), fixtureDialog)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
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
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'DialogMotionTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{margin:0;padding:28px;background:#eef0f7;font:14px system-ui}.settings-preview-stack{max-width:760px;margin:32px auto}.preview-section{margin-bottom:24px}.motion-fixture{margin:auto;width:360px;border:1px solid #cbd1e0;border-radius:16px;padding:28px;background:white;color:#273049}.motion-fixture::backdrop{background:rgb(20 30 60 / .35)}.motion-fixture button{margin-right:12px}#opener{position:absolute;top:20px;left:30px}</style></head><body><button id="opener">打开测试弹窗</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');app.setPath('userData',path.join(path.dirname(process.argv.at(-1)),'electron-user-data'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:820,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runMotionTests()');if(process.env.TWILIGHT_MOTION_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_MOTION_SCREENSHOTS,{recursive:true});for(const state of ['modal-enter','modal-leave','disclosure-expanded','disclosure-leave']){await win.webContents.executeJavaScript('window.prepareMotionFrame('+JSON.stringify(state)+')');fs.writeFileSync(path.join(process.env.TWILIGHT_MOTION_SCREENSHOTS,state+'.png'),(await win.webContents.capturePage()).toPNG())}}console.log('DIALOG_DISCLOSURE_MOTION_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /DIALOG_DISCLOSURE_MOTION_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const fixtureDialog = `<script setup lang="ts">
import {ref} from 'vue'
import {useNativeDialog} from '@renderer/composables/useNativeDialog'
const props=defineProps<{busy:boolean}>();const emit=defineEmits<{close:[]}>();const dialog=ref<HTMLDialogElement|null>(null)
useNativeDialog(dialog)
function close(){if(!props.busy)emit('close')}
</script><template><dialog ref="dialog" class="motion-fixture" aria-labelledby="motion-title" @cancel.prevent="close"><h2 id="motion-title">保存播放队列</h2><p>弹窗完成退出后，焦点回到打开按钮。</p><input aria-label="队列名称" value="夜间收藏"><p><button @click="close">取消</button><button :disabled="busy" @click="emit('close')">保存</button></p></dialog></template>`

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import SettingsDisclosure from '@renderer/components/settings-page/SettingsDisclosure.vue'
import FixtureDialog from './FixtureDialog.vue'
import '@renderer/assets/base.css'
import '@renderer/components/settings-page/SettingsPage.css'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms))
const until=async(fn,label)=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error(label);await pause()}await nextTick()}
const shown=ref(false),owner=ref(true),expanded=ref(false),busy=ref(false)
let closes=0
const app=createApp({render:()=>[
 owner.value?h(NativeDialogTransition,null,{default:()=>shown.value?h(FixtureDialog,{busy:busy.value,onClose:()=>{closes++;shown.value=false}}):null}):null,
 h('main',{class:'settings-preview-stack'},[h('section',{class:'glass-card preview-section'},[h('h2','播放条设置'),h('div',{class:'setting-list'},[
 h('button',{id:'disclosure-trigger',class:'settings-accordion-trigger setting-item','aria-expanded':expanded.value,onClick:()=>expanded.value=!expanded.value},'播放条形态与可见性'),
 h(SettingsDisclosure,{open:expanded.value,class:'settings-accordion-body',id:'disclosure'},()=>[h('hr'),h('label',{class:'setting-item'},['收起延迟',h('input',{id:'disclosure-input',value:'900 ms'})]),h('div',{class:'setting-item'},'在播放页保持常显'),h('div',{class:'setting-item'},'隐藏时保留底部触发区')]),
 h('div',{id:'following',class:'setting-item'},'播放条按钮编排')])]),h('section',{id:'next-section',class:'glass-card preview-section'},[h('h2','背景与封面'),h('p','下面的设置随折叠区移动，文字不缩放。')])])
]});app.mount('#app')
const opener=document.querySelector('#opener');opener.onclick=()=>{opener.focus();shown.value=true}
const modal=()=>document.querySelector('dialog')
const open=async()=>{opener.click();await nextTick();await until(()=>modal()?.matches(':modal'),'modal did not open')}
const close=()=>modal().dispatchEvent(new Event('cancel',{cancelable:true}))
window.runMotionTests=async()=>{
 for(const mode of ['full','reduced','off']){
  document.documentElement.dataset.teMotion=mode;await open();if(mode!=='off')await until(()=>!modal().classList.contains('native-dialog-enter-from'),'entry never advanced');await pause(mode==='off'?30:30)
  const d=modal();if(mode!=='off')for(const a of d.getAnimations())a.currentTime=mode==='reduced'?45:70;const enter=getComputedStyle(d)
  if(mode==='full'){expect(Number(enter.opacity)>0&&Number(enter.opacity)<1,'full entry must have intermediate opacity: '+JSON.stringify({opacity:enter.opacity,transform:enter.transform,classes:d.className,animations:d.getAnimations().map(a=>({time:a.currentTime,state:a.playState,frames:a.effect.getKeyframes()}))}));expect(enter.transform!=='none','full entry has no scale')}
  if(mode==='reduced'){expect(enter.transform==='none','reduced modal moved');expect(Number(enter.opacity)>0&&Number(enter.opacity)<1,'reduced modal lost fade')}
  await pause(240);busy.value=true;await nextTick();close();await pause(30);expect(shown.value&&d.matches(':modal'),'busy cancel closed modal');busy.value=false;await nextTick()
  const beforeCloses=closes;close();await nextTick();if(mode!=='off')close()
  if(mode!=='off'){expect(d.isConnected&&d.matches(':modal'),'beforeUnmount removed native top layer before leave');expect(d.inert,'leaving modal stayed interactive');await pause(50);expect(Number(getComputedStyle(d,'::backdrop').opacity)>0,'backdrop vanished before leave')}
  await until(()=>!modal(),'modal did not leave');expect(document.activeElement===opener,'focus not restored after leave');expect(closes===beforeCloses+1,'close emitted twice')
 }
 document.documentElement.dataset.teMotion='full';await open();await pause(70);close();await pause(40);shown.value=true;await nextTick();await pause(250);expect(document.querySelectorAll('dialog').length===1&&modal().matches(':modal'),'rapid reopen left stranded or duplicate modal');close();await until(()=>!modal(),'rapid reopened modal failed close')
 await open();await pause(80);close();await nextTick();document.documentElement.dataset.teMotion='off';await pause(20);expect(!modal(),'live off preference retained native leave');document.documentElement.dataset.teMotion='full';await pause();await open();close();owner.value=false;await nextTick();expect(!modal()&&!document.querySelector(':modal'),'owner unmount stranded modal');expect(document.activeElement===opener,'owner teardown lost focus');owner.value=true
 const trigger=document.querySelector('#disclosure-trigger'),panel=document.querySelector('#disclosure'),following=document.querySelector('#following')
 const initial=following.getBoundingClientRect().top
 for(const mode of ['full','reduced','off']){
  document.documentElement.dataset.teMotion=mode;await pause();trigger.click();await nextTick();await pause(mode==='off'?30:65)
  if(mode==='reduced')expect(getComputedStyle(panel).transform==='none','reduced disclosure moved')
  if(mode==='full')expect(Number(getComputedStyle(panel).opacity)<1,'disclosure entry did not animate')
  await pause(240);expect(following.getBoundingClientRect().top>initial+150,'disclosure did not preserve expanded geometry')
  document.querySelector('#disclosure-input').focus();expanded.value=false;await nextTick();expect(document.activeElement===trigger,'collapsing content lost keyboard focus');expect(panel.inert,'leaving disclosure remained interactive')
  await pause(350);expect(Math.abs(following.getBoundingClientRect().top-initial)<1,'collapsed disclosure retained a gap');expect(!document.querySelector('#disclosure-input'),'closed content did not unmount')
 }
 document.documentElement.dataset.teMotion='full';await pause();trigger.click();await pause(70);trigger.click();await pause(50);const opacity=Number(getComputedStyle(panel).opacity);trigger.click();await nextTick();expect(Math.abs(Number(getComputedStyle(panel).opacity)-opacity)<.12,'reversal jumped to animation start');await pause(250);expect(!panel.inert&&document.querySelector('#disclosure-input'),'reversal removed reopened content');trigger.click();await pause(30);document.documentElement.dataset.teMotion='off';await pause(40);expect(getComputedStyle(panel).display==='none','live off preference did not finish disclosure');expect(Math.abs(following.getBoundingClientRect().top-initial)<1,'live off preference left projected geometry')
}
window.prepareMotionFrame=async(state)=>{
 for(const animation of document.getAnimations())animation.play();document.documentElement.dataset.teMotion='full';shown.value=false;expanded.value=false;await pause(380)
 if(state.startsWith('modal')){await open();await pause(state==='modal-enter'?55:260);if(state==='modal-leave'){close();await nextTick();await pause(45)}}
 else {expanded.value=true;await pause(270);if(state==='disclosure-leave'){expanded.value=false;await nextTick();await pause(65)}}
 if(state.startsWith('modal')){await until(()=>modal()?.getAnimations().length,'frame has no modal animation');for(const animation of modal().getAnimations()){animation.pause();animation.currentTime=state==='modal-enter'?35:45}}else for(const animation of document.getAnimations())animation.pause();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
}
`
