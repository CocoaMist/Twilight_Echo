import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('saved theme colors reach the dashboard and player controls across tones and bar modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-player-theme-'))
  try {
    const dashboardProgress = await readFile(
      new URL('../local-dashboard/DashboardPlaybackProgress.vue', import.meta.url),
      'utf8'
    )
    const sources = [
      await readFile(new URL('./PlayerBar.css', import.meta.url), 'utf8'),
      await readFile(new URL('../LocalDashboard.css', import.meta.url), 'utf8'),
      parse(dashboardProgress).descriptor.styles[0].content
    ]
    const styles = sources.map((source) => {
      const style = compileStyle({
        source,
        filename: 'Playback.css',
        id: 'data-v-test',
        scoped: true
      })
      assert.deepEqual(style.errors, [])
      return style.code
    })
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PlayerThemeTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>${styles.join('\n')}</style></head><body><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron')
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
  win.webContents.on('console-message',event=>console.error(event.message))
  try{
    await win.loadFile(process.argv.at(-1))
    await win.webContents.executeJavaScript('window.runPlayerThemeTests()')
    for(const tone of ['pureWhite','dark'])for(const mode of ['standard','mini','compact','dashboard'])for(const glass of [false,true]){
      const rect=await win.webContents.executeJavaScript('window.preparePlayerThemeHover('+JSON.stringify(tone)+','+JSON.stringify(mode)+','+glass+')')
      win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rect.x),y:Math.round(rect.y)})
      await new Promise(resolve=>setTimeout(resolve,300))
      await win.webContents.executeJavaScript('window.checkPlayerThemeHover()')
      win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0})
    }
    await win.loadFile(process.argv.at(-1))
    await win.webContents.executeJavaScript('window.checkReloadedPlayerTheme()')
    console.log('PLAYER_THEME_COLORS_OK')
    app.exit(0)
  }catch(error){console.error(error.stack);app.exit(1)}
})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /PLAYER_THEME_COLORS_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {bootstrapThemeRuntime,useThemeStore} from '@renderer/stores/useThemeStore.ts'
import {createDefaultThemeLibraryDocument,normalizeThemeProfile} from '@shared/theme.ts'
const storageKey='player-theme-test-library'
let library=JSON.parse(localStorage.getItem(storageKey)||'null')||{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}
const expect=(value,message)=>{if(!value)throw new Error(message)}
const commit=(data,revision)=>{
  expect(revision===library.revision,'write uses the current library revision')
  library={...library,revision:revision+1,savedAt:new Date().toISOString(),data}
  localStorage.setItem(storageKey,JSON.stringify(library))
  return structuredClone(library)
}
window.api={
  settings:{onChanged:()=>()=>{}},
  plugins:{onChanged:()=>()=>{}},
  themes:{
    onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{},
    save:async(profile,revision)=>{
      const normalized=normalizeThemeProfile(structuredClone(profile))
      expect(normalized,'saved theme profile is valid')
      return commit({...library.data,profiles:[normalized]},revision)
    },
    setActive:async(activeTheme,revision)=>commit({...library.data,activeTheme},revision)
  }
}
const boot=()=>bootstrapThemeRuntime({systemTone:'pureWhite',settings:{settings:{theme:'pureWhite',accentColor:'blue',lightAccentColor:'blue',darkAccentColor:'blue',uiDensity:'comfortable'}},themeBootstrap:{library}})
const store=useThemeStore()
const colors={
  pureWhite:{'playback.progress.track':'rgba(37, 99, 235, 0.16)','playback.progress.fill':'linear-gradient(270deg, rgba(37, 99, 235, 0.58), rgba(240, 128, 230, 0.73))','playback.control.surface':'#654321','playback.control.hoverSurface':'#abcdef'},
  dark:{'playback.progress.track':'#345678','playback.progress.fill':'linear-gradient(90deg, #0000ff, #ff00ff)','playback.control.surface':'#876543','playback.control.hoverSurface':'#fedcba'}
}
let bar,button,stripButton,hoverTarget,track,fill
const clear=()=>{
  document.querySelector('.player-bar-shell')?.remove()
  document.querySelector('.home')?.remove()
}
const mount=(mode,glass=false,live=false)=>{
  clear()
  const shell=document.createElement('div')
  shell.className='player-bar-shell'
  shell.dataset.tePlaybarMode=mode
  shell.innerHTML='<div class="player-bar '+(mode==='standard'?'':'player-bar-'+mode)+(glass?' player-bar-glass':'')+'" style="--accent-color:#cc9900;--play-button-color:#cc9900"><div class="player-left"><button class="mini-play-button">Play</button></div><div class="player-center"><div class="player-controls"><button class="ctrl-btn btn-play">Play</button></div><div class="'+(mode==='standard'?'progress-slider-wrap':mode+'-progress-rail')+'"><div class="'+(mode==='standard'?'':mode+'-')+'progress-track"><div class="'+(mode==='standard'?'':mode+'-')+'progress-fill'+(live?' live':'')+'"></div></div></div></div><div class="player-right"></div></div>'
  for(const element of [shell,...shell.querySelectorAll('*')])element.setAttribute('data-v-test','')
  document.body.append(shell)
  bar=shell.querySelector('.player-bar')
  button=shell.querySelector('.btn-play')
  stripButton=shell.querySelector('.mini-play-button')
  track=shell.querySelector('[class$="progress-track"]')
  fill=track.firstElementChild
}
const mountDashboard=(glass=false)=>{
  clear()
  document.documentElement.dataset.teHomeLiquidGlass=glass?'on':'off'
  const home=document.createElement('div')
  home.className='home'
  home.innerHTML='<div class="hero-progress"><button class="hero-progress-track"><span style="transform:scaleX(0.42)"></span></button></div><div class="hero-actions"><button class="transport-button transport-play">Play</button></div>'
  for(const element of [home,...home.querySelectorAll('*')])element.setAttribute('data-v-test','')
  document.body.append(home)
  bar=home
  button=home.querySelector('.transport-play')
  track=home.querySelector('.hero-progress-track')
  fill=track.firstElementChild
}
const background=(element,pseudo)=>{
  const style=getComputedStyle(element,pseudo)
  return [style.backgroundColor,style.backgroundImage].join('|')
}
const checkBackground=(element,value,label,pseudo)=>{
  const probe=document.createElement('div')
  probe.style.background=value
  document.body.append(probe)
  expect(background(element,pseudo)===background(probe),label+': '+background(element,pseudo)+' expected '+background(probe))
  probe.remove()
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,250))
const checkColors=async(overrides)=>{
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
    for(const glass of [false,true]){
      mountDashboard(glass)
      await settle()
      checkBackground(track,overrides[tone]['playback.progress.track'],tone+' dashboard track','::before')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],tone+' dashboard fill')
      checkBackground(button,overrides[tone]['playback.control.surface'],tone+' dashboard play')
      bar.style.setProperty('--home-accent','#0000aa')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],tone+' dashboard accent change')
    }
    for(const mode of ['standard','mini','compact'])for(const glass of [false,true])for(const live of [false,true]){
      mount(mode,glass,live)
      await settle()
      const label=[tone,mode,glass,live].join('/')
      checkBackground(track,overrides[tone]['playback.progress.track'],label+' track')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],label+' fill')
      checkBackground(button,overrides[tone]['playback.control.surface'],label+' play')
      if(mode!=='standard')checkBackground(stripButton,overrides[tone]['playback.control.surface'],label+' standalone play')
      bar.style.setProperty('--accent-color','#0000aa')
      bar.style.setProperty('--play-button-color','#0000aa')
      checkBackground(track,overrides[tone]['playback.progress.track'],label+' cover track change')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],label+' cover fill change')
      checkBackground(button,overrides[tone]['playback.control.surface'],label+' cover change')
    }
  }
}
const checkDashboardDefaults=()=>{
  mountDashboard()
  const style=getComputedStyle(bar)
  const ink=style.getPropertyValue('--home-ink')
  checkBackground(track,'color-mix(in srgb, '+ink+' 12%, transparent)','reset restores dashboard track','::before')
  checkBackground(fill,'linear-gradient(90deg, '+style.getPropertyValue('--home-accent')+', '+style.getPropertyValue('--te-accent-cyan')+')','reset restores dashboard fill')
  checkBackground(button,ink,'reset restores dashboard play')
}
window.runPlayerThemeTests=async()=>{
  await boot()
  const profile=store.createProfile('Player colors')
  profile.overrides=structuredClone(colors)
  await store.preview(profile)
  await checkColors(colors)
  await store.saveProfile(profile)
  await store.setActive({kind:'user',id:profile.id})
  await checkColors(colors)
  const preview=structuredClone(profile)
  preview.overrides.dark['playback.progress.track']='#aa00aa'
  await store.preview(preview)
  mountDashboard()
  checkBackground(track,'#aa00aa','dashboard preview uses edited track','::before')
  mount('compact',true)
  checkBackground(track,'#aa00aa','preview uses edited track')
  await store.preview(null)
  checkBackground(track,colors.dark['playback.progress.track'],'cancel restores saved track')
  mountDashboard()
  checkBackground(track,colors.dark['playback.progress.track'],'dashboard cancel restores saved track','::before')
  const reset=structuredClone(profile)
  reset.overrides={pureWhite:{},dark:{}}
  await store.saveProfile(reset)
  await store.setActive({kind:'user',id:profile.id})
  checkDashboardDefaults()
  mount('mini')
  checkBackground(fill,'#cc9900','reset restores cover progress color')
  checkBackground(button,'#cc9900','reset restores cover play color')
  checkBackground(stripButton,'transparent','reset restores standalone play surface')
  await store.saveProfile(profile)
  await store.setActive({kind:'user',id:profile.id})
  await store.setActive({kind:'builtin',id:'builtin:twilight-echo-default'})
  checkDashboardDefaults()
  mount('compact')
  checkBackground(fill,'#cc9900','switching theme clears progress override')
  checkBackground(button,'#cc9900','switching theme clears play override')
  await store.setActive({kind:'user',id:profile.id})
}
window.preparePlayerThemeHover=async(tone,mode,glass)=>{
  await store.setPreviewTone(tone)
  if(mode==='dashboard')mountDashboard(glass)
  else mount(mode,glass)
  hoverTarget=mode==='standard'||mode==='dashboard'?button:stripButton
  const rect=hoverTarget.getBoundingClientRect()
  return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
}
window.checkPlayerThemeHover=()=>{
  expect(hoverTarget.matches(':hover'),'play button receives hover')
  checkBackground(hoverTarget,colors[document.documentElement.dataset.theme]['playback.control.hoverSurface'],'custom play hover '+bar.className+' '+getComputedStyle(hoverTarget).getPropertyValue('--te-player-bar-play-hover-surface'))
}
window.checkReloadedPlayerTheme=async()=>{
  await boot()
  await checkColors(colors)
  expect(store.error.value==='','theme runtime applies without errors')
}
`
