import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import {
  DSP_EDITOR_WINDOW_NAME,
  isDspEditorWindowRequest
} from '../../../main/app/dspEditorWindow.ts'

const require = createRequire(import.meta.url)
test('production DSP components preserve draft, engine and resource contracts at responsive sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-dsp-workbench-'))
  const screenshots = resolve('tmp/dsp-workbench-qa')
  await mkdir(screenshots, { recursive: true })
  try {
    await writeFile(
      join(directory, 'player.ts'),
      `
      import { ref, shallowRef } from 'vue';
      export const audioProcessing = ref({dspEnabled:false,eqEnabled:true,eqMode:'parametric',eqPreamp:0,eqBands:[],fftEnabled:true,fftResolution:2048});
      export const outputInfo = ref({actualSampleRate:48000,outputSampleRate:48000,actualBitDepth:24,actualChannels:2,actualBackend:'WASAPI',actualDeviceName:'USB DAC · Headphones',exclusive:true,bufferSizeFrames:512,latencyMs:10.7,diagnostics:{sessionUnderrunCount:0,sessionBufferDropCount:0}});
      const currentTrack = shallowRef({id:'local',source:'local',filePath:'D:/music/test.wav',title:'Test'});
      export const playbackInfo = ref({isDsd:false,codec:'FLAC',sourceBitDepth:24,sourceSampleRate:96000,actualSampleRate:48000,decodedChannels:2,actualChannels:2});
      const isPlaying=ref(false),visualizationData=ref({active:false,spectrum:[],peakDb:-Infinity,rmsDb:-Infinity});
      const consumers=ref(0);
      export const usePlayerStore=()=>({currentTrack,playbackInfo,isPlaying,visualizationData,outputInfo,consumers,acquireVisualizationConsumer:()=>{consumers.value++;return ()=>{consumers.value--}}});
    `
    )
    await writeFile(
      join(directory, 'output.ts'),
      `
      import {ref} from 'vue'; import {defineStore} from 'pinia';import {audioProcessing,outputInfo,playbackInfo} from './player';
      const audioOutputConfig=ref({preferredBufferSize:512,routingMode:'auto'}),audioOutputConfigApplyStatus=ref({state:'applied',error:''}),bufferRequests=ref([]),bufferFailure=ref(false);
      export const useAudioOutputDspStore=defineStore('dsp-fixture',()=>({audioProcessing,outputInfo,playbackInfo,audioOutputConfig,audioOutputConfigApplyStatus,bufferRequests,bufferFailure,audioEngineReady:ref(true),audioDevice:ref('headphones'),audioDeviceOptions:ref([{id:'headphones',label:'USB DAC · Headphones'}]),audioOutputOptions:ref([{id:'wasapi',label:'WASAPI'}]),
      setAudioOutputConfig:async next=>{bufferRequests.value.push(next);if(bufferFailure.value){audioOutputConfigApplyStatus.value={state:'failed',error:'driver rejected buffer'};return}audioOutputConfig.value={...audioOutputConfig.value,...next};audioOutputConfigApplyStatus.value={state:'applied',error:''}},
      applyAudioProcessingState:next=>{audioProcessing.value=next},setAudioProcessing:async next=>{audioProcessing.value={...audioProcessing.value,...next}},toggleDspEnabled:async()=>{audioProcessing.value={...audioProcessing.value,dspEnabled:!audioProcessing.value.dspEnabled}}}));
    `
    )
    await build({
      root: resolve('.'),
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer/stores/usePlayerStore': join(directory, 'player.ts'),
          '@renderer/stores/useAudioOutputDspStore': join(directory, 'output.ts'),
          '@renderer': resolve('src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: require.resolve('pinia')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: resolve('scripts/fixtures/dsp-workbench.mjs'),
          name: 'DspWorkbenchTest',
          formats: ['iife'],
          fileName: 'runtime'
        },
        rollupOptions: { output: { inlineDynamicImports: true } }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8"><title>Twilight Echo · DSP 交互预览</title>${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}:root{--te-app-bg:#f7f8fa;--te-settings-text:#242934;--te-settings-text-muted:#727b89;--te-card-bg:#fff;--te-settings-control-bg:#fff;--te-settings-control-border:#dee2e8;--te-neutral-900:#242934;--te-neutral-600:#657080;--te-neutral-500:#727b89;--te-primary-500:#6e65cb;--te-neutral-50:#fff;--te-font-sans:system-ui,sans-serif}[data-theme=dark]{--te-app-bg:#181a20;--te-settings-text:#e3e7ef;--te-settings-text-muted:#919aaa;--te-card-bg:#22252c;--te-settings-control-bg:#22252c;--te-settings-control-border:#343943;--te-neutral-900:#e3e7ef;--te-neutral-600:#b1b8c4;--te-neutral-500:#919aaa;--te-primary-500:#afa6f6}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `
      const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
      const DSP_EDITOR_WINDOW_NAME=${JSON.stringify(DSP_EDITOR_WINDOW_NAME)}, acceptsPopup=${isDspEditorWindowRequest.toString()};
      app.setPath('userData',path.join(__dirname,'profile'));
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:1496,height:1000,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
        win.webContents.setWindowOpenHandler(({url,frameName})=>acceptsPopup(url,frameName)?{action:'allow',overrideBrowserWindowOptions:{show:false,width:1120,height:800}}:{action:'deny'});
        win.webContents.on('did-create-window',child=>{child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.webContents.on('will-navigate',event=>event.preventDefault())});
        win.webContents.on('console-message',(_e,_l,message)=>console.error(message));
        try{
          await win.loadFile(process.argv.at(-1));
          win.setContentSize(1496,1160);
          await win.webContents.executeJavaScript('window.renderWorkbench("monitor","pureWhite",false)');
          fs.writeFileSync(path.join(${JSON.stringify(screenshots)},'dsp-studio-overview.png'),(await win.webContents.capturePage()).toPNG());
          win.setContentSize(1496,1000);
          const result=await win.webContents.executeJavaScript('window.runWorkbenchCases()');console.log('DSP_WORKBENCH_UI_OK',JSON.stringify(result));
          const popout=await win.webContents.executeJavaScript('window.runPopoutCases()');console.log('DSP_WORKBENCH_POPOUT_OK',JSON.stringify(popout));
          for(const [content,width] of [[1440,1496],[1120,1176],[800,836],[600,636]])for(const tone of ['pureWhite','dark']){
            win.setContentSize(width,1000);
            for(const tab of ['chain','equalizer','library','monitor','output']){
              await win.webContents.executeJavaScript('window.renderWorkbench('+JSON.stringify(tab)+','+JSON.stringify(tone)+',false)');
              await new Promise(resolve=>setTimeout(resolve,80));
              fs.writeFileSync(path.join(${JSON.stringify(screenshots)},tab+'-'+content+'-'+tone+'.png'),(await win.webContents.capturePage()).toPNG());
            }
            await win.webContents.executeJavaScript('window.renderWorkbench("chain",'+JSON.stringify(tone)+',true)');
            fs.writeFileSync(path.join(${JSON.stringify(screenshots)},'large-'+content+'-'+tone+'.png'),(await win.webContents.capturePage()).toPNG());
          }
          win.setContentSize(1496,1000);
          await win.webContents.executeJavaScript('window.renderGraphicWorkbench()');
          fs.writeFileSync(path.join(${JSON.stringify(screenshots)},'graphic-1440-pureWhite.png'),(await win.webContents.capturePage()).toPNG());
          console.log('DSP_WORKBENCH_VISUAL_MATRIX_OK');app.exit(0);
        }catch(error){fs.writeFileSync(path.join(${JSON.stringify(screenshots)},'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);app.exit(1)}
      });
    `
    )
    await cp(join(directory, 'bundle'), join(screenshots, 'preview/bundle'), { recursive: true })
    await cp(join(directory, 'index.html'), join(screenshots, 'preview/index.html'))
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 120_000 }
    )
    assert.match(result.stdout, /DSP_WORKBENCH_UI_OK/)
    assert.match(result.stdout, /DSP_WORKBENCH_POPOUT_OK/)
    assert.match(result.stdout, /DSP_WORKBENCH_VISUAL_MATRIX_OK/)
    await writeFile(join(screenshots, 'component-results.log'), result.stdout + result.stderr)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
