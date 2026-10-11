import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compileStyle, parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../', import.meta.url))

test('Bohr reflections survive body diffusion, preserve input, and clean up with the material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-bohr-'))
  try {
    const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8')
    const global =
      (await read('src/renderer/src/assets/base.css')) +
      (await read('src/renderer/src/assets/bohr.css'))
    const styles = [
      await read('src/renderer/src/components/player-bar/PlayerBar.css'),
      await read('src/renderer/src/components/settings-page/SettingsPage.css'),
      parse(await read('src/renderer/src/components/TitleBar.vue')).descriptor.styles[0].content
    ].map((source) => {
      const result = compileStyle({ source, filename: 'Bohr.css', id: 'data-v-bohr', scoped: true })
      assert.deepEqual(result.errors, [])
      return result.code
    })
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root,
      plugins: [vue()],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: { alias: { '@renderer': join(root, 'src/renderer/src') } },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'BohrTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32" data-theme="dark"><head><meta charset="utf-8">
      <style>${global}\n${styles.join('\n')}
      *,*::before,*::after{transition:none!important}
      body{margin:0;background:#17181a;padding:100px 40px;color:#eee}
      .backdrop{height:460px;border-radius:24px;background:linear-gradient(125deg,#677773,#805440 44%,#172e4a);padding:28px;font-size:32px}
      .player-bar[data-v-bohr]{position:absolute;top:220px;left:40px;right:40px;width:auto}
      .player-left,.player-center,.player-right{grid-row:1}
      .player-left{grid-column:1}.player-center{grid-column:2}.player-right{grid-column:3}
      .player-center{display:flex;align-items:center;justify-content:center}
      button{border:0;color:inherit;background:#ffffff12;border-radius:16px;padding:8px 24px}
      .settings-preview-nav{top:390px;left:70px;transform:none}
      </style></head><body>
      <div class="title-bar" data-v-bohr><div class="title-bar-background" data-v-bohr></div></div>
      <div class="backdrop">波尔 · 透光的体积<br><small>温润弧面 · 清晰内容 · 柔和光影</small></div>
      <div class="player-bar player-bar-liquid" data-v-bohr>
        <span class="player-bar-warp" data-v-bohr aria-hidden="true"></span>
        <span class="player-bar-optics" data-v-bohr aria-hidden="true"></span>
        <div class="player-left" data-v-bohr>Monsters In The Dark</div>
        <div class="player-center" data-v-bohr><button id="play">▶</button></div>
        <div class="player-right" data-v-bohr>♡  ⇆  ☷</div>
      </div>
      <nav class="settings-preview-nav" data-v-bohr>基础设置<br>播放与音频<br>界面外观</nav>
      <div id="defs"></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:700,webPreferences:{contextIsolation:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 try{
  await win.loadFile(process.argv.at(-1));
  await win.webContents.executeJavaScript('window.runBohrTests()');
  win.webContents.debugger.attach('1.3');
  for(const [name,value] of [['prefers-contrast','more'],['prefers-reduced-transparency','reduce'],['forced-colors','active']]){
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name,value}]});
   await win.webContents.executeJavaScript('window.checkBohrAccessibility()');
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  if(process.env.TE_BOHR_EVIDENCE_DIR){
   for(const tone of ['dark','pureWhite']){
    await win.webContents.executeJavaScript('window.prepareBohrEvidence('+JSON.stringify(tone)+')');
    await new Promise(resolve=>setTimeout(resolve,200));
    fs.writeFileSync(require('node:path').join(process.env.TE_BOHR_EVIDENCE_DIR,'bohr-'+tone+'.png'),(await win.webContents.capturePage()).toPNG());
   }
  }
  await win.webContents.executeJavaScript('window.unmountBohr()');
  console.error('BOHR_MATERIAL_OK');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(stderr, /BOHR_MATERIAL_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {h,render,nextTick} from 'vue'
import LiquidGlassDefs from '@renderer/components/LiquidGlassDefs.vue'
const root=document.documentElement
const host=document.getElementById('defs')
const optics=document.querySelector('.player-bar-optics')
const bar=document.querySelector('.player-bar')
const expect=(value,message)=>{if(!value)throw new Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
const mount=async(active)=>{render(h(LiquidGlassDefs,{active,followPointer:false,homeCardsActive:false,expandedActive:false}),host);await settle()}
const reflection=()=>getComputedStyle(optics,'::after')
window.runBohrTests=async()=>{
 root.setAttribute('data-te-surface-material','liquidGlass')
 root.style.setProperty('--te-lg-specular','0.76')
 await mount(true)
 expect(reflection().maskImage.includes('data:image/png'),'measured reflection map is composited above the backdrop')
 expect(Number(reflection().opacity)>0,'reflection is visible')
 expect(reflection().filter==='none'&&reflection().backdropFilter==='none','surface light is never blurred or dimmed with the backdrop')
 expect(getComputedStyle(optics).pointerEvents==='none','optical layers do not intercept input')
 const button=document.getElementById('play'),rect=button.getBoundingClientRect()
 expect(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button,'play target remains above the optical layer: '+JSON.stringify({x:rect.x,y:rect.y,w:rect.width,h:rect.height,hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.outerHTML.slice(0,100)}))
 const geometry=bar.getBoundingClientRect()
 await mount(false)
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-map'),'disabled material releases the raster reference')
 expect(Number(reflection().opacity)===0,'disabled material has no residual highlight')
 await mount(true)
 root.style.setProperty('--te-lg-specular','0')
 window.dispatchEvent(new Event('twilight:liquid-glass-tuning-changed'))
 await settle()
 expect(Number(reflection().opacity)===0,'zero highlight preserves user preference')
 for(const tone of ['pureWhite','dark']){
  root.setAttribute('data-theme',tone)
  expect(getComputedStyle(bar).boxShadow.includes(tone==='dark'?'0, 0, 0':'18, 24, 32'),'elevation follows theme tone')
  const after=bar.getBoundingClientRect()
  expect(after.height===geometry.height&&after.width===geometry.width,'material does not change bar geometry')
 }
 for(const disabled of ['class','data-te-effects-mode']){
  if(disabled==='class')document.body.classList.add('te-no-blur');else root.setAttribute(disabled,'reduced')
  window.checkBohrAccessibility()
  if(disabled==='class')document.body.classList.remove('te-no-blur');else root.removeAttribute(disabled)
 }
}
window.checkBohrAccessibility=()=>expect(getComputedStyle(optics).display==='none','accessibility removes decorative reflections')
window.prepareBohrEvidence=async(tone)=>{
 root.setAttribute('data-theme',tone)
 document.body.style.background=tone==='dark'?'#17181a':'#f4f4f7'
 document.body.style.color=tone==='dark'?'#eeeeee':'#181a20'
 root.style.setProperty('--te-lg-specular','0.76')
 window.dispatchEvent(new Event('twilight:liquid-glass-tuning-changed'))
 await mount(true)
}
window.unmountBohr=async()=>{
 render(null,host);await settle()
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-map'),'unmount releases the raster reference')
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-strength'),'unmount releases reflection strength')
}
`
