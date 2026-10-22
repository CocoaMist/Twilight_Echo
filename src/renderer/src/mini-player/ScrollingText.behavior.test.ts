import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('mini titles coalesce measurements, release layers and follow font/width changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-marquee-'))
  try {
    const component = fileURLToPath(new URL('./ScrollingText.vue', import.meta.url)).replaceAll(
      '\\',
      '/'
    )
    await writeFile(
      join(directory, 'entry.mjs'),
      `import {createApp,h,ref,nextTick} from 'vue';import ScrollingText from ${JSON.stringify(component)};${fixture}`
    )
    await build({
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        lib: {
          entry: join(directory, 'entry.mjs'),
          name: 'MarqueeChecks',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><head>${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}</head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});await win.loadFile(path.join(__dirname,'index.html'));console.log('MARQUEE_CHECKS',JSON.stringify(await win.webContents.executeJavaScript('window.runMarqueeChecks()')));app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000 }
    )
    const counters = JSON.parse(result.stdout.match(/MARQUEE_CHECKS (.+)/)![1])
    assert.equal(counters.pendingFrames, 1)
    assert.equal(counters.framesAfterUnmount, 0)
    assert.equal(counters.updates, 100)
    console.info('Mini title Chromium checks:', JSON.stringify(counters))
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const fixture = `
const text=ref('Short'),width=ref('220px'),fontSize=ref('12px');
const app=createApp({setup:()=>()=>h('div',{style:{width:width.value,fontSize:fontSize.value,fontFamily:'monospace'}},[h(ScrollingText,{text:text.value})])});
app.mount('#app');
window.runMarqueeChecks=async()=>{
 const expect=(condition,message)=>{if(!condition)throw Error(message)};
 const wait=async condition=>{const end=Date.now()+3000;while(!condition()){expect(Date.now()<end,'marquee does not settle');await new Promise(resolve=>setTimeout(resolve,20))}};
 const root=()=>document.querySelector('.te-scroll-text'),inner=()=>document.querySelector('.te-scroll-text-inner');
 await wait(()=>inner()&&getComputedStyle(inner()).willChange==='auto');
 text.value='A long title that needs to scroll in its small window';await nextTick();
 await wait(()=>root().classList.contains('is-overflowing'));
 width.value='1600px';await nextTick();await wait(()=>!root().classList.contains('is-overflowing'));
 expect(root().querySelectorAll('.te-scroll-text-item').length===1,'wide title retains duplicated text');
 width.value='220px';text.value='TwelveChars!';await nextTick();await wait(()=>!root().classList.contains('is-overflowing'));
 fontSize.value='48px';await nextTick();await wait(()=>root().classList.contains('is-overflowing'));
 expect(getComputedStyle(inner()).willChange==='transform','overflowing title does not prepare its animation');
 fontSize.value='12px';await nextTick();await wait(()=>!root().classList.contains('is-overflowing'));
 expect(getComputedStyle(inner()).willChange==='auto','non-overflowing title keeps a compositor layer');
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,frames=new Map();let id=0;
 window.requestAnimationFrame=callback=>{frames.set(++id,callback);return id};window.cancelAnimationFrame=handle=>frames.delete(handle);
 let pendingFrames,framesAfterUnmount;
 try{
  for(let i=0;i<100;i++){text.value='Update '+i;await nextTick()}
  pendingFrames=frames.size;expect(pendingFrames===1,'text updates queue redundant animation frames');
  app.unmount();framesAfterUnmount=frames.size;expect(framesAfterUnmount===0,'unmounted title keeps a pending measurement');
 }finally{window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel}
 return {pendingFrames,framesAfterUnmount,updates:100,fontResizeObserved:true,wideTitleUnduplicated:true};
};
`
