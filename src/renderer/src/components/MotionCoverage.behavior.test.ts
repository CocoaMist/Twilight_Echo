import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('motion modes, legacy overlays, discovery layout, popovers and satellite bootstrap work in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-motion-coverage-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    const app = parse(await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
    await writeFile(
      join(directory, 'app.css'),
      app.descriptor.styles.map((s) => s.content).join('\n')
    )
    const surfaceStyles = await Promise.all(
      ['streaming-page/StreamingPage.css', 'player-bar/PlayerBar.css'].map(async (path) => {
        const filename = join(workspace, 'src/renderer/src/components', path)
        const result = compileStyle({
          source: await readFile(filename, 'utf8'),
          filename,
          id: 'data-v-motion',
          scoped: true
        })
        assert.deepEqual(result.errors, [])
        return result.code
      })
    )
    await writeFile(join(directory, 'motion-surfaces.css'), surfaceStyles.join('\n'))
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [
        {
          name: 'coverage-fixtures',
          enforce: 'pre',
          load(id) {
            const path = id.replaceAll('\\', '/')
            if (path.endsWith('/stores/useMusicStore.ts'))
              return 'export function useMusicStore(){return {createAggregatePlaylist:()=>"new-playlist",addTracksToPlaylistById:()=>0}}'
            if (path.endsWith('/components/CoverImg.vue'))
              return '<template><span class="cover-fixture"></span></template>'
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
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'MotionCoverageTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<link rel="stylesheet" href="app.css"><link rel="stylesheet" href="motion-surfaces.css"><style>body{padding:24px;background:#edf0f5}body::before,body::after{display:none!important}#app{max-width:880px;margin:auto}.disc{animation:none!important}.workshop-delete-dialog{padding:24px;border-radius:16px;background:white}.workshop-delete-dialog::backdrop{background:#0005}</style></head><body><button id="opener">打开弹窗</button><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');app.setPath('userData',path.join(path.dirname(process.argv.at(-1)),'user-data'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:880,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});ipcMain.handle('motion-system',(_e,reduced)=>{nativeTheme.prefersReducedMotion=reduced});ipcMain.handle('control-key',(_e,key)=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key})});ipcMain.handle('control-click',(_e,point)=>{for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),...(type==='mouseMove'?{}:{button:'left',clickCount:1})})});ipcMain.handle('motion-capture',async(_e,name)=>{if(process.env.TWILIGHT_MOTION_VISUAL_DIR){await fs.mkdir(process.env.TWILIGHT_MOTION_VISUAL_DIR,{recursive:true});await fs.writeFile(path.join(process.env.TWILIGHT_MOTION_VISUAL_DIR,name+'.png'),(await win.webContents.capturePage()).toPNG())}});try{await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await win.webContents.executeJavaScript('window.runMotionCoverage()');console.log('MOTION_COVERAGE_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /MOTION_COVERAGE_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import '@renderer/assets/icons.css'
import '@renderer/assets/base.css'
import CreateAggregatePlaylistDialog from '@renderer/components/aggregate-playlist/CreateAggregatePlaylistDialog.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import WorkshopDeleteDialog from '@renderer/components/theme-workshop/WorkshopDeleteDialog.vue'
import StreamingDiscovery from '@renderer/components/StreamingDiscovery.vue'
import StreamingProviderSwitcher from '@renderer/components/streaming-page/StreamingProviderSwitcher.vue'
import ProviderMusicHome from '@renderer/components/streaming-page/ProviderMusicHome.vue'
import TrayPlayerApp from '@renderer/tray-player/TrayPlayerApp.vue'
import AnimatedInput from '@renderer/components/AnimatedInput.vue'
import {EMPTY_MINI_PLAYER_STATE} from '@renderer/../../shared/miniPlayer.ts'
const ipc=window.require('electron').ipcRenderer
const expect=(value,message)=>{if(!value)throw new Error(message)}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const frame=()=>new Promise(requestAnimationFrame)
const flush=async()=>{await nextTick();await frame();await frame()}
const until=async(fn,label)=>{for(let i=0;i<150;i++){if(fn())return;await sleep(10)}throw Error(label)}
const pressKey=async(key)=>{
  let listener,timer
  const delivered=new Promise((resolve,reject)=>{
    listener=event=>{if(event.key===(key==='Right'?'ArrowRight':key))resolve()}
    document.addEventListener('keydown',listener,true)
    timer=setTimeout(()=>reject(new Error('native key was not delivered: '+key)),1500)
  })
  try{await ipc.invoke('control-key',key);await delivered;await flush()}
  finally{clearTimeout(timer);document.removeEventListener('keydown',listener,true)}
}
const root=document.documentElement,opener=document.querySelector('#opener')
let app
const mount=async(render)=>{app?.unmount();document.querySelector('#app').innerHTML='';app=createApp({render});app.mount('#app');await nextTick()}
const setMode=async(mode)=>{root.dataset.teMotion=mode;await flush()}
const capture=async(name)=>{
  const animations=document.getAnimations().filter(a=>a.playState==='running')
  for(const animation of animations)animation.pause()
  await flush();await sleep(40)
  await ipc.invoke('motion-capture',name)
  for(const animation of animations)if(animation.playState==='paused')animation.play()
}
const playlist={id:'focus',name:'安静的夜晚',trackCount:12,coverUrl:'',creatorName:'Twilight Echo'}
window.runMotionCoverage=async()=>{
  await setMode('off')
  await pressKey('Tab')
  for(const tone of ['pureWhite','dark']){
    root.dataset.theme=tone
    const text=ref(''),disabled=ref(false)
    await mount(()=>h(AnimatedInput,{modelValue:text.value,'onUpdate:modelValue':value=>text.value=value,placeholder:'请输入歌单名称',disabled:disabled.value,animate:true,style:'width:240px;height:44px;color:var(--te-neutral-900);--ai-placeholder:var(--te-neutral-500)'}))
    const input=document.querySelector('.animated-input-field'),host=input.parentElement
    input.focus();await flush()
    const placeholder=getComputedStyle(input,'::placeholder'),hostStyle=getComputedStyle(host)
    expect(placeholder.webkitTextFillColor===placeholder.color&&placeholder.color!=='rgba(0, 0, 0, 0)',tone+' native placeholder is invisible')
    expect(input.matches(':focus-visible')&&hostStyle.outlineStyle==='solid'&&parseFloat(hostStyle.outlineWidth)===2,tone+' input has no keyboard focus ring')
    expect(getComputedStyle(input).webkitTextFillColor==='rgba(0, 0, 0, 0)',tone+' ordinary input no longer uses its character mirror')
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
    input.value='中文';input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'中文'}));await flush()
    expect(text.value==='中文'&&host.classList.contains('is-composing'),tone+' IME input stopped updating model')
    expect(getComputedStyle(input).webkitTextFillColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(host.querySelector('.animated-input-mirror')).opacity==='0',tone+' IME shows both native text and mirror')
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));await sleep(20);await flush()
    expect(!host.classList.contains('is-composing')&&host.querySelector('.animated-input-track').textContent==='中文',tone+' committed text lost its mirror')
    input.value='中文A';input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'A'}));await flush()
    expect(text.value==='中文A'&&host.querySelector('.animated-input-track').textContent==='中文A',tone+' ordinary input stopped updating')
    disabled.value=true;await flush();expect(input.disabled,tone+' disabled prop did not reach native input')
    opener.focus();input.focus();expect(document.activeElement!==input,tone+' disabled input accepted focus')
  }
  delete root.dataset.theme
  for(const reduced of [false,true]){
    await ipc.invoke('motion-system',reduced);await sleep(30)
    for(const mode of ['full','reduced','off']){
      await setMode(mode)
      await mount(()=>h('div',{class:'main-content'},[h('article',{class:'page-down-enter-active page-down-enter-from'},'页面内容')]))
      const page=document.querySelector('article'),style=getComputedStyle(page)
      expect(mode==='full'?style.transform!=='none':style.transform==='none','page mode moved incorrectly: '+mode)
      expect(style.transitionDuration===(mode==='full'?'0.18s, 0.24s':mode==='reduced'?'0.12s':'0s'),'page duration ignored mode: '+mode+' '+style.transitionDuration)
      expect(style.filter==='none','page transition blurred text')
      if(mode==='full')expect(new DOMMatrix(style.transform).a===1&&new DOMMatrix(style.transform).d===1,'page transition scaled text')
      await mount(()=>h('div',null,[h('i',{id:'spinner',class:'pi pi-spinner pi-spin'}),h('span',{'data-v-motion':'',class:'live-badge'},'LIVE'),h('section',{'data-v-motion':'',class:'stream-view-panel'},'在线音乐')]))
      const spinner=document.querySelector('#spinner'),badge=document.querySelector('.live-badge'),stream=document.querySelector('section')
      const spin=spinner.getAnimations()[0]
      expect(mode==='off'?!spin:Boolean(spin),'loading spinner missing or unexpectedly moving: '+mode)
      if(spin){expect(spin.effect.getTiming().duration===(mode==='full'?2000:4000),'spinner ignored motion speed');spin.pause();spin.currentTime=500;expect(getComputedStyle(spinner).transform!=='none','spinner keyframes do not exist')}
      const pulses=badge.getAnimations({subtree:true})
      expect(mode==='full'?pulses.length===1:pulses.length===0,'live badge ignored motion mode')
      if(mode==='full'){
        const pulse=pulses[0];pulse.pause();pulse.currentTime=0;const before=getComputedStyle(badge,'::before');const shadow=before.boxShadow,width=badge.getBoundingClientRect().width
        pulse.currentTime=700;await frame();const after=getComputedStyle(badge,'::before')
        expect(Number(after.opacity)<0.6,'live indicator does not breathe')
        expect(after.boxShadow===shadow&&after.transform==='none'&&badge.getBoundingClientRect().width===width,'live indicator repainted shadow or moved text')
      }
      expect(getComputedStyle(stream).willChange==='auto','idle streaming page retains a compositor hint')
      for(const [name,axis,direction] of [['stream-page-down','f',1],['stream-page-up','f',-1],['stream-detail-forward','e',1],['stream-detail-back','e',-1]]){
        stream.className='stream-view-panel '+name+'-enter-active '+name+'-enter-from';await flush();const css=getComputedStyle(stream)
        expect(css.filter==='none','streaming transition blurred text')
        expect(css.transitionDuration===(mode==='full'?'0.18s, 0.24s':mode==='reduced'?'0.12s':'0s'),'streaming transition ignored mode '+mode+' '+css.transitionDuration)
        if(mode==='full'){const matrix=new DOMMatrix(css.transform);expect(matrix.a===1&&matrix.d===1&&Math.sign(matrix[axis])===direction,'streaming direction or text scale changed: '+name)}
        else expect(css.transform==='none','streaming reduced/off moved content')
        stream.className='stream-view-panel';await flush();expect(getComputedStyle(stream).willChange==='auto','streaming page did not release compositor hint')
      }
      await mount(()=>h('article',{class:'glass-card'},'主题内容'))
      const themePage=document.querySelector('article')
      root.classList.add('te-theme-tone-transition');await nextTick()
      expect(getComputedStyle(themePage).transitionDuration===(mode==='full'?'0.2s, 0.2s, 0.2s':mode==='reduced'?'0.12s':'0s'),'theme transition ignored mode '+mode+' '+getComputedStyle(themePage).transitionDuration)
      root.classList.remove('te-theme-tone-transition')
    }
  }
  await ipc.invoke('motion-system',false)
  for(const mode of ['full','reduced','off']){
    await setMode(mode);const shown=ref(false)
    await mount(()=>h(CreateAggregatePlaylistDialog,{show:shown.value,tracks:[],onClose:()=>shown.value=false}))
    opener.focus();shown.value=true;await flush();const overlay=document.querySelector('.create-aggregate-overlay'),panel=overlay.querySelector('[data-dialog-panel]')
    if(mode!=='off'){overlay.getAnimations().forEach(a=>a.currentTime=60);expect(Number(getComputedStyle(overlay).opacity)<1,'overlay did not fade')}
    expect(mode==='full'?getComputedStyle(panel).transform!=='none':getComputedStyle(panel).transform==='none','overlay panel mode mismatch')
    if(mode==='full')await capture('aggregate-enter')
    await sleep(240);panel.querySelector('button').click();await nextTick()
    if(mode!=='off')expect(overlay.isConnected&&overlay.inert,'leaving overlay must remain visible and inert')
    await until(()=>!document.querySelector('.create-aggregate-overlay'),'overlay did not leave')
    expect(document.activeElement===opener,'overlay did not restore focus after leave')
    shown.value=true;await flush();shown.value=false;await sleep(25);shown.value=true;await sleep(250)
    expect(document.querySelectorAll('.create-aggregate-overlay').length===1&&!document.querySelector('.create-aggregate-overlay').inert,'rapid overlay reversal stranded state')
    shown.value=false;await nextTick();await setMode('off');await until(()=>!document.querySelector('.create-aggregate-overlay'),'off did not settle leave')
  }
  await setMode('full');const modal=ref(false)
  await mount(()=>h(NativeDialogTransition,null,{default:()=>modal.value?h(WorkshopDeleteDialog,{name:'夜色',onClose:()=>modal.value=false,onConfirm:()=>modal.value=false}):null}))
  opener.focus();modal.value=true;await flush();expect(document.querySelector('dialog').matches(':modal'),'workshop did not enter native top layer');await sleep(230)
  document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));await nextTick();expect(document.querySelector('dialog').matches(':modal'),'workshop left top layer too early');await until(()=>!document.querySelector('dialog'),'workshop did not close');expect(document.activeElement===opener,'workshop focus was not restored')
  for(const mode of ['full','reduced','off']){
    await setMode(mode);const expanded=ref(false)
    await mount(()=>h('div',null,[h(StreamingDiscovery,{providerLabel:'音乐',supportsCategories:true,supportsHighQuality:false,catalogue:null,catalogueLoading:true,catalogueError:'',selectedTag:'全部',order:'hot',highQuality:false,panelExpanded:expanded.value,playlists:[playlist],total:1,offset:0,hasMore:false,listLoading:false,listError:'',loadingMore:false,onTogglePanel:()=>expanded.value=!expanded.value}),h('footer',{id:'outside'},'外部区域')]))
    await flush();const results=document.querySelector('.disc-results'),initial=results.getBoundingClientRect().top
    document.querySelector('.disc-chip-more').click();await nextTick()
    if(mode==='full')expect(Math.abs(results.getBoundingClientRect().top-initial)<4,'discovery results jumped before the animation')
    if(mode!=='full')expect(results.getAnimations().length===0,'reduced/off projected results')
    expect(document.querySelector('#outside').getAnimations().length===0,'disclosure projected outside its boundary')
    await sleep(230);const expandedTop=results.getBoundingClientRect().top;expect(expandedTop>initial+20,'discovery did not expand')
    if(mode==='full')await capture('discovery-expanded')
    expanded.value=false;await sleep(190)
    if(mode==='full')expect(results.getAnimations().length>0,'collapse skipped result movement')
    await sleep(150);expect(Math.abs(results.getBoundingClientRect().top-initial)<1,'discovery did not settle to original geometry')
    expanded.value=true;await sleep(35);expanded.value=false;await sleep(20);expanded.value=true;await sleep(250);expect(!document.querySelector('#discovery-categories').inert,'rapid discovery reversal left inert panel')
  }
  for(const mode of ['full','reduced','off']){
    await setMode(mode)
    await mount(()=>h(StreamingProviderSwitcher,{modelValue:'one',options:[{id:'one',name:'音源一',icon:'pi pi-cloud',color:'#5070d0'},{id:'two',name:'音源二',icon:'pi pi-cloud',color:'#609090'}]}))
    await flush();document.querySelector('.provider-switcher-trigger').click();await flush()
    const menu=document.querySelector('[popover]');expect(menu.matches(':popover-open'),'provider menu did not open')
    expect(mode==='full'?getComputedStyle(menu).transform!=='none':getComputedStyle(menu).transform==='none','provider menu mode mismatch')
    if(mode!=='off'){const a=menu.getAnimations().find(a=>a.transitionProperty==='opacity');expect(a,'provider menu did not fade '+JSON.stringify({mode,opacity:getComputedStyle(menu).opacity,transition:getComputedStyle(menu).transition,animations:menu.getAnimations().map(a=>({property:a.transitionProperty,time:a.currentTime,frames:a.effect.getKeyframes()}))}));a.pause();a.currentTime=60;expect(Number(getComputedStyle(menu).opacity)<1,'provider entry lacks intermediate state');a.play()}
    if(mode==='full')await capture('provider-menu-enter')
    await sleep(200);document.querySelector('.provider-switcher-trigger').click();await nextTick();expect(menu.inert,'leaving menu still interactive')
    if(mode!=='off'){await sleep(20);expect(getComputedStyle(menu).display!=='none','popover display removed before leave')}
    await setMode('off');await sleep(30);expect(getComputedStyle(menu).display==='none','off did not release popover')
  }
  await setMode('full');const loading=ref(true),lists=ref([])
  await mount(()=>h(ProviderMusicHome,{providerLabel:'音乐',isLoggedIn:true,recsLoading:loading.value,recsError:'',recSections:[],recommendPlaylists:lists.value}))
  await flush();expect(document.querySelector('.music-skeleton'),'missing loading skeleton');lists.value=[playlist];loading.value=false;await flush()
  const content=document.querySelector('.music-content');expect(content.getAnimations().length>0,'home content did not fade after loading');await capture('provider-home-arrival');await sleep(200)
  lists.value=[playlist,{...playlist,id:'two'}];await flush();expect(document.querySelector('.music-content')===content&&content.getAnimations().length===0,'recommendation updates replayed entrance')
  app.unmount();let preferenceListener,resolveBootstrap,stateListener
  const commands=[]
  window.api={trayPlayer:{getBootstrap:()=>new Promise(resolve=>resolveBootstrap=resolve),onState:cb=>{stateListener=cb;return()=>stateListener=null},onMotionPreference:cb=>{preferenceListener=cb;return()=>preferenceListener=null},command:command=>commands.push(command),navigate:()=>{},hide:()=>{}}}
  await mount(()=>h(TrayPlayerApp));preferenceListener('off');resolveBootstrap({state:EMPTY_MINI_PLAYER_STATE,motionPreference:'full'});await flush()
  expect(root.dataset.teMotion==='off','stale tray bootstrap overwrote live preference');expect(getComputedStyle(document.querySelector('.tray-player')).transitionDuration==='0s','tray off still animated')
  preferenceListener('reduced');await flush();expect(root.dataset.teMotion==='reduced'&&getComputedStyle(document.querySelector('.tray-player')).transform==='none','tray reduced mode failed')
  for(const tone of ['pureWhite','dark']){
    root.dataset.theme=tone
    const slider=document.querySelector('.progress-slider'),button=document.querySelector('.page-actions button')
    expect(slider.disabled,tone+' empty tray incorrectly permits seeking')
    const style=getComputedStyle(slider)
    expect(slider.getBoundingClientRect().height===24&&parseFloat(style.height)-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)===4,tone+' tray range lacks a 24px target around its 4px track')
    await pressKey('Tab')
    button.focus();await flush()
    expect(button.matches(':focus-visible')&&getComputedStyle(button).outlineStyle==='solid'&&parseFloat(getComputedStyle(button).outlineWidth)===2,tone+' tray navigation has no keyboard focus ring')
    stateListener({...EMPTY_MINI_PLAYER_STATE,track:{title:'Test track',artist:'Test artist'},duration:100,currentTime:25});await flush()
    expect(!slider.disabled,tone+' loaded tray cannot seek')
    slider.focus();await pressKey('Right')
    expect(commands.at(-1)?.type==='seek'&&commands.at(-1).value>25,tone+' native keyboard seeking stopped committing')
    expect(slider.matches(':focus-visible')&&getComputedStyle(slider).outlineStyle==='solid',tone+' tray slider has no focus ring')
    const rect=slider.getBoundingClientRect()
    await ipc.invoke('control-click',{x:rect.x+rect.width*.6,y:rect.y+2});await flush()
    expect(commands.at(-1)?.type==='seek'&&commands.at(-1).value>40,tone+' padded progress target did not accept a native pointer seek')
    stateListener(EMPTY_MINI_PLAYER_STATE);await flush()
  }
  delete root.dataset.theme
  app.unmount();expect(!preferenceListener&&!stateListener,'tray leaked state or motion listener')
}
`
