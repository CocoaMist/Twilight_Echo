import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)

test('text rendering changes actual glyph pixels, survives themes and restores failed saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-font-rendering-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [vue()],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'FontRenderingTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<style>
body{margin:0;overflow:auto}#app{padding:44px;min-height:100vh;box-sizing:border-box}
.fixture-panel{position:relative;z-index:1;max-width:940px;margin:70px auto;padding:28px;border-radius:20px;background:color-mix(in srgb,var(--te-app-bg) 65%,transparent);backdrop-filter:blur(16px)}
.fixture-panel h1{font-size:22px;margin:0 0 8px}.fixture-panel p{margin:0 0 20px;color:var(--te-neutral-500)}
.fixture-text{font:14px/2 Arial,'Microsoft YaHei',sans-serif;color:var(--te-neutral-900);padding:16px}
.fixture-text small{display:block;color:var(--te-neutral-500)}
.fixture-wallpaper{position:fixed;inset:0;z-index:0;pointer-events:none;background:linear-gradient(120deg,#72849a,#b09a9d 40%,#838da0 70%,#bbc2ba);filter:blur(20px)}
</style></head><body><div class="fixture-wallpaper"></div><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000 }
    )
    assert.match(result.stdout, /FONT_RENDERING_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1160,height:640,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(process.argv.at(-1));
  await win.webContents.executeJavaScript('window.runFontRenderingTests()');
  const evidence=process.env.TWILIGHT_FONT_RENDERING_EVIDENCE_DIR;
  if(evidence)fs.mkdirSync(evidence,{recursive:true});
  for(const tone of ['pureWhite','dark']){
   const glyphs={},backgrounds={};
   for(const mode of ['auto','smooth','crisp']){
    const bounds=await win.webContents.executeJavaScript('window.prepareFontRendering('+JSON.stringify(mode)+','+JSON.stringify(tone)+')');
    glyphs[mode]=(await win.webContents.capturePage(bounds)).toBitmap();
    backgrounds[mode]=(await win.webContents.capturePage({x:20,y:20,width:1,height:1})).toBitmap();
    if(evidence)fs.writeFileSync(path.join(evidence,'font-'+tone+'-'+mode+'.png'),(await win.webContents.capturePage()).toPNG());
   }
   if(glyphs.crisp.equals(glyphs.smooth)||glyphs.crisp.equals(glyphs.auto))throw new Error(tone+': crisp mode must change actual text pixels');
   if(!backgrounds.crisp.equals(backgrounds.smooth)||!backgrounds.crisp.equals(backgrounds.auto))throw new Error(tone+': font mode changed the wallpaper');
  }
  win.setSize(620,640);
  await win.webContents.executeJavaScript('window.settleFontRendering()');
  if(await win.webContents.executeJavaScript('document.documentElement.scrollWidth>document.documentElement.clientWidth'))throw new Error('font controls overflow narrow window');
  if(evidence)fs.writeFileSync(path.join(evidence,'font-narrow.png'),(await win.webContents.capturePage()).toPNG());
  console.log('FONT_RENDERING_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
})
`

const runtime = `
import {createApp,h,nextTick} from 'vue'
import FontRenderingSettings from '@renderer/components/settings-page/FontRenderingSettings.vue'
import '@renderer/assets/base.css'
import '@renderer/components/settings-page/SettingsPage.css'
import {useSettingsStore} from '@renderer/stores/useSettingsStore.ts'
import {bootstrapThemeRuntime,useThemeStore} from '@renderer/stores/useThemeStore.ts'
import {injectCachedThemeRuntime} from '@renderer/app/themeRuntimeCache.ts'
import {createDefaultThemeLibraryDocument} from '@shared/theme.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const settle=async()=>{await nextTick();for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(resolve))}
window.settleFontRendering=settle
const settingsStore=useSettingsStore(),theme=useThemeStore(),writes=[]
let confirmed={...settingsStore.settings.value,theme:'dark'},failSave=false,releaseSave=null
const snapshot=()=>({settings:confirmed,defaults:confirmed,paths:{},appVersion:'test',platform:'win32',windowTransparencySupported:false,restartReasons:[]})
const startup=()=>({systemTone:'dark',settings:snapshot(),themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
window.api={settings:{onChanged:()=>()=>{},get:async()=>snapshot(),update:async patch=>{
 if(failSave)throw new Error('测试保存失败')
 if(releaseSave!==null)await new Promise(resolve=>{releaseSave=resolve})
 writes.push(patch);confirmed={...confirmed,...patch};return snapshot()
}},themes:{onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{}},plugins:{onChanged:()=>()=>{}}}
createApp({setup(){return()=>h('section',{class:'fixture-panel settings-preview-page',style:{position:'relative',inset:'auto',height:'auto'}},[
 h('h1','外观 · 文字渲染'),h('p','保留背景与模糊效果，选择适合你的文字显示。'),h(FontRenderingSettings),
 h('div',{class:'fixture-text'},['夜航星 · Twilight Echo · 0123456789',h('small','本地音乐  /  我的收藏  /  设置'),h('i',{class:'pi pi-check','aria-hidden':'true'})]),
 h('div',{class:'lyric-custom',style:{webkitTextStroke:'0.7px red'}},'歌词自定义描边')
])}}).mount('#app')
const button=mode=>document.querySelectorAll('[aria-labelledby="font-rendering-label"] button')[['auto','crisp','smooth'].indexOf(mode)]
const stroke=()=>getComputedStyle(document.querySelector('.fixture-text')).webkitTextStrokeWidth
const wallpaper=()=>getComputedStyle(document.querySelector('.fixture-wallpaper')).cssText+'|'+getComputedStyle(document.querySelector('.fixture-wallpaper')).filter+'|'+getComputedStyle(document.querySelector('.fixture-wallpaper')).backgroundImage
window.runFontRenderingTests=async()=>{
 settingsStore.hydrateStartupSnapshot(startup());await bootstrapThemeRuntime(startup());await settle()
 expect(button('auto').getAttribute('aria-pressed')==='true','automatic default is not selected')
 const width=document.querySelector('.font-rendering-sample').getBoundingClientRect().width
 const backdrop=wallpaper()
 releaseSave=()=>{};button('crisp').click();await settle()
 expect(writes.length===0,'deferred save unexpectedly finished')
 expect(stroke()==='0.2px','crisp did not apply before the IPC save returned')
 expect(button('crisp').getAttribute('aria-pressed')==='true','selection not updated immediately')
 const release=releaseSave;releaseSave=null;release();await settle()
 expect(confirmed.fontRendering==='crisp','crisp choice did not persist')
 const savedCount=writes.length;button('crisp').click();await settle();expect(writes.length===savedCount,'unchanged choice was saved again')
 expect(document.querySelector('.font-rendering-sample').getBoundingClientRect().width===width,'crisp changed text layout')
 expect(wallpaper()===backdrop,'crisp changed backdrop effects')
 expect(getComputedStyle(document.querySelector('.pi')).webkitTextStrokeWidth==='0px','crisp thickened icon glyphs')
 expect(getComputedStyle(document.querySelector('.lyric-custom')).webkitTextStrokeWidth==='0.7px','crisp overrode custom lyrics')
 const muted=document.querySelector('.fixture-text small'),mutedStyle=getComputedStyle(muted)
 expect(mutedStyle.webkitTextStrokeColor===mutedStyle.color,'muted text stroke used an ancestor color')
 for(const tone of ['pureWhite','dark'])for(const material of ['standard','transparent','liquidGlass']){
  await settingsStore.updateSettings({surfaceMaterial:material});await theme.setPreviewTone(tone);await settle()
  expect(stroke()==='0.2px','theme or material discarded crisp preference')
 }
 expect(injectCachedThemeRuntime(),'saved startup theme cache cannot be restored');await settle()
 expect(stroke()==='0.2px','startup cache discarded crisp preference')
 settingsStore.hydrateStartupSnapshot(startup());await bootstrapThemeRuntime(startup());await settle()
 expect(stroke()==='0.2px','restart discarded crisp preference')
 failSave=true;button('smooth').click();await settle();failSave=false
 expect(settingsStore.lastSettingsError.value==='测试保存失败','save error was hidden')
 expect(settingsStore.settings.value.fontRendering==='crisp'&&stroke()==='0.2px','failed save did not restore confirmed rendering')
 button('smooth').focus();button('smooth').dispatchEvent(new MouseEvent('click',{bubbles:true}));await settle()
 expect(stroke()==='0px','smooth did not remove the crisp stroke')
 expect(button('smooth').getAttribute('aria-pressed')==='true','smooth selection not accessible')
 button('auto').click();await settle();expect(stroke()==='0px','auto retained a stale stroke')
 delete confirmed.fontRendering;settingsStore.hydrateStartupSnapshot(startup());await settle()
 expect(settingsStore.settings.value.fontRendering==='auto','old settings did not migrate to auto')
 confirmed.fontRendering='invalid';settingsStore.hydrateStartupSnapshot(startup());await settle()
 expect(settingsStore.settings.value.fontRendering==='auto','unknown setting did not fall back')
 confirmed.fontRendering='auto'
}
window.prepareFontRendering=async(mode,tone)=>{
 await settingsStore.updateSettings({fontRendering:mode,surfaceMaterial:'transparent'});await theme.setPreviewTone(tone);await settle()
 const rect=document.querySelector('.fixture-text').getBoundingClientRect()
 return {x:Math.ceil(rect.x),y:Math.ceil(rect.y),width:Math.floor(rect.width),height:Math.floor(rect.height)}
}
`
