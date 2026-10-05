import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('fixed title chrome keeps one frosted surface over scrolling pages in both tones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-title-chrome-'))
  try {
    const entry = join(directory, 'entry.mjs')
    await writeFile(
      entry,
      `import {createApp,h,nextTick,ref} from 'vue';
import TitleBar from '${fileURLToPath(new URL('./TitleBar.vue', import.meta.url)).replaceAll('\\', '/')}';
import '${join(workspace, 'src/renderer/src/assets/base.css').replaceAll('\\', '/')}';
import '${join(workspace, 'src/renderer/src/assets/theme-layouts/index.css').replaceAll('\\', '/')}';
const calls={back:0,minimize:0,maximize:0,close:0};
window.api={window:{getState:async()=>({maximized:false}),onStateChanged:()=>()=>{},minimize:()=>calls.minimize++,toggleMaximize:()=>calls.maximize++,close:()=>calls.close++}};
const mode=ref('default');
createApp({render:()=>h(TitleBar,{menuOpen:false,titleSurface:mode.value==='settings'?'settings':mode.value==='streaming'?'streaming':'default',glass:mode.value==='playing',liquidMaterial:mode.value==='liquid',onBack:()=>calls.back++})}).mount('#app');
const frame=()=>new Promise(requestAnimationFrame);
window.prepareChrome=async(tone,transparent,surface,preset)=>{
 document.documentElement.dataset.theme=tone;
 document.documentElement.dataset.windowTransparent=transparent?'on':'off';
 document.documentElement.dataset.tePresetLayout=preset;
 document.documentElement.dataset.teLiquidGlassSource='solid';
 document.documentElement.dataset.teLiquidGlassScrolled='off';
 mode.value=surface;document.documentElement.scrollTop=0;await nextTick();await frame();await frame();
 const bar=document.querySelector('.title-bar'),layer=bar.querySelector('.title-bar-background');
 const signature=()=>{const s=getComputedStyle(layer);return JSON.stringify([s.backgroundColor,s.backgroundImage,s.backdropFilter,s.boxShadow])};
 const before=signature(),height=bar.getBoundingClientRect().height;
 if(bar.getBoundingClientRect().top!==0||getComputedStyle(bar).position!=='fixed')throw Error('chrome is not fixed');
 if(!getComputedStyle(layer).backdropFilter.includes('blur(12px)'))throw Error('missing frosted layer');
 document.documentElement.scrollTop=600;document.documentElement.dataset.teLiquidGlassScrolled='on';await frame();await frame();
 if(bar.getBoundingClientRect().top!==0||bar.getBoundingClientRect().height!==height||signature()!==before)throw Error('scroll changed chrome geometry or material');
 return height;
};
window.checkChromeControls=async()=>{
 for(const label of ['返回','最小化','最大化窗口','关闭窗口'])document.querySelector('[aria-label="'+label+'"]').click();
 if(Object.values(calls).some(value=>value!==1))throw Error('window controls or back events lost');
 document.body.classList.add('te-no-blur');await frame();
 const layer=document.querySelector('.title-bar-background'),s=getComputedStyle(layer);
 if(s.backdropFilter!=='none'||s.backgroundColor==='rgba(0, 0, 0, 0)')throw Error('no-blur fallback is not opaque');
 return calls;
};`
    )
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'title-chrome-native-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (!importer?.split('?')[0].replaceAll('\\', '/').endsWith('/TitleBar.vue'))
              return null
            if (source.includes('useNcmStore')) return '\0chrome:ncm'
            if (source.includes('useBackStack')) return '\0chrome:back'
            if (source.endsWith('/TaskCenter.vue')) return '\0chrome:tasks'
            return null
          },
          load(id) {
            if (id === '\0chrome:ncm')
              return "import{ref}from'vue';export const useNcmStore=()=>({isLoggedIn:ref(false),profile:ref(null)});"
            if (id === '\0chrome:back')
              return "import{ref}from'vue';export const useBackStack=()=>({canGoBack:ref(true),backHint:ref('返回')});"
            if (id === '\0chrome:tasks')
              return "import{h}from'vue';export default{render:()=>h('button',{class:'control-btn'},'任务与通知')};"
            return null
          }
        },
        vue()
      ],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: { entry, name: 'ChromeTests', formats: ['iife'], fileName: 'runtime' }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head>${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>html,body{margin:0;min-height:3000px}body::before,body::after{display:none!important}.scenery{position:absolute;inset:0;height:3000px;background:repeating-linear-gradient(black 0 2px,white 2px 4px)}#app{position:relative}</style></head><body><div class="scenery"></div><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('force-device-scale-factor','1');
app.setPath('userData',require('node:path').join(process.argv.at(-1),'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});win.setContentSize(1000,800);
try{await win.loadFile(require('node:path').join(process.argv.at(-1),'index.html'));let count=0;
for(const tone of ['pureWhite','dark'])for(const transparent of [false,true])for(const surface of ['default','settings','streaming','playing','liquid']){
 await win.webContents.executeJavaScript('window.prepareChrome('+JSON.stringify(tone)+','+transparent+','+JSON.stringify(surface)+',"default")');
 const shot=await win.webContents.capturePage({x:300,y:3,width:1,height:27});const pixels=shot.toBitmap();
 for(let channel=0;channel<3;channel++){const values=[];for(let i=channel;i<pixels.length;i+=4)values.push(pixels[i]);if(Math.max(...values)-Math.min(...values)>20)throw Error('scrolling stripes remain visible through chrome: '+tone+'/'+surface)}count++;
}
for(const preset of ['aurora-reference','obsidian-glass','paper-light','neon-gradient','studio-split','zen-minimal']){
 await win.webContents.executeJavaScript('window.prepareChrome("pureWhite",false,"default",'+JSON.stringify(preset)+')');count++;
}
await win.webContents.executeJavaScript('window.checkChromeControls()');console.log('TITLE_CHROME_OK '+count);app.exit(0);
}catch(error){console.error(error.stack);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), directory],
      { env, timeout: 45000, maxBuffer: 4 * 1024 * 1024 }
    )
    assert.match(result.stdout, /TITLE_CHROME_OK 26/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
