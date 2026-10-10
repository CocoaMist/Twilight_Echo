import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const source = readFileSync(new URL('./PlaybackSettingsSection.vue', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)

test('automatic exclusive release uses the persisted setting and an accessible dependent switch', () => {
  assert.match(source, /audioExclusiveAutoRelease: !settings\.value\.audioExclusiveAutoRelease/)
  assert.match(source, /aria-label="独占模式自动启停"/)
  assert.match(source, /:aria-checked="settings\.audioExclusiveAutoRelease"/)
  assert.match(
    source,
    /:disabled="!exclusiveAvailable \|\| !exclusiveMode \|\| exclusiveAutoReleaseApplying"/
  )
  assert.match(source, /outputInfo\?\.outputReleased && playbackInfo\?\.state === 'paused'/)
})

test('playback diagnostics expose the active PCM provider implementation', () => {
  assert.match(
    source,
    /const outputProviderImplementation = computed\(\s*\(\) => outputInfo\.value\?\.providerImplementation \?\? ''\s*\)/
  )
  assert.match(
    source,
    /<span v-if="outputProviderImplementation">[\s\S]*Provider \{\{ outputProviderImplementation \}\}/
  )
})

test('released output replaces playback proof and the HiFi occupancy label', () => {
  const playerBar = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  assert.match(playerBar, /if \(outputInfo\.value\?\.outputReleased\) \{\s*return \[/)
  assert.match(playerBar, /:output-released="outputInfo\?\.outputReleased"/)
  assert.match(sidebar, /if \(props\.outputReleased\) return `\$\{backend\} · RELEASED`/)
})

test('playback policy and target rate survive settings reload and component reopen in both directions', async () => {
  const playerSource = readFileSync(
    new URL('../../stores/usePlayerStore.ts', import.meta.url),
    'utf8'
  )
  const watcher = playerSource.match(
    /watch\(\r?\n  \(\) => appSettings\.value\?\.audioOutputConfig,[\s\S]*?\r?\n\)/
  )?.[0]
  const processing = playerSource.match(
    /const defaultAudioProcessing: AudioProcessingSettings = ([\s\S]*?)\r?\nconst audioProcessing/
  )?.[1]
  assert.ok(watcher && processing, 'actual player configuration watcher and defaults are required')
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playback-policy-'))
  try {
    await writeFile(join(directory, 'entry.ts'), policyRuntime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [
        {
          name: 'playback-policy-native-boundary',
          enforce: 'pre',
          resolveId(id) {
            if (id === 'policy-state') return '\0policy-state'
            if (/\/useSettingsStore$/.test(id)) return '\0policy-settings'
            if (/\/usePlayerStore$/.test(id)) return '\0policy-player'
            if (/\/useAudioOutputDspStore$/.test(id)) return '\0policy-dsp'
            if (id.endsWith('/AudioDeviceProfilesPanel.vue')) return '\0policy-profiles'
            return null
          },
          load(id) {
            if (id === '\0policy-state')
              return policyState
                .replace('/* ACTUAL_WATCHER */', watcher!)
                .replace('/* ACTUAL_PROCESSING */', processing!)
            if (id === '\0policy-settings') return "export {useSettingsStore} from 'policy-state'"
            if (id === '\0policy-player') return "export {usePlayerStore} from 'policy-state'"
            if (id === '\0policy-dsp') return "export {useAudioOutputDspStore} from 'policy-state'"
            if (id === '\0policy-profiles') return 'export default {render:()=>null}'
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: resolve(require.resolve('pinia'), '../dist/pinia.mjs')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PolicyTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{offscreen:true,backgroundThrottling:false}});win.webContents.on('console-message',(_event,_level,message)=>console.error(message));try{await win.loadFile(require('node:path').join(__dirname,'index.html'));const result=await win.webContents.executeJavaScript('window.runPolicyTests().catch(error=>error.stack)');if(!result.startsWith('PLAYBACK_POLICY_OK'))throw Error(result);console.log(result);app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      windowsHide: true,
      timeout: 60_000,
      env
    })
    assert.match(result.stdout, /PLAYBACK_POLICY_OK/)
    console.log(result.stdout.trim())
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    assert.ok(directory.includes('twilight-playback-policy-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const policyState = `
import {ref,watch} from 'vue'
import {defineStore} from 'pinia'
import {normalizeOutputConfig} from '@shared/audioOutputConfig.ts'
import {createAudioOutputController} from '@renderer/stores/player/audioOutputController.ts'
export const persisted=ref(normalizeOutputConfig({pcmToDsdMode:'dsd128',dsdMutePreRollFrames:1024}))
export const engine=ref({...persisted.value})
export const appSettings=ref({audioOutputConfig:{...persisted.value},sleepTimer:{defaultMinutes:30,fadeSeconds:0}})
export const audioOutputConfig=ref(normalizeOutputConfig())
/* ACTUAL_WATCHER */
const audioProcessing=ref(/* ACTUAL_PROCESSING */)
const exclusiveMode=ref(false)
const audioOutputConfigApplyStatus=ref({state:'idle',requestedRevision:0,appliedRevision:0,failedRevision:0,error:''})
const controller=createAudioOutputController({exclusiveMode,audioProcessing,audioOutputConfig,audioOutputConfigApplyStatus,dspOutputStage:ref({}),dspStereoImage:ref({}),getAudioEngineApi:()=>({setOutputConfig:async config=>{engine.value=normalizeOutputConfig(config);persisted.value={...engine.value};return {...engine.value}},getOutputConfigApplyStatus:async()=>({state:'applied',requestedRevision:1,appliedRevision:1,failedRevision:0,error:''})}),setAudioEngineError:()=>{},refreshPlaybackInfo:async()=>{},scheduleCrossfadeIfNeeded:()=>{}})
export const useAudioOutputDspStore=defineStore('policy-output',()=>({exclusiveMode,audioOutput:ref('wasapi'),audioDevice:ref('auto'),audioOutputOptions:ref([]),audioDeviceOptions:ref([]),audioOutputDeviceOptions:ref([]),audioProcessing,audioOutputConfig,audioOutputConfigApplyStatus,playbackInfo:ref(null),outputInfo:ref(null),audioEngineError:ref(null),...controller,refreshAudioOutputState:async()=>{}}))
export const useSettingsStore=()=>({settings:appSettings,updateSettings:async()=>{}})
export const usePlayerStore=()=>({volume:ref(.7),setVolume:()=>{},setUnityVolume:()=>{}})
export const reload=()=>{appSettings.value={...appSettings.value,audioOutputConfig:JSON.parse(JSON.stringify(persisted.value))}}
`

const policyRuntime = `
import {createApp,h,nextTick,ref} from 'vue'
import {createPinia} from 'pinia'
import PlaybackSettingsSection from '@renderer/components/settings-page/PlaybackSettingsSection.vue'
import {reload,audioOutputConfig,persisted,engine,appSettings} from 'policy-state'
const expect=(value,message)=>{if(!value)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(resolve));await nextTick()}
window.runPolicyTests=async()=>{
 const open=ref(true)
 const app=createApp({render:()=>open.value?h(PlaybackSettingsSection):null})
 app.use(createPinia());app.mount('#app');await settle()
 const policy=()=>document.querySelector('select[aria-label="连续播放策略"]')
 const rate=()=>document.querySelector('select[aria-label="连续播放目标采样率"]')
 const change=async(select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));await settle()}
 for(const desired of ['continuity-first','bit-perfect-first','continuity-first']){
  await change(policy(),desired)
  if(desired==='continuity-first')await change(rate(),'96000')
  expect(engine.value.playbackPolicy===desired&&persisted.value.playbackPolicy===desired,'controller did not apply and persist selected policy')
  open.value=false;await settle();reload();await settle();open.value=true;await settle()
  expect(policy().value===desired,'reopened policy differs from persisted engine policy: '+policy().value)
  expect(audioOutputConfig.value.continuitySampleRate===96000,'reload dropped continuity target rate')
  expect(audioOutputConfig.value.pcmToDsdMode==='dsd128'&&audioOutputConfig.value.dsdMutePreRollFrames===1024,'reload dropped other output configuration fields')
  expect((!!rate())===(desired==='continuity-first'),'policy-dependent target selector visibility is stale')
  if(rate())expect(rate().value==='96000','reopened target-rate selector is stale')
 }
 appSettings.value={...appSettings.value,audioOutputConfig:{preferredBufferSize:8192}};await settle()
 expect(audioOutputConfig.value.preferredBufferSize===8192,'reload changed the persisted buffer preference')
 expect(policy().value==='bit-perfect-first'&&audioOutputConfig.value.continuitySampleRate===48000,'legacy configuration defaults changed')
 app.unmount();return 'PLAYBACK_POLICY_OK: both directions, settings reload, component reopen, target rate, DSD fields and legacy defaults verified'
}
`
