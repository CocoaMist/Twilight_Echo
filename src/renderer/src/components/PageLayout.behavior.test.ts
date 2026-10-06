import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
const pages = [
  ['home', 'home-inner', 'LocalDashboard.css'],
  ['archive-home', 'archive-page', 'local-dashboard/ArchiveHome.css'],
  ['night-harbor', 'nh-page', 'local-dashboard/NightHarborHome.css'],
  ['sound-field', 'sf-layout', 'local-dashboard/SoundFieldHome.css'],
  ['online-home', 'online-home-inner', 'local-dashboard/OnlineHome.css'],
  ['song-list', 'table-view', 'song-list/SongList.css']
]

test('actual page CSS keeps safe areas and content-width reflow in native Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-page-layout-'))
  try {
    const base = await readFile(new URL('../assets/base.css', import.meta.url), 'utf8')
    const styles = await Promise.all(
      pages.map(async ([, , path]) => {
        const source = await readFile(new URL(path, import.meta.url), 'utf8')
        const result = compileStyle({ source, filename: path, id: 'data-v-layout', scoped: true })
        assert.deepEqual(result.errors, [])
        return result.code
      })
    )
    const dashboard = await readFile(new URL('LocalDashboard.vue', import.meta.url), 'utf8')
    assert.match(dashboard, /class="masthead-shuffle"[\s\S]*?@click="shuffleAll"/)
    const list = await readFile(new URL('SongList.vue', import.meta.url), 'utf8')
    assert.match(list, /v-if="showDetailBackButton"[\s\S]*?class="detail-back-button"/)
    await writeFile(
      join(directory, 'index.html'),
      `<style>${base}\n${styles.join('\n')}
      html,body{margin:0;height:100%;overflow:hidden}#pane{height:100%;margin-left:auto}
      .song-list{height:100%}.layout-filler{height:1100px;grid-column:1/-1}
      </style><div id="pane"></div><script>${runtime}</script>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'user-data'));
      app.whenReady().then(async()=>{try{
        const win=new BrowserWindow({show:false,width:1360,height:900,webPreferences:{backgroundThrottling:false}});
        await win.loadFile(process.argv.at(-1));
        for(const width of [1360,800]){
          win.setContentSize(width,900);
          for(const tone of ['pureWhite','dark'])for(const font of [14,28])
            await win.webContents.executeJavaScript('window.checkPageLayout('+JSON.stringify({width})+'.width,'+JSON.stringify(tone)+','+font+')');
        }
        console.log('PAGE_LAYOUT_OK');app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1)}});`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 30_000 }
    )
    assert.match(result.stdout, /PAGE_LAYOUT_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `
const pages=${JSON.stringify(pages)};
const expect=(value,message)=>{if(!value)throw new Error(message)};
const near=(value,target,message)=>expect(Math.abs(value-target)<1,message+': '+value+' expected '+target);
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const flushLayout=()=>document.documentElement.getBoundingClientRect();
const pane=document.querySelector('#pane');
const title='我们的音乐';
function mount(rootClass,innerClass){
  pane.innerHTML='<section class="'+rootClass+'"><main class="'+innerClass+'"></main></section>';
  const root=pane.firstElementChild,inner=root.firstElementChild;
  if(rootClass==='home')inner.innerHTML='<header class="masthead"><div class="masthead-copy"><p class="masthead-kicker">本地音乐库</p><h1 class="masthead-title">'+title+'</h1></div><button class="masthead-shuffle"><span class="masthead-shuffle-icon">↻</span><span class="masthead-shuffle-label">随机播放</span></button></header><section class="feature-card"><div class="hero-inner"><div class="hero-copy"><h2 class="hero-title">一首很长的曲名，需要完整显示并且自然换行</h2><p class="hero-artist">音乐人</p></div><div class="hero-art"></div></div></section>';
  if(rootClass==='song-list')inner.innerHTML='<header class="song-list-header"><div class="header-left"><button class="detail-back-button" data-te-back-button="pill">返回</button><div class="title-group"><h1 class="song-list-title">'+title+'</h1></div></div><div class="header-right"><div class="search-box"><input class="search-input" placeholder="搜索"></div></div></header><div class="library-play-actions"><button>播放全部</button></div><div class="card-grid"><article>第一张专辑</article><article>第二张专辑</article><article>第三张专辑</article></div>';
  inner.insertAdjacentHTML('beforeend','<div class="layout-filler"></div><div class="layout-last">最后一项</div>');
  for(const node of pane.querySelectorAll('*'))node.setAttribute('data-v-layout','');
  return {root,inner};
}
window.checkPageLayout=async(width,tone,font)=>{
  await frame();
  near(window.innerWidth,width,'native content width');
  const html=document.documentElement;
  html.dataset.theme=tone;html.dataset.teMotion='off';
  html.style.setProperty('--te-font-size-body',font+'px');
  html.style.setProperty('--te-titlebar-inset','35px');
  html.style.setProperty('--te-playbar-bottom-clearance','100px');
  for(const available of [width,width-220,420])for(const custom of [false,true]){
    html.dataset.teShellLayout=custom?'custom':'standard';
    pane.style.width=available+'px';pane.style.height=custom?'760px':'100%';
    for(const [rootClass,innerClass]of pages){
      const {root,inner}=mount(rootClass,innerClass);
      flushLayout();
      const surface=rootClass==='song-list'?root:inner;
      const css=getComputedStyle(surface),gutter=Math.min(32,Math.max(16,width*.03));
      near(parseFloat(css.paddingTop),custom?20:55,rootClass+' titlebar safety');
      near(parseFloat(css.paddingLeft),gutter,rootClass+' single horizontal gutter');
      near(parseFloat(css.paddingBottom),custom?32:132,rootClass+' player clearance');
      if(custom)near(root.clientHeight,760,rootClass+' custom available height');
      expect(root.scrollWidth<=root.clientWidth+1,rootClass+' no horizontal overflow: '+JSON.stringify({width,available,custom,font,scroll:root.scrollWidth,client:root.clientWidth,children:[...inner.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>root.getBoundingClientRect().left+root.clientWidth-parseFloat(css.paddingRight)).map(n=>[n.className,n.getBoundingClientRect().width,n.getBoundingClientRect().right])}));
      root.scrollTop=root.scrollHeight;
      const last=inner.querySelector('.layout-last').getBoundingClientRect(),rect=root.getBoundingClientRect();
      expect(last.bottom<=rect.bottom-(custom?30:130),rootClass+' final item reachable above player');
      root.scrollTop=0;
      if(rootClass==='home'){
        const header=inner.querySelector('.masthead'),hero=inner.querySelector('.feature-card');
        near(header.getBoundingClientRect().left,hero.getBoundingClientRect().left,'home aligned header and feature');
        const t=inner.querySelector('.masthead-title'),button=inner.querySelector('.masthead-shuffle');
        const a=t.getBoundingClientRect(),b=button.getBoundingClientRect();
        expect(a.right<=b.left||a.bottom<=b.top||b.bottom<=a.top,'title and shuffle do not intersect at '+font+'px');
        near(parseFloat(getComputedStyle(t).fontSize),font*32/14,'home title follows shared role');
        expect(b.height>=40,'shuffle hit area');
          const icon=inner.querySelector('.masthead-shuffle-icon'),label=inner.querySelector('.masthead-shuffle-label');
          expect(icon.getBoundingClientRect().width>=parseFloat(getComputedStyle(icon).fontSize),'scaled shuffle icon fits its box');
          expect(icon.getBoundingClientRect().right<label.getBoundingClientRect().left,'scaled shuffle icon clears its label');
        expect(getComputedStyle(inner.querySelector('.hero-title')).webkitLineClamp==='none','hero title remains complete');
      }
      if(rootClass==='song-list'){
        const header=inner.querySelector('.song-list-header'),back=inner.querySelector('.detail-back-button'),t=inner.querySelector('.song-list-title');
        near(parseFloat(getComputedStyle(header).paddingTop),6,'list no phantom narrow back offset');
        near(parseFloat(getComputedStyle(header).paddingLeft),0,'list header no second gutter');
        expect(back.getBoundingClientRect().right<=t.getBoundingClientRect().left,'actual back retains flow space');
        if(root.clientWidth-gutter*2<=640)near(parseFloat(getComputedStyle(inner.querySelector('.header-right')).flexBasis),100,'sidebar width triggers list reflow');
        html.dataset.teLibraryDensity='compact';flushLayout();
        near(parseFloat(getComputedStyle(root).paddingLeft),gutter,'compact list keeps shared gutter');
        delete html.dataset.teLibraryDensity;
        root.style.setProperty('--te-page-top','20px');flushLayout();
        near(parseFloat(getComputedStyle(root).paddingTop),20,'nested tab top override');
      }
    }
  }
};`
