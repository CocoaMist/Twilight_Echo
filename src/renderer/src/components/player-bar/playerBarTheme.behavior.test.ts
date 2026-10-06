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

test('rendered surfaces keep restrained default shadows and saved theme controls across tones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-player-theme-'))
  try {
    const source = await readFile(new URL('./PlayerBar.css', import.meta.url), 'utf8')
    const style = compileStyle({
      source,
      filename: 'PlayerBar.css',
      id: 'data-v-test',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
    const geometryStyles = await Promise.all(
      [
        '../../assets/base.css',
        '../song-list/SongList.css',
        '../settings-page/SettingsPage.css',
        '../SettingsPage.vue',
        '../AnimatedInput.vue',
        '../PlayingMusic.vue'
      ].map(async (path) => {
        const source = await readFile(new URL(path, import.meta.url), 'utf8')
        const compiled = compileStyle({
          source: path.endsWith('.vue')
            ? parse(source)
                .descriptor.styles.filter((style) => !style.src)
                .map((style) => style.content)
                .join('\n')
            : source,
          filename: path,
          id: 'data-v-test',
          scoped: ![
            '../../assets/base.css',
            '../settings-page/SettingsPage.css',
            '../SettingsPage.vue'
          ].includes(path)
        })
        assert.deepEqual(compiled.errors, [])
        return compiled.code
      })
    )
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
      `<!doctype html><html><head><meta charset="utf-8"><style id="geometry-styles">${geometryStyles.join('\n')}</style><style>${style.code}</style></head><body><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,nativeTheme}=require('electron')
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
  win.webContents.on('console-message',event=>console.error(event.message))
  try{
    await win.loadFile(process.argv.at(-1))
    for(const width of [1280,800,600]){
      win.setSize(width,900)
      await win.webContents.executeJavaScript('window.checkArtworkGeometry()')
    }
    win.setSize(1080,900)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'})
    await win.webContents.executeJavaScript('window.checkDefaultSurfaceShadows()')
    await win.webContents.debugger.sendCommand('DOM.enable')
    await win.webContents.debugger.sendCommand('CSS.enable')
    for(const system of ['light','dark']){
      nativeTheme.themeSource=system
      for(const tone of ['pureWhite','dark']){
        await win.webContents.executeJavaScript('window.checkSettingsControls('+JSON.stringify(tone)+')')
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'})
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'})
        await win.webContents.executeJavaScript('window.checkSettingsCheckboxKeyboard()')
        const doc=await win.webContents.debugger.sendCommand('DOM.getDocument')
        const node=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#settings-disabled-toggle'})
        await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:['hover']})
        await new Promise(resolve=>setTimeout(resolve,250))
        await win.webContents.executeJavaScript('window.checkDisabledSettingsHover()')
        await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:[]})
      }
    }
    await win.webContents.executeJavaScript('window.clearSettingsControls()')
    nativeTheme.themeSource='system'
    if(process.env.TWILIGHT_SHADOW_VISUAL_DIR){
      const fs=require('node:fs'),path=require('node:path')
      fs.mkdirSync(process.env.TWILIGHT_SHADOW_VISUAL_DIR,{recursive:true})
      for(const tone of ['pureWhite','dark']){
        await win.webContents.executeJavaScript('window.prepareSurfaceShadowPreview('+JSON.stringify(tone)+')')
        await new Promise(resolve=>setTimeout(resolve,300))
        const image=await win.webContents.capturePage()
        fs.writeFileSync(path.join(process.env.TWILIGHT_SHADOW_VISUAL_DIR,tone+'-standard.png'),image.toPNG())
      }
      await win.webContents.executeJavaScript('window.clearSurfaceShadowPreview()')
    }
    await win.webContents.executeJavaScript('document.querySelector("#geometry-styles").remove()')
    await win.webContents.executeJavaScript('window.runPlayerThemeTests()')
    for(const tone of ['pureWhite','dark'])for(const mode of ['standard','mini','compact'])for(const glass of [false,true]){
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
import {createDefaultThemeLibraryDocument,normalizeThemeProfile,themeContrastRatio} from '@shared/theme.ts'
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
  pureWhite:{'playback.progress.track':'#123456','playback.progress.fill':'linear-gradient(90deg, #ff0000, #00ff00)','playback.control.surface':'#654321','playback.control.hoverSurface':'#abcdef'},
  dark:{'playback.progress.track':'#345678','playback.progress.fill':'linear-gradient(90deg, #0000ff, #ff00ff)','playback.control.surface':'#876543','playback.control.hoverSurface':'#fedcba'}
}
let bar,button,stripButton,hoverTarget,track,fill
const mount=(mode,glass=false,live=false)=>{
  document.querySelector('.player-bar-shell')?.remove()
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
const background=(element)=>{
  const style=getComputedStyle(element)
  return [style.backgroundColor,style.backgroundImage].join('|')
}
const checkBackground=(element,value,label)=>{
  const probe=document.createElement('div')
  probe.style.background=value
  document.body.append(probe)
  expect(background(element)===background(probe),label+': '+background(element)+' expected '+background(probe))
  probe.remove()
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,250))
window.checkArtworkGeometry=async()=>{
  const root=document.documentElement
  const close=(a,b,label)=>expect(Math.abs(a-b)<0.1,label+': '+a+' / '+b)
  for(const tone of ['pureWhite','dark'])for(const mode of ['standard','mini','compact']){
    root.dataset.theme=tone
    mount(mode)
    const slot=document.createElement('div')
    slot.className='player-cover-slot'
    slot.setAttribute('data-v-test','')
    bar.querySelector('.player-left').prepend(slot)
    for(const tag of ['img','div']){
      slot.innerHTML=tag==='img'?'<img class="player-cover" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2252%22%3E%3Crect width=%2252%22 height=%2252%22 fill=%22skyblue%22/%3E%3C/svg%3E">':'<div class="player-cover-placeholder">♪</div>'
      const artwork=slot.firstElementChild
      artwork.setAttribute('data-v-test','')
      const outer=bar.getBoundingClientRect(),inner=slot.getBoundingClientRect(),image=artwork.getBoundingClientRect()
      close(image.width,inner.width,mode+' artwork width')
      close(image.height,inner.height,mode+' artwork height')
      close(image.x,inner.x,mode+' artwork x')
      close(image.y,inner.y,mode+' artwork y')
      expect(inner.top>=outer.top&&inner.bottom<=outer.bottom,mode+' cover overflows the bar')
      expect(getComputedStyle(artwork).borderTopLeftRadius==='0px','artwork adds a second rounding mask')
      if(mode==='standard'){
        close(inner.width,52,'slightly enlarged artwork')
        close(outer.height,78,'slightly enlarged standard bar')
        const radius=parseFloat(getComputedStyle(bar).borderTopLeftRadius),small=parseFloat(getComputedStyle(slot).borderTopLeftRadius)
        close(inner.x+small,outer.x+radius,'horizontal corner centres')
        close(inner.y+small,outer.y+radius,'vertical corner centres')
      }
    }
    expect(getComputedStyle(bar).overflowY==='visible','bar clips its upward volume drawer')
    bar.classList.add('player-bar-liquid')
    expect(getComputedStyle(slot).cornerShape===getComputedStyle(bar).cornerShape,'glass artwork differs from the raster contour')
  }
  document.querySelector('.player-bar-shell').remove()
  const fixture=document.createElement('div')
  fixture.className='song-list'
  fixture.innerHTML='<div class="album-card" style="width:220px"><div class="album-cover-placeholder"></div></div>'
  for(const element of [fixture,...fixture.querySelectorAll('*')])element.setAttribute('data-v-test','')
  document.body.append(fixture)
  const card=fixture.firstElementChild,cover=card.firstElementChild
  for(const density of ['comfortable','compact'])for(const radius of [0,7,21,24])for(const border of [0,1,2]){
    root.dataset.teLibraryDensity=density
    root.dataset.cardCustom='on'
    root.style.setProperty('--te-card-radius',radius+'px')
    root.style.setProperty('--te-card-border-width',border+'px')
    const outer=card.getBoundingClientRect(),inner=cover.getBoundingClientRect(),inset=inner.x-outer.x
    close(parseFloat(getComputedStyle(cover).borderTopLeftRadius),Math.min(8,Math.max(0,radius-inset)),'library cover inset')
    expect(getComputedStyle(cover).cornerShape===getComputedStyle(card).cornerShape,'library cover curve mismatch')
  }
  fixture.remove()
  delete root.dataset.teLibraryDensity
  delete root.dataset.cardCustom
  root.style.removeProperty('--te-card-radius')
  root.style.removeProperty('--te-card-border-width')
}
const shadowLayers=(element)=>{
  const value=getComputedStyle(element).boxShadow
  return value==='none'?[]:value.split(/,(?![^()]*\\))/).map(value=>value.trim())
}
const checkShadow=(element,value,label)=>{
  const probe=document.createElement('div')
  probe.style.boxShadow=value
  document.body.append(probe)
  expect(getComputedStyle(element).boxShadow===getComputedStyle(probe).boxShadow,label+': '+getComputedStyle(element).boxShadow)
  probe.remove()
}
let surfaceFixture
const mountSurfaces=()=>{
  surfaceFixture?.remove()
  surfaceFixture=document.createElement('main')
  surfaceFixture.id='shadow-surfaces'
  surfaceFixture.style.cssText='padding:32px;display:grid;grid-template-columns:1fr 1fr;gap:24px;font:14px system-ui;color:var(--te-settings-text)'
  surfaceFixture.innerHTML='<section class="song-list"><h2>Library</h2><div class="track-table-wrapper">Track list stays on the page surface</div></section><section class="playing-music"><div class="cover-frame" style="width:220px"><img class="cover-image" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22%3E%3Crect width=%22220%22 height=%22220%22 fill=%22%235d7dab%22/%3E%3C/svg%3E"></div></section><section class="settings-preview-page" style="position:static;padding:0"><h2>Settings</h2><div class="glass-card">Settings section</div><button class="device-card">Output device</button><div class="dsp-meter">Level meter</div><div class="settings-nav-results" style="position:static;margin-top:16px">Floating search results</div></section>'
  surfaceFixture.querySelector('.playing-music').style.cssText='position:static;background:none;z-index:auto'
  surfaceFixture.querySelector('.song-list').style.cssText='display:block;padding:0'
  for(const element of [surfaceFixture,...surfaceFixture.querySelectorAll('*')])element.setAttribute('data-v-test','')
  document.body.append(surfaceFixture)
}
const root=document.documentElement
let controlsFixture,checkboxGeometry
window.checkSettingsControls=async(tone)=>{
  await store.setPreviewTone(tone)
  root.dataset.teMotion='full'
  controlsFixture?.remove()
  controlsFixture=document.createElement('main')
  controlsFixture.className='settings-preview-page settings-preview-layout'
  controlsFixture.style.cssText='position:static;padding:16px'
  controlsFixture.innerHTML='<div class="glass-card"><div class="setting-copy"><span id="settings-hint">设置说明</span></div><input id="settings-number" type="number" class="number-input" value="123"><select id="settings-select" class="preview-select"><option>主题</option></select><input id="settings-checkbox" type="checkbox" checked><button id="settings-disabled-toggle" class="toggle-switch inactive" disabled aria-label="Disabled setting"></button><div id="settings-search" class="settings-search-box"><span class="animated-input settings-search-input" data-v-test><input class="animated-input-field" data-v-test></span></div></div>'
  document.body.append(controlsFixture)
  await settle()
  const css=element=>getComputedStyle(element)
  const panel=controlsFixture.querySelector('.glass-card'),number=controlsFixture.querySelector('#settings-number'),select=controlsFixture.querySelector('#settings-select'),hint=controlsFixture.querySelector('#settings-hint'),checkbox=controlsFixture.querySelector('#settings-checkbox'),toggle=controlsFixture.querySelector('#settings-disabled-toggle')
  expect(css(root).colorScheme===(tone==='dark'?'dark':'light'),'selected app tone does not own native color scheme')
  for(const input of [number,select]){
    checkShadow(input,'none',tone+' settings control stays flat: '+input.id)
    expect((themeContrastRatio(css(input).color,css(input).backgroundColor)??0)>=4.5,tone+' settings control has low contrast: '+input.id)
    input.focus()
    expect(input.matches(':focus-visible')&&css(input).outlineStyle==='solid'&&css(input).outlineWidth==='2px',tone+' control lost keyboard focus feedback')
  }
  const search=controlsFixture.querySelector('#settings-search'),searchRoot=search.firstElementChild,searchField=searchRoot.firstElementChild;searchField.focus()
  expect(searchField.matches(':focus-visible')&&css(search).outlineStyle==='solid'&&css(search).outlineWidth==='2px',tone+' search parent lost its focus ring')
  expect(css(searchRoot).outlineStyle==='none'&&css(searchField).outlineStyle==='none',tone+' search paints a duplicate focus ring')
  expect((themeContrastRatio(css(hint).color,css(panel).backgroundColor)??0)>=4.5,tone+' settings muted text has low contrast')
  const rectangle=checkbox.getBoundingClientRect(),geometry=[rectangle.width,rectangle.height,css(checkbox).borderRadius,css(checkbox).appearance].join('|')
  if(checkboxGeometry)expect(geometry===checkboxGeometry,'checkbox changes shape across app/system tones')
  checkboxGeometry=geometry
  expect(css(checkbox).appearance==='none'&&getComputedStyle(checkbox,'::after').content==='""','checkbox checked glyph disappeared')
  checkbox.click();expect(!checkbox.checked,'checkbox lost native mouse activation')
  expect((themeContrastRatio(css(checkbox).borderTopColor,css(checkbox).backgroundColor)??0)>=3,tone+' unchecked checkbox boundary has low contrast')
  checkbox.disabled=true;checkbox.click();expect(!checkbox.checked,'disabled checkbox still toggles')
  checkbox.disabled=false;checkbox.focus()
  if(tone==='dark')expect((themeContrastRatio(getComputedStyle(toggle,'::after').backgroundColor,css(toggle).backgroundColor)??0)>=3,tone+' inactive toggle thumb has low contrast')
  const changed=store.createProfile('Settings foregrounds')
  changed.overrides={pureWhite:{'settings.text.primary':'#234567','settings.text.muted':'#456789','settings.control.surface':'#f1f5f9','settings.control.border':'#547698','color.neutral.500':'#56789a'},dark:{'settings.text.primary':'#e4edf6','settings.text.muted':'#b1c3d5','settings.control.surface':'#121c26','settings.control.border':'#87a9cb','color.neutral.500':'#bacdef'}}
  await store.preview(changed);await settle()
  expect(css(number).color===css(select).color,tone+' number and select foregrounds drifted')
  const probe=document.createElement('div');probe.style.color='var(--te-settings-text-muted)';document.body.append(probe)
  expect(css(hint).color===css(probe).color,tone+' saved settings muted override was lost');probe.style.color='var(--te-settings-text)'
  expect(css(number).color===css(probe).color,tone+' saved control foreground override was lost');probe.style.backgroundColor='var(--te-settings-control-bg)'
  expect(css(number).backgroundColor===css(probe).backgroundColor,tone+' saved control background override was lost');probe.style.border='1px solid var(--te-settings-control-border)'
  expect(css(number).borderTopColor===css(probe).borderTopColor,tone+' saved control border override was lost');probe.style.borderColor='var(--te-neutral-500)'
  expect(css(checkbox).borderTopColor===css(probe).borderTopColor,tone+' saved checkbox border override was lost');probe.remove()
  await store.preview(null);await settle();checkbox.focus()
}
window.checkSettingsCheckboxKeyboard=()=>{
  expect(controlsFixture.querySelector('#settings-checkbox').checked,'checkbox lost native keyboard activation')
}
window.checkDisabledSettingsHover=async()=>{
  const toggle=controlsFixture.querySelector('#settings-disabled-toggle')
  expect(getComputedStyle(toggle).scale==='none','disabled settings toggle reacts to hover')
  toggle.disabled=false;toggle.setAttribute('aria-disabled','true');await settle()
  expect(getComputedStyle(toggle).scale==='none','aria-disabled settings toggle reacts to hover')
  toggle.removeAttribute('aria-disabled')
  for(const mode of ['reduced','off']){root.dataset.teMotion=mode;await settle();expect(getComputedStyle(toggle).scale==='none','reduced/off settings toggle moves')}
  root.dataset.teMotion='off'
}
window.clearSettingsControls=()=>{controlsFixture?.remove();controlsFixture=null}
window.checkDefaultSurfaceShadows=async()=>{
  await boot()
  await store.setActive({kind:'builtin',id:'builtin:twilight-echo-default'})
  document.documentElement.dataset.teMotion='off'
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
    mountSurfaces()
    await settle()
    checkShadow(surfaceFixture.querySelector('.track-table-wrapper'),'none',tone+' library table has no elevation')
    const cover=surfaceFixture.querySelector('.cover-frame')
    checkShadow(cover,tone==='dark'?'0 4px 12px rgba(0,0,0,.18)':'0 4px 12px rgba(15,23,42,.08)',tone+' artwork has a small single shadow')
    expect(shadowLayers(cover).length===1,tone+' artwork shadow layers')
    for(const selector of ['.glass-card','.device-card','.dsp-meter']){
      const element=surfaceFixture.querySelector(selector)
      checkShadow(element,'none',tone+' flat settings '+selector)
      expect(parseFloat(getComputedStyle(element).borderTopWidth)>0,tone+' settings border survives '+selector)
    }
    const device=surfaceFixture.querySelector('.device-card'),icon=document.createElement('i');device.prepend(icon);device.classList.add('active');await settle()
    checkShadow(device,'none',tone+' selected device stays flat')
    expect(shadowLayers(icon).every(value=>value.includes('inset')),tone+' device icon adds a drop shadow')
    device.classList.remove('active')
    const popup=surfaceFixture.querySelector('.settings-nav-results')
    expect(shadowLayers(popup).some(value=>!value.includes('inset')),tone+' floating search results keep elevation')
    mount('standard')
    await settle()
    const layers=shadowLayers(bar),external=layers.filter(value=>!value.includes('inset'))
    expect(external.length===1&&layers.length<=2,tone+' player bar uses one outer shadow and at most one inset')
    const probe=document.createElement('div')
    probe.style.boxShadow=tone==='dark'?'0 4px 12px rgba(0,0,0,.16)':'0 4px 12px rgba(15,23,42,.06)'
    document.body.append(probe)
    expect(external[0]===shadowLayers(probe)[0],tone+' player bar stays close to the surface')
    probe.remove()
    const slot=document.createElement('div')
    slot.className='player-cover-slot'
    slot.innerHTML='<img class="player-cover"><div class="player-cover-placeholder"></div>'
    for(const element of [slot,...slot.querySelectorAll('*')])element.setAttribute('data-v-test','')
    bar.querySelector('.player-left').prepend(slot)
    checkShadow(slot.querySelector('img'),'none',tone+' clipped artwork has no wasted image shadow')
    checkShadow(slot.querySelector('.player-cover-placeholder'),'none',tone+' placeholder has no extra shadow')
    expect(shadowLayers(slot).every(value=>value.includes('inset')),tone+' artwork slot has no drop shadow')
    const focus=document.createElement('button')
    focus.className='player-title-button'
    focus.textContent='Song title'
    focus.setAttribute('data-v-test','')
    bar.querySelector('.player-left').append(focus)
    focus.focus()
    const focusStyle=getComputedStyle(focus)
    expect(focus.matches(':focus-visible')&&parseFloat(focusStyle.outlineWidth)>=2&&focusStyle.outlineStyle!=='none',tone+' keyboard focus remains visible: '+[document.activeElement===focus,focus.matches(':focus-visible'),focusStyle.outlineWidth,focusStyle.outlineStyle,focusStyle.outlineColor].join('/'))
    focus.blur()
    const drawer=document.createElement('div')
    drawer.className='volume-drawer'
    drawer.setAttribute('data-v-test','')
    bar.append(drawer)
    expect(shadowLayers(drawer).some(value=>!value.includes('inset')),tone+' actual volume popup keeps elevation')
    expect(getComputedStyle(bar).overflowY==='visible',tone+' popup remains unclipped')
  }
  const custom=store.createProfile('Surface shadows')
  const overrides={'library.table.shadow':'0 3px 9px rgba(31,63,95,.3)','playback.cover.shadow':'0 5px 15px rgba(12,34,56,.4)','material.glassShadow':'0 7px 21px rgba(21,43,65,.5)'}
  custom.overrides={pureWhite:{...overrides},dark:{...overrides}}
  await store.preview(custom)
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
    mountSurfaces()
    await settle()
    checkShadow(surfaceFixture.querySelector('.track-table-wrapper'),overrides['library.table.shadow'],tone+' explicit library shadow stays supported')
    checkShadow(surfaceFixture.querySelector('.cover-frame'),overrides['playback.cover.shadow'],tone+' explicit artwork shadow stays supported')
    const glass=document.createElement('div')
    glass.style.boxShadow='var(--te-glass-shadow)'
    document.body.append(glass)
    checkShadow(glass,overrides['material.glassShadow'],tone+' explicit floating material shadow stays supported')
    glass.remove()
  }
  await store.preview(null)
  surfaceFixture.remove()
  document.querySelector('.player-bar-shell')?.remove()
}
window.prepareSurfaceShadowPreview=async(tone)=>{
  await store.setPreviewTone(tone)
  document.body.style.background=tone==='dark'?'#10141e':'#f6f7fb'
  mountSurfaces()
  mount('standard')
  const slot=document.createElement('div')
  slot.className='player-cover-slot'
  slot.innerHTML='<div class="player-cover-placeholder">♪</div>'
  for(const element of [slot,...slot.querySelectorAll('*')])element.setAttribute('data-v-test','')
  bar.querySelector('.player-left').prepend(slot)
  await settle()
}
window.clearSurfaceShadowPreview=()=>{
  surfaceFixture?.remove()
  document.querySelector('.player-bar-shell')?.remove()
  document.body.style.removeProperty('background')
}
const checkColors=async(overrides)=>{
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
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
  mount('compact',true)
  checkBackground(track,'#aa00aa','preview uses edited track')
  await store.preview(null)
  checkBackground(track,colors.dark['playback.progress.track'],'cancel restores saved track')
  const reset=structuredClone(profile)
  reset.overrides={pureWhite:{},dark:{}}
  await store.saveProfile(reset)
  await store.setActive({kind:'user',id:profile.id})
  mount('mini')
  checkBackground(fill,'#cc9900','reset restores cover progress color')
  checkBackground(button,'#cc9900','reset restores cover play color')
  checkBackground(stripButton,'transparent','reset restores standalone play surface')
  await store.saveProfile(profile)
  await store.setActive({kind:'user',id:profile.id})
  await store.setActive({kind:'builtin',id:'builtin:twilight-echo-default'})
  mount('compact')
  checkBackground(fill,'#cc9900','switching theme clears progress override')
  checkBackground(button,'#cc9900','switching theme clears play override')
  await store.setActive({kind:'user',id:profile.id})
}
window.preparePlayerThemeHover=async(tone,mode,glass)=>{
  await store.setPreviewTone(tone)
  mount(mode,glass)
  hoverTarget=mode==='standard'?button:stripButton
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
