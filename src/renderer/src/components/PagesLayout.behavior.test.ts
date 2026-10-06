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
import { compileStyle } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('page headers share content axes, remain below chrome, and long network lists are reachable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-pages-layout-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'stores.ts'), stores)
    await writeFile(join(directory, 'api.ts'), api)
    await writeFile(
      join(directory, 'song.ts'),
      `import {h} from 'vue';export default {render:()=>h('section',{class:'song-list'})}`
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: /^.*\/stores\/use(?:Music|Player|Provider|Settings)Store(?:\.ts)?$/,
            replacement: join(directory, 'stores.ts')
          },
          { find: /^.*\/components\/SongList\.vue$/, replacement: join(directory, 'song.ts') },
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
          name: 'PageLayoutTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    const pageStyles = compileStyle({
      source: (
        await readFile(new URL('./streaming-page/StreamingPage.css', import.meta.url), 'utf8')
      ).replace(/^\uFEFF/, ''),
      filename: 'StreamingPage.css',
      id: 'data-v-page-layout',
      scoped: true
    })
    assert.deepEqual(pageStyles.errors, [])
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>${pageStyles.code}\nhtml,body,#app{height:100%;margin:0}#app{overflow:hidden}*{animation:none!important;transition:none!important}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
      try{await win.loadFile(process.argv.at(-1));let count=0;
        for(const width of [1280,800,560])for(const sidebar of [0,240])for(const dark of [false,true]){
          win.setContentSize(width,900);await win.webContents.executeJavaScript('window.runPageLayoutTests('+JSON.stringify({sidebar,dark,custom:false})+')');count++;
        }
        await win.webContents.executeJavaScript('window.runPageLayoutTests('+JSON.stringify({sidebar:0,dark:true,custom:true})+')');count++;
        console.log('PAGES_LAYOUT_OK '+count);app.exit(0)
      }catch(error){console.error(error.stack);app.exit(1)}
    })`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90000 }
    )
    assert.match(result.stdout, /PAGES_LAYOUT_OK 13/)
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') ||
        resolve(directory).startsWith(resolve(tmpdir()) + '/')
    )
    await rm(directory, { recursive: true, force: true })
  }
})

const api = `window.api={networkSources:{listProfiles:async()=>Array.from({length:35},(_,i)=>({id:String(i),name:'测试来源 '+i,protocol:'webdav',host:'nas.example',port:null,rootPath:'/music',credentialKind:'anonymous',bookmarks:[],options:{readOnly:true},createdAt:0,lastConnectedAt:null})),cacheInfo:async()=>({sizeBytes:0})},radio:{loadStations:async()=>({revision:0,data:{version:1,stations:[]}})},podcast:{loadSubscriptions:async()=>({revision:0,data:{version:1,subscriptions:[]}})}}`

const stores = `import {shallowRef} from 'vue'
const none=()=>{},empty=shallowRef([]),currentTrack=shallowRef(null),settings=shallowRef({trackActivationMode:'doubleClick'})
export const usePlayerStore=()=>({currentTrack,playTrack:none,playTrackFromPosition:none})
export const useSettingsStore=()=>({settings})
export const useMusicStore=()=>({tracks:empty,artists:empty,aggregatePlaylists:empty,getPlaylistTracksById:()=>[],createAggregatePlaylist:none,addTracksToPlaylistById:none,deletePlaylist:none,setPlaylistPinned:none,setPlaylistHiddenSources:none,setPlaylistVariantPreference:none,removeTracksFromPlaylistById:none})
export const useProviderStore=()=>({providers:empty,syncProviders:async()=>{},getProvider:()=>null})`

const runtime = `import './api'
import '@renderer/assets/base.css'
import {createApp,h,nextTick} from 'vue'
import Header from '@renderer/components/streaming-page/StreamingContentHeader.vue'
import Search from '@renderer/components/streaming-page/StreamingSearchControls.vue'
import Network from '@renderer/components/NetworkSourcesPage.vue'
import Radio from '@renderer/components/RadioPodcastPage.vue'
import Aggregate from '@renderer/components/aggregate-playlist/AggregatePlaylistPage.vue'
import Analytics from '@renderer/components/ListeningAnalyticsPage.vue'
import Recent from '@renderer/components/navigation/RecentPlaybackPage.vue'
import Playlists from '@renderer/components/navigation/ApplicationPlaylistsPage.vue'
const expect=(ok,message)=>{if(!ok)throw new Error(message)}
const rect=selector=>{const node=document.querySelector(selector);expect(node,'missing layout element '+selector);return node.getBoundingClientRect()}
const near=(a,b,message)=>expect(Math.abs(a-b)<1.5,message+': '+a+' != '+b)
const tick=async()=>{await nextTick();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
let app
const mount=async(component,props,sidebar,custom)=>{app?.unmount();app=createApp({render:()=>h('div',{style:{height:custom?'700px':'100vh',marginLeft:sidebar+'px',width:'calc(100% - '+sidebar+'px)',overflow:'hidden'}},[h(component,props)])});app.mount('#app');await tick()}
window.runPageLayoutTests=async({sidebar,dark,custom})=>{
  const html=document.documentElement;html.dataset.theme=dark?'dark':'pureWhite';html.dataset.teShellLayout=custom?'custom':'classic';html.style.setProperty('--te-titlebar-inset','35px');html.style.setProperty('--te-playbar-bottom-clearance','96px');
  const top=custom?20:55;
  for(const [component,root,head,body] of [[Network,'.network-sources-page','.network-page-heading','.network-profiles'],[Radio,'.radio-podcast-page','.page-header','.radio-workspace'],[Aggregate,'.aggregate-page','.aggregate-header','.aggregate-grid'],[Analytics,'.analytics-page','.journal-header','.journal-empty']]){
    await mount(component,{hasPlayer:true},sidebar,custom);
    near(rect(head).y,top,'header repeats chrome inset '+root);
    near(rect(head).x,rect(body).x,'heading/content axes differ '+root);
    const page=document.querySelector(root);expect(page.scrollWidth<=page.clientWidth+1,'horizontal page overflow '+root);
    for(const button of document.querySelectorAll(head+' button')){const box=button.getBoundingClientRect();expect(box.x>=sidebar-1 && box.right<=innerWidth+1,'header action clipped '+root)}
    if(component===Network){
      expect(page.scrollHeight>page.clientHeight,'long network list has no vertical overflow');page.scrollTop=page.scrollHeight;await tick();
      const last=document.querySelector('.network-profile-card:last-child'),box=last.getBoundingClientRect();expect(box.bottom<=(custom?700-31:innerHeight-95),'last network source under player');
      const button=last.querySelector('button'),b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);expect(button===hit||button.contains(hit),'last network source action is unreachable');
      button.focus();expect(document.activeElement===button,'last network source cannot receive keyboard focus');
    }
  }
  const Streaming={render:()=>h('div',{class:'streaming-page','data-v-page-layout':''},[h('div',{class:'streaming-content','data-v-page-layout':'',style:{paddingLeft:sidebar+'px'}},[
    h(Header,{'data-v-page-layout':'',isDetail:false,isSearching:true,showSubtitle:false,title:'搜索音乐和歌单',subtitle:'',showUnifiedSearch:true,searchQuery:'',searchLoading:false,providerId:'fixture',providerOptions:[{id:'fixture',name:'测试音源',icon:'pi pi-music',loggedIn:false}]}),
    h(Search,{'data-v-page-layout':'',searchType:'songs',availableSearchTypes:['songs','playlists','artists','albums'],searchSource:'all',searchSources:[{id:'all',name:'全部音源',available:true}]}),
    h('div',{class:'streaming-content-body','data-v-page-layout':''},[h('p',{class:'body-start'},'结果')])])])}
  await mount(Streaming,{},sidebar,false);
  near(rect('.streaming-content-header').y,top,'streaming header repeats chrome inset');
  const title=rect('.streaming-content-title'),tab=rect('.search-type-group'),body=rect('.body-start');near(title.x,tab.x,'streaming tabs shifted');near(title.x,body.x,'streaming results shifted');
  const stream=document.querySelector('.streaming-content');expect(stream.scrollWidth<=stream.clientWidth+1,'streaming actions overflow available pane '+JSON.stringify({width:innerWidth,sidebar,scroll:stream.scrollWidth,client:stream.clientWidth,root:rect('.streaming-page').toJSON(),position:getComputedStyle(document.querySelector('.streaming-page')).position,header:rect('.streaming-content-header').toJSON(),right:rect('.streaming-header-right').toJSON(),search:rect('.streaming-search-box').toJSON(),tabs:rect('.streaming-search-tabs').toJSON(),group:rect('.search-type-group').toJSON()}));
  if(innerWidth-sidebar<900)expect(rect('.streaming-header-right').y>=title.bottom,'toolbar fails to stack inside narrowed pane');
  await mount(Recent,{hasPlayer:true,active:true,target:{kind:'recent',scope:'platform'}},sidebar,custom);
  near(rect('.recent-scope-tabs button').y,top,'recent tabs repeat chrome inset');near(rect('.recent-scope-tabs button').x,rect('.platform-history header').x,'recent tabs/title differ');
  const tabs=rect('.recent-scope-tabs'),history=rect('.platform-history header');expect(history.y-tabs.bottom>=19 && history.y-tabs.bottom<22,'recent child duplicates top inset');
  await mount(Playlists,{category:'aggregate',filter:null,hasPlayer:true,transitionName:'page-down',returnFromDetail:()=>{}},sidebar,custom);
  for(let n=0;n<30&&!document.querySelector('.aggregate-header');n++)await tick();
  near(rect('.playlist-tabs button').y,top,'playlist tabs repeat chrome inset');near(rect('.playlist-tabs button').x,rect('.aggregate-header').x,'playlist tabs/title differ');
  const pt=rect('.playlist-tabs'),ah=rect('.aggregate-header');expect(ah.y-pt.bottom>=19&&ah.y-pt.bottom<22,'playlist child duplicates top inset');
  app.unmount();app=null;
}`
