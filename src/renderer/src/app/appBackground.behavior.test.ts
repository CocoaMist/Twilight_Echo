import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileStyle } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('configured wallpapers remain visible through liquid glass on local and streaming pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-background-'))
  try {
    const [base, home] = await Promise.all([
      readFile(new URL('../assets/base.css', import.meta.url), 'utf8'),
      readFile(new URL('../components/LocalDashboard.css', import.meta.url), 'utf8')
    ])
    const style = compileStyle({
      source: home,
      filename: 'LocalDashboard.css',
      id: 'data-v-test',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
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
          name: 'BackgroundTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>${base}\n${style.code}</style></head><body><div id="app"><div class="home" data-v-test></div></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron')
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
  try{
    await win.loadFile(process.argv.at(-1))
    await win.webContents.executeJavaScript('window.runBackgroundTests()')
    // Inspect the actual pixels, as a correctly resolved CSS token can still be covered.
    const image=await win.webContents.capturePage({x:400,y:300,width:1,height:1})
    const pixel=image.toBitmap()
    if(pixel[0]!==86||pixel[1]!==52||pixel[2]!==18)throw new Error('Home wallpaper is obscured: '+[...pixel])
    console.log('APP_BACKGROUND_OK')
    app.exit(0)
  }catch(error){console.error(error.stack);app.exit(1)}
})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /APP_BACKGROUND_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {bootstrapThemeRuntime,syncThemeSettingsAppearance,useThemeStore} from '@renderer/stores/useThemeStore.ts'
import {createDefaultThemeLibraryDocument} from '@shared/theme.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const wallpaper=(color)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><path fill="'+color+'" d="M0 0h800v600H0z"/></svg>')
const globalImage=wallpaper('#123456')
const pageImage=wallpaper('#654321')
const pair={kind:'image',light:'#f4f4f7',dark:'#0f1114',image:globalImage}
const pages=Object.fromEntries(['local','settings','streaming','player'].map(page=>[page,{...pair,inherit:true}]))
const settings={theme:'pureWhite',accentColor:'blue',uiDensity:'comfortable',surfaceMaterial:'liquidGlass',appBackground:{global:{...pair},pages}}
window.api={
  settings:{onChanged:()=>()=>{}},
  plugins:{onChanged:()=>()=>{}},
  themes:{onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{}}
}
const store=useThemeStore()
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
const apply=async(tone)=>{
  syncThemeSettingsAppearance(settings)
  // This awaits the theme application triggered by the current settings snapshot.
  await store.setPreviewTone(tone)
  await settle()
}
const checkImage=(expected,label)=>{
  const actual=getComputedStyle(document.body).backgroundImage
  if(expected){
    expect(actual.startsWith('url("'+expected+'")'),label+': configured image is not the top layer: '+actual)
  }else{
    expect(!actual.includes('url('),label+': removed image is still visible: '+actual)
  }
  expect(getComputedStyle(document.querySelector('.home')).backgroundColor==='rgba(0, 0, 0, 0)',label+': homepage must reveal the shared wallpaper')
}
window.runBackgroundTests=async()=>{
  for(const url of [globalImage,pageImage]){
    const image=new Image();image.src=url;await image.decode()
  }
  await bootstrapThemeRuntime({systemTone:'pureWhite',settings:{settings},themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
  for(const tone of ['pureWhite','dark'])for(const material of ['liquidGlass','standard']){
    settings.surfaceMaterial=material
    for(const page of ['local','streaming']){
      document.body.className='te-'+page+'-surface'
      const label=tone+'/'+material+'/'+page
      pages[page].inherit=true
      await apply(tone)
      checkImage(globalImage,label+' inherited')
      pages[page]={...pair,inherit:false,image:pageImage}
      await apply(tone)
      checkImage(pageImage,label+' override')
      pages[page].kind='color'
      await apply(tone)
      checkImage(null,label+' color override')
      pages[page].inherit=true
      await apply(tone)
      checkImage(globalImage,label+' inheritance restored')
    }
  }
  settings.surfaceMaterial='liquidGlass'
  settings.appBackground.global.image=''
  document.body.className='te-local-surface'
  await apply('pureWhite')
  checkImage(null,'removed global image')
  expect(getComputedStyle(document.body).backgroundImage.includes('radial-gradient'),'default liquid-glass lighting remains available')
  settings.appBackground.global.image=globalImage
  await apply('pureWhite')
  // App.vue retains te-local-surface while showing settings; returning home must restore its image.
  pages.settings={...pair,inherit:false,image:pageImage}
  document.body.classList.add('te-settings-surface')
  await apply('pureWhite')
  checkImage(pageImage,'settings page override')
  document.body.classList.remove('te-settings-surface')
  await settle()
  checkImage(globalImage,'return from settings')
}
`
