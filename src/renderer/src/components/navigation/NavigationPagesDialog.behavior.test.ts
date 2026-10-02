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

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('page editing, hidden-page access, focus, dragging and theme geometry work in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-navigation-pages-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'settings.ts'),
      `import {shallowRef} from 'vue'
export const settings=shallowRef({navigationPages:{version:1,order:[],hidden:[]}})
export const useSettingsStore=()=>({settings,updateSettings:async patch=>{if(window.failSave)throw new Error('disk failure');window.writes++;settings.value={...settings.value,...patch};window.saved=JSON.stringify(settings.value)}})`
    )
    await writeFile(
      join(directory, 'music.ts'),
      `import {ref} from 'vue';export const useMusicStore=()=>({libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)})`
    )
    await writeFile(join(directory, 'import.ts'), `export default {render:()=>null}`)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [vue()],
      resolve: {
        alias: {
          '/icon.png': join(workspace, 'resources/icon.png'),
          '@renderer/stores/useSettingsStore': join(directory, 'settings.ts'),
          '@renderer/stores/useMusicStore': join(directory, 'music.ts'),
          '@renderer/components/ImportDialog.vue': join(directory, 'import.ts'),
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
          name: 'NavigationPagesTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    const shellStyles = (await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
      .split('<style>')[1]
      .split('</style>')[0]
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite" data-te-navigation-style="expanded"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>${shellStyles}</style><style>body{margin:0;font:var(--te-font-size-body,14px) system-ui}#opener{position:fixed;left:250px;top:20px}#app{--te-side-menu-bottom:84px;--te-shell-navigation-display:block;--te-shell-compact-navigation-display:none}.playbar-fixture{position:fixed;bottom:0;left:0;right:0;height:84px;background:var(--te-card-bg);border-top:1px solid var(--te-card-border)}</style></head><body><button id="opener">页面菜单</button><div id="app"></div><div class="playbar-fixture"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{
await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runNavigationTests()');
if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,{recursive:true});for(const tone of ['pureWhite','dark'])for(const expanded of [false,true]){await win.webContents.executeJavaScript('window.prepareSidebarPreview('+JSON.stringify({tone,expanded})+')');fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'grouped-'+tone+'-'+expanded+'.png'),(await win.webContents.capturePage()).toPNG())}}
for(const width of [1280,760])for(const tone of ['pureWhite','dark'])for(const bottom of [52,84,124]){win.setSize(width,820);await win.webContents.executeJavaScript('window.checkNavigationGeometry('+JSON.stringify({width,tone,bottom})+')');if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,width+'-'+tone+'-'+bottom+'.png'),(await win.webContents.capturePage()).toPNG())}}
await win.webContents.executeJavaScript('window.checkNavigationStyles()');await win.webContents.executeJavaScript('window.openNavigationEditor()');if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS)fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'editor-760-dark.png'),(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript('window.checkCustomNavigation()');
console.log('NAVIGATION_PAGES_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /NAVIGATION_PAGES_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import {BUILTIN_NAVIGATION_PAGES} from '@renderer/app/navigationPages.ts'
import {useSettingsStore} from '@renderer/stores/useSettingsStore'
import {useSongListSearch} from '@renderer/components/song-list/useSongListSearch'
import '@renderer/assets/main.css'
import '@renderer/assets/icon-fonts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(delay=35)=>new Promise(resolve=>setTimeout(resolve,delay))
const button=label=>[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===label||node.textContent.trim()===label)
const aria=label=>document.querySelector('[aria-label="'+label+'"]')
let visible=ref(true),open=ref(true),selected='',active=ref('local-home'),app,queries,key
const store=useSettingsStore()
const mount=()=>{app=createApp({setup(){key=ref('songs');queries=useSongListSearch(key);return()=>visible.value?h('div',{class:['app-shell-navigation',{'navigation-temporary':open.value}]},h(SideMenu,{open:open.value,activeKey:active.value,onSelectPage:page=>{selected=page.id;active.value=page.id}})):null}});app.mount('#app')}
const dialog=()=>document.querySelector('dialog')
window.runNavigationTests=async()=>{
  window.writes=0;mount();await pause(350)
  queries.searchQuery.value='moon';await pause(200);key.value='albums';await nextTick();expect(queries.searchQuery.value==='','search leaked to a different page');queries.searchQuery.value='album';await nextTick();key.value='songs';await nextTick();expect(queries.searchQuery.value==='moon'&&queries.debouncedSearchQuery.value==='moon','page search did not restore')
  expect(button('主页')&&button('流媒体音乐')&&button('音乐库'),'primary hierarchy missing')
  expect(button('流媒体音乐').getAttribute('aria-expanded')==='false'&&button('音乐库').getAttribute('aria-expanded')==='false','groups should start tucked away on home')
  button('流媒体音乐').click();await nextTick();expect(button('音乐云盘').getBoundingClientRect().height>0&&selected==='','expanding streaming navigated or omitted cloud')
  button('发现歌单').click();await nextTick();expect(selected==='discover'&&open.value&&button('流媒体音乐').getAttribute('aria-expanded')==='true','child navigation closed the menu')
  button('流媒体音乐').click();await nextTick();expect(selected==='discover'&&button('流媒体音乐').classList.contains('active'),'collapsed branch loses selected page')
  active.value='library';await nextTick();expect(button('流媒体音乐').getAttribute('aria-expanded')==='true','external navigation did not reveal active child')
  button('音乐库').focus();button('音乐库').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await nextTick();await nextTick();expect(document.activeElement===button('所有歌曲'),'keyboard expansion did not focus first child')
  button('所有歌曲').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await nextTick();expect(document.activeElement===button('音乐库')&&button('音乐库').getAttribute('aria-expanded')==='false','keyboard collapse did not restore branch focus')
  button('导入歌曲').focus();button('导入歌曲').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));expect(document.activeElement===button('全部页面'),'toolbar arrow navigation failed')
  active.value='local-home';selected='';await nextTick()
  const opener=button('编辑页面');opener.focus();opener.click();await pause(150)
  expect(dialog().matches(':modal'),'editor is not modal')
  aria('下移主页').click();aria('显示搜索').click();button('取消').click();await pause()
  expect(window.writes===0&&selected==='','cancel wrote settings or navigated')
  expect(document.activeElement===opener,'editor did not restore focus')
  opener.click();await pause();expect(aria('显示搜索').checked,'cancel retained hidden state')
  const first=document.querySelector('[data-reorder-id="local-home"] .drag-handle'),second=document.querySelector('[data-reorder-id="streaming-home"]')
  const a=first.getBoundingClientRect(),b=second.getBoundingClientRect()
  first.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,isPrimary:true,bubbles:true,clientX:a.x+3,clientY:a.y+3}))
  document.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,isPrimary:true,bubbles:true,cancelable:true,clientX:b.x+100,clientY:b.y+30}))
  document.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,isPrimary:true,bubbles:true,clientX:b.x+100,clientY:b.y+30}))
  await nextTick();expect(document.querySelector('[data-reorder-id]').dataset.reorderId==='streaming-home','handle drag failed')
  aria('上移主页').focus();aria('上移主页').click();await nextTick();expect(document.querySelector('[data-reorder-id]').dataset.reorderId==='local-home','keyboard-accessible move failed')
  window.failSave=true;button('保存').click();await pause();expect(dialog()&&dialog().querySelector('[role=alert]').textContent.includes('disk failure')&&window.writes===0,'failed save closed the editor or wrote preferences');window.failSave=false
  for(const input of dialog().querySelectorAll('input[type=checkbox]'))if(input.checked)input.click()
  button('保存').click();await pause();expect(window.writes===1&&document.querySelectorAll('.menu-nav [aria-current]').length===0,'hide-all failed')
  const saved=window.saved;app.unmount();store.settings.value=JSON.parse(saved);mount();await pause()
  expect(button('全部页面')&&button('编辑页面')&&!button('主页'),'hidden page appeared after remount')
  button('全部页面').focus();button('全部页面').click();await pause();const search=aria('搜索页面');expect(document.activeElement===search,'directory did not focus search')
  search.value='网络';search.dispatchEvent(new Event('input',{bubbles:true}));await nextTick();expect(dialog().querySelectorAll('.page-destination').length===1,'directory filtering failed');dialog().querySelector('.page-destination').click();await pause()
  expect(selected==='network'&&window.writes===1&&store.settings.value.navigationPages.hidden.length===16,'opening hidden page changed configuration')
  button('编辑页面').click();await pause();button('恢复默认').click();button('保存').click();await pause();expect(button('主页')&&button('流派')&&button('音乐云盘'),'restore defaults failed')
  open.value=false;await nextTick();expect(document.querySelector('.side-menu').inert,'closed sidebar remains interactive');open.value=true;await pause()
  document.documentElement.dataset.teShellLayout='custom';document.documentElement.dataset.teShellNavigation='persistent';open.value=false;await pause();expect(!document.querySelector('.side-menu').inert,'persistent shell is inert');delete document.documentElement.dataset.teShellLayout;delete document.documentElement.dataset.teShellNavigation;open.value=true
  store.settings.value={navigationPages:{version:1,order:BUILTIN_NAVIGATION_PAGES.map(page=>page.id),hidden:[]}}
  await nextTick();for(const label of ['流媒体音乐','音乐库'])if(button(label).getAttribute('aria-expanded')==='false')button(label).click();await nextTick()
}
window.checkNavigationGeometry=async({width,tone,bottom})=>{
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','21px');document.querySelector('#app').style.setProperty('--te-side-menu-bottom',bottom+'px');document.querySelector('.playbar-fixture').style.height=bottom+'px';await pause(350)
  const prefs=JSON.stringify(store.settings.value.navigationPages),menu=document.querySelector('.side-menu'),nav=menu.querySelector('.menu-nav'),footer=menu.querySelector('.menu-bottom')
  expect(menu.getBoundingClientRect().bottom<=window.innerHeight-bottom+1,'sidebar overlaps playbar');expect(footer.getBoundingClientRect().bottom<=menu.getBoundingClientRect().bottom+1,'fixed tools leave sidebar');expect(nav.scrollHeight>nav.clientHeight,'large text directory does not scroll independently')
  for(const label of ['主页','流媒体音乐','音乐库','我的音乐库']){const text=button(label).querySelector('.item-label');expect(text.scrollWidth<=text.clientWidth,'large-text navigation label is truncated: '+label)}
  button('编辑页面').click();await pause();expect(dialog().getBoundingClientRect().right<=width&&dialog().getBoundingClientRect().bottom<=window.innerHeight,'dialog overflows narrow window');button('取消').click();await pause();expect(JSON.stringify(store.settings.value.navigationPages)===prefs,'theme/layout changed saved preferences')
}
window.prepareSidebarPreview=async({tone,expanded})=>{
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','14px')
  for(const label of ['流媒体音乐','音乐库'])if((button(label).getAttribute('aria-expanded')==='true')!==expanded)button(label).click()
  await pause(350)
}
window.checkNavigationStyles=async()=>{
  for(const style of ['compact','rail']){
    document.documentElement.dataset.teNavigationStyle=style;await pause(350)
    const menu=document.querySelector('.side-menu').getBoundingClientRect()
    for(const target of document.querySelectorAll('.menu-toolbar button')){const rect=target.getBoundingClientRect();expect(rect.left>=menu.left&&rect.right<=menu.right&&rect.bottom<=menu.bottom,'toolbar overflows '+style)}
    button('流媒体音乐').focus();button('流媒体音乐').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await nextTick();button('流媒体音乐').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await nextTick();await nextTick();expect(document.activeElement===button('推荐主页'),'group keyboard navigation fails in '+style)
  }
  document.documentElement.dataset.teNavigationStyle='expanded';await pause(350)
}
window.openNavigationEditor=async()=>{button('编辑页面').click();await pause(150)}
window.checkCustomNavigation=async()=>{
  button('取消').click();document.documentElement.dataset.teShellLayout='custom'
  for(const mode of ['hidden','persistent']){
    document.documentElement.dataset.teShellNavigation=mode;open.value=false;await pause();expect(getComputedStyle(document.querySelector('.app-shell-navigation')).display==='none','compact shell navigation was not hidden')
    open.value=true;await pause(350);const wrapper=document.querySelector('.app-shell-navigation'),menu=document.querySelector('.side-menu'),rect=menu.getBoundingClientRect()
    expect(getComputedStyle(wrapper).display!=='none'&&getComputedStyle(wrapper).position==='fixed'&&rect.width>100&&rect.right>100,'custom compact shell cannot open temporary navigation')
    expect(rect.bottom<=window.innerHeight-124+1,'custom compact navigation overlaps playbar')
  }
  delete document.documentElement.dataset.teShellLayout;delete document.documentElement.dataset.teShellNavigation
}
`
