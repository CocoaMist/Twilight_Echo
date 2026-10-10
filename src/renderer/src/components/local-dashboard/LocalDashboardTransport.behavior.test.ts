import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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

test('homepage transport starts the featured track after launch and then controls the active queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-home-transport-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'fixtures.ts'), fixtures)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [
        vue(),
        {
          name: 'home-transport-test-stores',
          load(id) {
            if (id === '\0home-transport-child-stub')
              return 'import {h} from "vue"; export default { render: () => h("div", {"data-child-stub": ""}) }'
            return null
          }
        }
      ],
      resolve: {
        alias: [
          {
            find: /^(?:\.\.\/stores\/use(?:Music|Player|ListeningStats|AudioOutputDsp)Store|\.\.\/utils\/unifiedRecentTracks|pinia)$/,
            replacement: join(directory, 'fixtures.ts')
          },
          {
            find: /^\.\/(?:CoverImg|local-dashboard\/DashboardPlaybackProgress)\.vue$/,
            replacement: '\0home-transport-child-stub'
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') },
          {
            find: 'primeicons/primeicons.css',
            replacement: require.resolve('primeicons/primeicons.css')
          }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'HomeTransportTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{margin:0;background:var(--te-bg-primary,#f8f9fc)}#app{height:100vh}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), electronRunner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /HOME_TRANSPORT_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const electronRunner = `const {app,BrowserWindow}=require('electron')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
 try{
  await win.loadFile(process.argv.at(-1))
  await win.webContents.executeJavaScript('window.runHomeTransportTests()')
  console.log('HOME_TRANSPORT_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`

const fixtures = `import {ref} from 'vue'
const first={id:'one',title:'First',artist:'Artist',album:'Album',duration:100,path:'first.flac'}
const last={id:'two',title:'Last played',artist:'Artist',album:'Album',duration:100,path:'last.flac'}
export const state={tracks:ref([first,last]),recent:ref(last),currentTrack:ref(null),isPlaying:ref(false),calls:[]}
const player={currentTrack:state.currentTrack,isPlaying:state.isPlaying,dominantColor:ref('#aabbcc'),
 playTrack(track,queue){state.calls.push(['start',track.id,queue.map(item=>item.id)]);state.currentTrack.value=track;state.isPlaying.value=true},
 togglePlay(){state.calls.push(['toggle']);state.isPlaying.value=!state.isPlaying.value},
 next(){state.calls.push(['next'])},prev(){state.calls.push(['previous'])},setPlayMode(mode){state.calls.push(['mode',mode])}}
export const useMusicStore=()=>({tracks:state.tracks,albums:ref([]),artists:ref([])})
export const usePlayerStore=()=>player
export const useListeningStatsStore=()=>({listeningStats:ref({days:{}})})
export const getMostListenedTracks=()=>[]
export const getRecentTracks=()=>state.recent.value?[{id:state.recent.value.id,track:state.recent.value}]:[]
export const createUnifiedRecentTrackResolver=tracks=>stat=>tracks.find(track=>track.id===stat.id)||stat.track
export const useAudioOutputDspStore=()=>({audioProcessing:ref({dspEnabled:false}),playbackInfo:ref(null),outputInfo:ref(null)})
export const storeToRefs=store=>store
`

const runtime = `import {createApp,h,nextTick} from 'vue'
import LocalDashboard from '@renderer/components/LocalDashboard.vue'
import {state} from './fixtures.ts'
window.api={audioEngine:{getDspGraphStatus:async()=>null,getDspSceneState:async()=>null}}
const expect=(value,message)=>{if(!value)throw new Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,50))}
const app=createApp({render:()=>h(LocalDashboard)})
app.mount('#app')
const controls=()=>[...document.querySelectorAll('.hero-actions button')]
const play=()=>document.querySelector('.transport-play')
window.runHomeTransportTests=async()=>{
 await settle()
 expect(controls().length===1,'fresh launch must show its regular play control')
 expect(play()?.getAttribute('aria-label')==='播放'&&play().querySelector('[data-playback-icon="play"]'),'idle control must have the visible play glyph')
 expect(play().getBoundingClientRect().width>0,'idle control must occupy visible space')
 expect(!document.querySelector('.hero-actions')?.textContent.includes('播放这首'),'no duplicate text CTA')
 play().click();await settle()
 expect(JSON.stringify(state.calls[0])===JSON.stringify(['start','two',['one','two']]),'idle control must play the displayed last track with its normal queue')
 expect(controls().length===3&&play().getAttribute('aria-label')==='暂停','starting a track must expose all three regular controls')
 play().click();await settle()
 expect(!state.isPlaying.value&&play().getAttribute('aria-label')==='播放','pause must keep an available resume control')
 play().click();await settle()
 expect(state.isPlaying.value&&state.calls.filter(call=>call[0]==='start').length===1,'resume must not replace the queue')
 controls()[0].click();controls()[2].click()
 expect(state.calls.at(-2)[0]==='previous'&&state.calls.at(-1)[0]==='next','skip controls retain their actions')
 state.currentTrack.value=null;state.isPlaying.value=false;state.recent.value=null;await settle()
 expect(controls().length===1,'no history must still expose playback for the first library track')
 play().click();await settle()
 expect(state.calls.at(-1)[1]==='one','no-history play must select the displayed first track')
 state.currentTrack.value=null;state.isPlaying.value=false
 state.recent.value={id:'outside',title:'Outside library',artist:'Artist',duration:100};await settle()
 play().click();await settle()
 expect(JSON.stringify(state.calls.at(-1))===JSON.stringify(['start','outside',['outside']]),'available history outside the library must use a single-track queue')
 state.currentTrack.value=null;state.isPlaying.value=false;state.recent.value=null;state.tracks.value=[];await settle()
 expect(!play()&&document.querySelector('.empty-cta'),'empty library must show import instead of an unusable play control')
 app.unmount()
}
`
