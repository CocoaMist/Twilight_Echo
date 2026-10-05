import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import { compileStyle } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
const workspace = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('source menus preserve behavior and streaming controls follow readable theme colors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-native-menu-'))
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
          name: 'MenuRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    const pageStyles = compileStyle({
      source: await readFile(
        new URL('./streaming-page/StreamingPage.css', import.meta.url),
        'utf8'
      ),
      filename: 'StreamingPage.css',
      id: 'data-v-content-theme',
      scoped: true
    })
    assert.deepEqual(pageStyles.errors, [])
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>${pageStyles.code}\n.theme-probe{display:block;overflow-y:auto}.theme-probe *{animation:none!important;transition:none!important}.theme-probe .library-view{padding:12px;min-height:0}.theme-probe .favorites-cover{transform:none}.theme-probe .btn-play{transform:none}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:720,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
      try {
        await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runMenuTests()');
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('DOM.enable');
        await win.webContents.debugger.sendCommand('CSS.enable');
        const luminance=channels=>{const linear=channels.map(value=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4});return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722}
        for(const dark of [false,true])for(const custom of [false,true])for(const transparent of [false,true]){
          const probes=await win.webContents.executeJavaScript('window.prepareContentThemeProbe('+JSON.stringify({dark,custom,transparent})+')');
          const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');
          const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'.search-tab-pill:not(.active):not(.disabled)'});
          // Hidden windows cannot reliably receive keyboard focus; exercise Chromium's focus-visible style directly.
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['focus-visible']});
          const ring=await win.webContents.executeJavaScript('(()=>{const style=getComputedStyle(document.querySelector(".search-tab-pill:not(.active):not(.disabled)"));return {style:style.outlineStyle,width:style.outlineWidth}})()');
          if(ring.style!=='solid'||Number.parseFloat(ring.width)<2)throw new Error('Keyboard focus ring missing: '+JSON.stringify(ring));
          for(const probe of probes){
            const point=await win.webContents.executeJavaScript('(async()=>{const el=document.querySelector('+JSON.stringify(probe.selector)+');el.scrollIntoView({block:"center"});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const rect=el.getBoundingClientRect();return {x:Math.floor(rect.x+rect.width/2),y:Math.floor(rect.y+rect.height/2)}})()');
            const pixel=(await win.webContents.capturePage({x:point.x,y:point.y,width:1,height:1})).toBitmap();
            const background=luminance([pixel[2],pixel[1],pixel[0]]),ink=luminance(probe.color);
            const ratio=(Math.max(background,ink)+0.05)/(Math.min(background,ink)+0.05);
            if(ratio<4.5)throw new Error(JSON.stringify({dark,custom,transparent,control:probe.name,ratio,pixel:[...pixel],ink:probe.color}));
          }
        }
        console.log('MENU_OK');app.exit(0)
      }
      catch(e){console.error(e.stack);app.exit(1)}
    })`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60000 }
    )
    assert.match(result.stdout, /MENU_OK/)
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') ||
        resolve(directory).startsWith(resolve(tmpdir()) + '/')
    )
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick} from 'vue'
import NativeMenu from '@renderer/components/NativeContextMenu.vue'
import Library from '@renderer/components/StreamingLibrary.vue'
import Header from '@renderer/components/streaming-page/StreamingContentHeader.vue'
import SearchControls from '@renderer/components/streaming-page/StreamingSearchControls.vue'
import Placeholder from '@renderer/components/streaming-page/StreamingPlaceholder.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=()=>new Promise(r=>setTimeout(r,60))
window.runMenuTests=async()=>{
  let request,complete,clicked=0,closed=0,cancelled
  window.api={window:{popupContextMenu:value=>{request=value;return new Promise(r=>complete=r)},closeContextMenu:async id=>{cancelled=id}}}
  let app=createApp({render:()=>h(NativeMenu,{onClose:()=>closed++},()=>[
    h('div',{class:'menu-item'},['添加到歌单',h('div',{class:'submenu'},[
      h('button',{onClick:()=>clicked++},'R&B 歌单'),h('button',{disabled:true},'不可用')])])])})
  app.mount('#app');await nextTick()
  expect(request.items[0].label==='添加到歌单','submenu labels polluted the parent: '+JSON.stringify(request))
  expect(request.items[0].submenu[0].label==='R&B 歌单','submenu missing')
  expect(request.items[0].submenu[1].enabled===false,'disabled action lost')
  expect(document.querySelector('#app > div').getBoundingClientRect().height===0,'native definition became an HTML menu')
  complete(request.items[0].submenu[0].id);await pause()
  expect(clicked===1 && closed===1,'native selection was not dispatched once')
  app.unmount()
  app=createApp({render:()=>h(NativeMenu,{},()=>h('button',{onClick:()=>clicked++},'播放'))});app.mount('#app');await nextTick()
  const pending=request.requestId;app.unmount();expect(cancelled===pending,'unmount did not cancel native menu')
  complete(request.items[0].id);await pause();expect(clicked===1,'late native selection ran after unmount')
  const options=Array.from({length:25},(_,i)=>({id:String(i),name:'音源 '+i,icon:'pi pi-music',loggedIn:false}))
  let selected
  app=createApp({render:()=>h('div',{style:'height:150px;overflow:hidden;transform:translateZ(0)'},[
    h(Library,{isLoggedIn:false,profile:null,profileSignature:'',likedSummary:{name:'喜欢',trackCount:0,cover:null},libraryLoaded:false,userPlaylistEntries:[],showLikedPanel:false,availableProviders:options,activeProvider:'0',onSwitchProvider:id=>selected=id})])})
  app.mount('#app');await nextTick()
  const events=[];window.addEventListener('scroll',e=>events.push('scroll:'+e.target.nodeName),true);document.querySelector('.provider-menu').addEventListener('beforetoggle',e=>events.push(e.oldState+'>'+e.newState));
  await pause();document.querySelector('.provider-switch-btn').focus();document.querySelector('.provider-switch-btn').click();await pause()
  let menu=document.querySelector('.provider-menu')
  expect(menu.matches(':popover-open'),'library menu is not in the top layer: '+events.join(','))
  expect(menu.scrollHeight>menu.clientHeight,'long source menu cannot scroll')
  menu.scrollTop=menu.scrollHeight;await pause()
  expect(menu.matches(':popover-open') && menu.scrollTop>0,'scroll closes the menu')
  const last=menu.querySelector('button:last-child'),rect=last.getBoundingClientRect()
  expect(document.elementFromPoint(rect.x+20,rect.y+10) && last.contains(document.elementFromPoint(rect.x+20,rect.y+10)),'source menu clipped by profile card')
  last.click();await pause();expect(selected==='24','last source not selectable')
  app.unmount()
  app=createApp({render:()=>h(Header,{isDetail:false,isSearching:false,showSubtitle:true,title:'主页',subtitle:'未登录',showUnifiedSearch:false,searchQuery:'',searchLoading:false,providerId:'0',providerOptions:options,onSelectProvider:id=>selected=id})})
  app.mount('#app');await nextTick()
  await pause();document.querySelector('.provider-switcher-trigger').focus();document.querySelector('.provider-switcher-trigger').click();await pause()
  menu=document.querySelector('.provider-switcher-menu');expect(menu.matches(':popover-open'),'logged out header has no source switcher')
  menu.scrollTop=menu.scrollHeight;await pause()
  expect(menu.matches(':popover-open'),'header menu closes on its own scroll')
  menu.querySelector('button:last-child').click();await pause();expect(selected==='24','header source selection failed')
  app.unmount()
}
let contentApp=null
window.prepareContentThemeProbe=async({dark,custom,transparent})=>{
  contentApp?.unmount()
  const root=document.documentElement
  root.dataset.theme=dark?'dark':'pureWhite'
  root.dataset.windowTransparent=transparent?'on':'off'
  for(const name of ['--te-neutral-900','--te-neutral-700','--te-neutral-500','--te-card-bg','--te-primary-500','--te-glass-bg','--te-tp-card'])root.style.removeProperty(name)
  const palette=dark?{ink:'#eefaf7',muted:'#c4e6db',card:'#142725',accent:'#7fe1ad'}:{ink:'#102018',muted:'#294738',card:'#edf8f4',accent:'#17643d'}
  if(custom)for(const [name,value] of Object.entries({'--te-neutral-900':palette.ink,'--te-neutral-700':palette.muted,'--te-neutral-500':palette.muted,'--te-card-bg':palette.card,'--te-primary-500':palette.accent,'--te-glass-bg':palette.card,'--te-tp-card':palette.card}))root.style.setProperty(name,value)
  const whiteCover='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><path fill="white" d="M0 0h140v140H0z"/></svg>')
  const events=[]
  contentApp=createApp({render:()=>h('div',{class:'streaming-page theme-probe','data-v-content-theme':''},[
    h(SearchControls,{searchType:'songs',availableSearchTypes:['songs','playlists'],searchSource:'all',searchSources:[{id:'all',label:'全部音源',available:true},{id:'local',label:'本地音源',available:true}],onSelectSource:id=>events.push(id),'onUpdate:searchType':type=>events.push(type)}),
    h(Library,{isLoggedIn:false,profile:null,profileSignature:'',likedSummary:{name:'喜欢',trackCount:0,cover:whiteCover},libraryLoaded:false,userPlaylistEntries:[],showLikedPanel:true,availableProviders:[]}),
    h(Placeholder,{title:'搜索音乐',hint:'输入关键词后开始搜索',icon:'pi pi-search',danger:custom,detail:custom,actionLabel:'重试',actionIcon:'pi pi-refresh',onAction:()=>events.push('retry')})
  ])})
  contentApp.mount('#app');await nextTick();await pause()
  const normal=document.querySelector('.search-tab-pill:not(.active):not(.disabled)')
  const active=document.querySelector('.search-tab-pill.active')
  const disabled=document.querySelector('.search-tab-pill.disabled')
  const expected=variable=>{const el=document.createElement('span');el.style.color='var('+variable+')';document.body.append(el);const value=getComputedStyle(el).color;el.remove();return value}
  expect(getComputedStyle(normal).color===expected('--te-neutral-700'),'search text ignored theme token')
  expect(getComputedStyle(active).backgroundColor===expected('--te-neutral-900'),'selected search surface ignored theme token: '+JSON.stringify({dark,custom,transparent,actual:getComputedStyle(active).backgroundColor,expected:expected('--te-neutral-900')}))
  expect(getComputedStyle(active).color===expected('--te-card-bg'),'selected search text ignored theme token')
  expect(disabled.getAttribute('aria-disabled')==='true'&&disabled.tabIndex===-1&&Number(getComputedStyle(disabled).opacity)<0.6,'disabled state is not preserved')
  disabled.click();expect(events.length===0,'disabled tab changed search type')
  normal.click();expect(events.at(-1)==='playlists','enabled tab stopped dispatching')
  document.querySelector('.search-source-trigger').click();await nextTick()
  const option=document.querySelector('.search-source-option:last-child')
  option.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));expect(events.at(-1)==='local','source menu dispatch broke')
  const panel=document.querySelector('.streaming-placeholder'),panelStyles=getComputedStyle(panel)
  expect(panelStyles.boxShadow==='none'&&panelStyles.backdropFilter==='none','empty panel regained projection or blur: '+JSON.stringify({dark,custom,transparent,shadow:panelStyles.boxShadow,blur:panelStyles.backdropFilter}))
  expect(panelStyles.backgroundColor===expected('--te-card-bg'),'empty panel ignored theme background')
  expect(Number.parseFloat(panelStyles.minHeight)===(custom?420:260),'detail empty-state sizing changed')
  expect(getComputedStyle(panel.querySelector('.placeholder-title')).color===expected('--te-neutral-900'),'empty title ignored theme text')
  expect(getComputedStyle(panel.querySelector('.placeholder-hint')).color===expected('--te-neutral-500'),'empty hint ignored theme secondary text')
  expect(getComputedStyle(panel.querySelector('.placeholder-icon')).color===expected(custom?'--te-danger-soft-fg':'--te-neutral-500'),'empty icon ignored semantic color')
  expect(getComputedStyle(panel.querySelector('.placeholder-icon')).backgroundColor==='rgba(0, 0, 0, 0)','empty icon regained a colored square background')
  panel.querySelector('.stream-action-btn').click();expect(events.at(-1)==='retry','empty-state action stopped dispatching')
  document.querySelector('.search-source-trigger').blur()
  await nextTick();await pause()
  const probes=[]
  for(const [name,selector,inkSelector] of [['library-play','.btn-play','.btn-play'],['library-heart','.heart-icon','.heart-icon .ph-fill'],['active-tab','.search-tab-pill.active','.search-tab-pill.active'],['empty-title','.placeholder-title','.placeholder-title'],['empty-hint','.placeholder-hint','.placeholder-hint'],['empty-action','.stream-action-btn','.stream-action-btn']]){
    const el=document.querySelector(selector),ink=document.querySelector(inkSelector)
    const styles=getComputedStyle(ink)
    probes.push({name,selector,color:styles.color.match(/[0-9.]+/g).slice(0,3).map(Number)})
    // Leave the real painted background unobscured for the Electron pixel sample.
    for(const child of el.children)child.style.visibility='hidden'
    if(name!=='library-heart')el.style.color='transparent'
  }
  await pause()
  return probes
}
`
