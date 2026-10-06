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

test('all icon aliases paint with antialiased curves at Windows display scales', async (t) => {
  const css = await readFile(join(workspace, 'src/renderer/src/assets/icons.css'), 'utf8')
  const aliases = [...new Set(css.match(/\.(?:pi|ph)-[a-z][a-z0-9-]*/g))]
    .map((name) => name.slice(1))
    .filter((name) => !['ph-bold', 'ph-fill', 'ph-spin', 'pi-fw', 'pi-spin'].includes(name))
  assert.ok(aliases.length > 50, 'the fixture must cover the complete compatibility map')
  const directory = await mkdtemp(join(tmpdir(), 'twilight-icon-rendering-'))
  try {
    await writeFile(
      join(directory, 'entry.ts'),
      runtime.replace('ICON_ALIASES', JSON.stringify(aliases))
    )
    await build({
      configFile: false,
      base: './',
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
        assetsDir: '',
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'IconTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'bundle', 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="${f}">`)
        .join(
          ''
        )}<style>html,body{margin:0}#app{display:grid;grid-template-columns:repeat(12,48px)}.cell{height:48px;display:grid;place-items:center}.cell>*{color:inherit}</style></head><body><div id="app"></div><script src="${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    for (const scale of [1, 1.25, 1.5, 2]) {
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(directory, 'runner.cjs'), String(scale)],
        { env, windowsHide: true, timeout: 60_000, maxBuffer: 1_000_000 }
      )
      assert.match(result.stdout, /ICON_RENDERING_OK/)
      t.diagnostic(result.stdout.trim())
    }
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick} from 'vue'
import '@renderer/assets/icons.css'
import ThemeIcon from '@renderer/components/ThemeIcon.vue'
import TitleBarIcon from '@renderer/components/icons/TitleBarIcon.vue'
import PlayerControlIcon from '@renderer/components/player-bar/PlayerControlIcon.vue'
import PuzzleIcon from '@renderer/components/icons/PuzzleIcon.vue'
import MiniGlyph from '@renderer/mini-player/MiniGlyph.vue'
import {THEME_ICON_SLOT_REGISTRY} from '${join(workspace, 'src/shared/theme.ts').replaceAll('\\', '/')}'
const aliases=ICON_ALIASES
const loaded=new Set()
const cases=[
  ...aliases.map(name=>({id:name,node:()=>h('i',{class:[name.startsWith('pi-')?'pi':'ph',name]})})),
  ...Object.keys(THEME_ICON_SLOT_REGISTRY).map(slot=>({id:slot,node:()=>h(ThemeIcon,{iconSlot:slot})})),
  ...['navigation','search','settings','puzzle_piece','arrow_left','person'].map(name=>({id:'title-'+name,node:()=>h(TitleBarIcon,{name})})),
  ...['volume','muted','queue','hifi','equalizer','miniPlayer','favorite','previous','next','play','pause','sequential','listLoop','repeat','heart','shuffle'].map(name=>({id:'control-'+name,node:()=>h(PlayerControlIcon,{name})})),
  ...['play','pause','previous','next'].map(name=>({id:'mini-'+name,node:()=>h(MiniGlyph,{name})})),
  ...[['caret-right',15],['caret-left',13],['arrow-clockwise',24],['play',15],['check-circle',62],['warning-circle',26]].map(([name,size])=>({id:'login-'+name,fixed:true,wide:size>48,node:()=>h('i',{class:[name==='play'?'ph-fill':'ph','ph-'+name],style:{fontSize:size+'px'}})})),
  {id:'puzzle',node:()=>h(PuzzleIcon)},
  {id:'explicit-fill',node:()=>h('i',{class:'ph-fill ph-heart'})}
]
createApp({render:()=>cases.map(item=>h('div',{class:'cell','data-icon':item.id,'data-fixed':item.fixed?'true':undefined,style:item.wide?{gridColumn:'span 2',height:'80px'}:undefined},[item.node()]))}).mount('#app')
const expect=(condition,message)=>{if(!condition)throw new Error(message)}
window.prepareIconRendering=async(theme,family,size)=>{
  document.documentElement.dataset.theme=theme
  document.documentElement.dataset.teIconFamily=family
  document.body.style.background=theme==='dark'?'rgb(16,16,16)':'rgb(255,255,255)'
  document.body.style.color=theme==='dark'?'rgb(255,255,255)':'rgb(16,16,16)'
  document.body.style.fontSize=size+'px'
  await nextTick()
  const items=[]
  for(const cell of document.querySelectorAll('.cell')){
    if(cell.dataset.fixed==='true'){cell.style.display=size===20?'grid':'none';if(size!==20)continue}
    const elements=[...cell.querySelectorAll('*')].filter(el=>getComputedStyle(el).display!=='none')
    const glyphs=elements.filter(el=>getComputedStyle(el,'::before').maskImage!=='none')
    expect(glyphs.length===1,cell.dataset.icon+' must display exactly one SVG glyph, got '+glyphs.length)
    const glyph=glyphs[0],style=getComputedStyle(glyph,'::before'),rect=cell.getBoundingClientRect()
    expect(style.width===style.height,cell.dataset.icon+' glyph is not square')
    const match=style.maskImage.match(/^url\\(["']?(.*?)["']?\\)$/)
    expect(match,cell.dataset.icon+' has no SVG mask URL')
    if(!loaded.has(match[1])){const img=new Image();img.src=match[1];try{await img.decode()}catch(error){throw new Error(cell.dataset.icon+' cannot decode mask '+match[1]+' '+error)};expect(img.naturalWidth>0,cell.dataset.icon+' mask failed to decode');loaded.add(match[1])}
    if(cell.dataset.icon.includes('.')){
      const active=elements.filter(el=>el.classList.contains('theme-icon-glyph'))
      expect(active.length===1,cell.dataset.icon+' family overlaps')
    }
    items.push({id:cell.dataset.icon,x:rect.x,y:rect.y,width:rect.width,height:rect.height,mask:style.maskImage})
  }
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)
  return {items,height:document.querySelector('#app').getBoundingClientRect().height,dpr:devicePixelRatio}
}
`

const runner = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');const assert=require('node:assert/strict');
const scale=Number(process.argv.at(-1));app.setPath('userData',path.join(__dirname,'profile-'+scale));app.commandLine.appendSwitch('force-device-scale-factor',String(scale));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:576,height:1000,useContentSize:true,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});let fontRequests=0;win.webContents.session.webRequest.onBeforeRequest({urls:['*://*/*','file://*/*']},(details,callback)=>{if(/\\.woff2?(?:$|\\?)/.test(details.url))fontRequests++;callback({})});
try{await win.loadFile(path.join(__dirname,'bundle','index.html'));const familyMasks=new Map();let checked=0;for(const theme of ['light','dark'])for(const family of ['outline','rounded','filled'])for(const size of [16,20,24]){
  let data=await win.webContents.executeJavaScript('window.prepareIconRendering('+JSON.stringify(theme)+','+JSON.stringify(family)+','+size+')');assert.ok(Math.abs(data.dpr-scale)<.01,'requested Windows DPR was not applied');win.setContentSize(576,Math.ceil(data.height));
  data=await win.webContents.executeJavaScript('window.prepareIconRendering('+JSON.stringify(theme)+','+JSON.stringify(family)+','+size+')');const image=await win.webContents.capturePage();const pixels=image.toBitmap(),dimensions=image.getSize();const sx=dimensions.width/576,sy=dimensions.height/Math.ceil(data.height);assert.ok(Math.abs(sx-scale)<.02,'screenshot must retain physical pixels');
  for(const item of data.items){let ink=0,partial=0;for(let y=Math.ceil(item.y*sy);y<Math.floor((item.y+item.height)*sy);y++)for(let x=Math.ceil(item.x*sx);x<Math.floor((item.x+item.width)*sx);x++){const offset=(y*dimensions.width+x)*4;const distance=Math.abs(pixels[offset]-(theme==='dark'?16:255));if(distance>4)ink++;if(distance>20&&distance<219)partial++}assert.ok(ink>3,theme+'/'+family+'/'+size+'/'+item.id+' is blank');if(/^(pi-search|ph-magnifying-glass|control-favorite|title-settings|puzzle)$/.test(item.id))assert.ok(partial>1,item.id+' curved edges have no intermediate pixel coverage at DPR '+scale);checked++}
  const search=data.items.find(item=>item.id==='pi-search');const filled=data.items.find(item=>item.id==='explicit-fill');if(theme==='light'&&size===20){familyMasks.set(family,search.mask);familyMasks.set(family+'-explicit',filled.mask)}
  const dir=process.env.TWILIGHT_ICON_VISUAL_DIR;if(dir&&size===20){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,scale+'-'+theme+'-'+family+'.png'),image.toPNG())}
}assert.equal(new Set(['outline','rounded','filled'].map(f=>familyMasks.get(f))).size,3,'ordinary icons must follow family choice');assert.equal(new Set(['outline','rounded','filled'].map(f=>familyMasks.get(f+'-explicit'))).size,1,'explicit filled actions must stay filled');assert.equal(fontRequests,0,'SVG icon rendering must not request icon fonts');console.log('ICON_RENDERING_OK DPR='+scale+' samples='+checked);app.exit(0)}catch(error){console.error(error.stack||error);app.exit(1)}})
`
