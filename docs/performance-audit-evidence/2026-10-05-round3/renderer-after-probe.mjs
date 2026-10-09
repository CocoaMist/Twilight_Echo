import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shallowRef, ref, nextTick } from 'vue'
import { ListeningStatsPersistence } from '../../../src/renderer/src/stores/listeningStatsPersistence.ts'
import { createPlaybackSessionPersistence } from '../../../src/renderer/src/app/usePlaybackSessionPersistence.ts'
import { playbackSessionWriter } from '../../../src/renderer/src/app/playbackSessionWriter.ts'
import { createPlaybackSessionController } from '../../../src/renderer/src/stores/player/playbackSessionController.ts'
import { createBpmAnalysisController } from '../../../src/renderer/src/stores/player/bpmAnalysisController.ts'
import { BpmAnalysisManager } from '../../../src/main/bpm/bpmAnalysisManager.ts'
import { patchPlaybackQueueTrack } from '../../../src/renderer/src/utils/playbackQueueVirtualization.ts'

const emit = value => console.log(JSON.stringify(value))
let clock = 0, id = 0, writes = 0, firstWrite = null
const tasks = new Map()
const advance = to => {
  while (true) {
    const next = [...tasks].filter(([, task]) => task.at <= to).sort((a,b) => a[1].at-b[1].at)[0]
    if (!next) break
    clock = next[1].at; tasks.delete(next[0]); next[1].callback()
  }
  clock = to
}
const persistence = new ListeningStatsPersistence({
  key:'probe', storage:{getItem:()=>null,setItem:()=>{writes++;firstWrite??=clock}},
  getSnapshot:()=>({seconds:clock/1000}),beforePersist:()=>{},onStatus:()=>{},
  flushDelayMs:30000,retryDelayMs:60000,
  setTimeout:(callback,delay)=>{const token=++id;tasks.set(token,{at:clock+delay,callback});return token},
  clearTimeout:token=>tasks.delete(token)
})
for (let time=5000;time<=300000;time+=5000){advance(time);persistence.markDirty()}
const duringPlayback=writes
assert.equal(duringPlayback,9);assert.equal(firstWrite,35000)
persistence.flush();advance(600000);assert.equal(writes,10)
emit({kind:'statsTimer',simulatedPlaybackSeconds:300,dirtyUpdates:60,writesDuringPlayback:duringPlayback,
  firstWriteSeconds:firstWrite/1000,includingFinalFlush:writes})
persistence.dispose()

const makeTrack=i=>({id:`local:${i}`,queueEntryId:`queue:${i}`,title:`Track ${i}`,artist:'Artist',album:'Album',
  filePath:`D:/AuditMusic/${i}.flac`,fileName:`${i}.flac`,duration:180,size:1000000,cover:null,lyrics:null,source:'local'})
const queue=shallowRef(Array.from({length:5000},(_,i)=>makeTrack(i))),originalQueue=shallowRef([...queue.value])
const currentTrack=shallowRef(null),position=ref(0),playing=ref(false),settings=ref({playbackResumeMode:'trackAndPosition'})
const store=createPlaybackSessionController({currentTrack,queue,originalQueue,currentTime:position,queueIndex:ref(0),
  playMode:ref('sequential'),duration:ref(180),sleepTimerState:ref(null),getAppSettings:()=>settings,flushLatestCurrentTime:()=>{}})
const saved=[];let revision=0
const session=createPlaybackSessionPersistence({settings,currentTrack,currentTime:position,isPlaying:playing,queue,
  dataApi:{loadPlaybackSession:async()=>null,clearPlaybackSession:async()=>{},savePlaybackSession:async snapshot=>{
    saved.push({entries:snapshot.queue?.length??0,track:snapshot.track.id});return{version:2,revision:++revision,data:snapshot}}},
  autosaveDelayMs:20,restorePlaybackSession:()=>{},syncPluginProviders:async()=>{},createPlaybackSession:store.createPlaybackSession})
await session.restoreSavedPlaybackSession('trackAndPosition');session.startAutosaveWatchers()
const queueVersion=queue.value
for(let i=0;i<12;i++){
  currentTrack.value={...queue.value[i],lyrics:`Lyrics ${i}`}
  queue.value=patchPlaybackQueueTrack(queue.value,currentTrack.value)
  originalQueue.value=patchPlaybackQueueTrack(originalQueue.value,currentTrack.value)
  store.persistSelectedTrackSession();await nextTick()
}
assert.equal(saved.length,0);assert.equal(queue.value,queueVersion)
await new Promise(resolve=>setTimeout(resolve,35));await playbackSessionWriter.whenIdle()
assert.equal(saved.length,1);assert.equal(saved[0].entries,5000);assert.equal(saved[0].track,'local:11')
await session.savePlaybackSessionForQuit();session.stop()
emit({kind:'rapidSelectionSessionWrites',selections:12,fullQueueSize:5000,debouncedWrites:1,
  includingQuitWrites:saved.length,fullQueueWrites:saved.filter(s=>s.entries===5000).length,
  totalQueueEntriesSent:saved.reduce((sum,s)=>sum+s.entries,0),note:'real Store, App, Vue and writer; disk/IPC stub'})

const directory=mkdtempSync(join(tmpdir(),'twilight-bpm-after-')),filePath=join(directory,'fixture.flac')
writeFileSync(filePath,'analysis-boundary-placeholder')
try {
  const target={...makeTrack(0),filePath},bpmTrack=shallowRef(target),bpmQueue=shallowRef([target]),bpmOriginal=shallowRef([target])
  let controller,patches=0,libraryWrites=0,analyses=0,events=0
  const result={bpm:120,confidence:.9,source:'analyzed',analyzedAt:'2026-10-05T00:00:00Z',algorithmVersion:1}
  const manager=new BpmAnalysisManager({cache:{get:async()=>null,set:async()=>{},deleteIfMatches:async()=>{}},
    analyzeFile:async()=>{analyses++;return result},onComplete:event=>{events++;controller.applyBpmAnalysisToTrack(event.trackId,event.filePath,event.analysis)}})
  controller=createBpmAnalysisController({currentTrack:bpmTrack,queue:bpmQueue,originalQueue:bpmOriginal,isEnabled:()=>true,
    patchTrackInQueues:()=>patches++,getMusicStore:()=>({applyBpmAnalysis:()=>{libraryWrites++;return true},clearBpmAnalysis:()=>true}),
    getAnalysisApi:()=>({request:request=>manager.requestAnalysis(request)})})
  await controller.requestBpmAnalysisForTrack(target)
  assert.equal(analyses,1);assert.equal(patches,1);assert.equal(libraryWrites,1)
  emit({kind:'bpmDualDelivery',analyses,completionEvents:events,playbackQueuePatches:patches,libraryApplyCalls:libraryWrites})
} finally {unlinkSync(filePath);rmdirSync(directory)}
