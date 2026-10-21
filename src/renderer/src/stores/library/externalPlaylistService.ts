import { shallowRef, watch } from 'vue'
import type { useMusicStore } from '../useMusicStore.ts'
import type { Track } from '../../types/music'
import { importSongKey, type ImportResolution, type ImportSong } from '../../../../shared/externalPlaylist.ts'
import { chooseStrictImportCandidate, strictImportCandidate } from '../../../../shared/playlistImportMatching.ts'
import { createExternalEntryResolver, importFailure } from '../../utils/externalPlaylistResolver.ts'
import { syncPluginProviders, useMediaProviders } from '../../providers/index.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { lookupLibraryTracksByPaths } from '../../utils/libraryTrackByPath.ts'
import { normalizePortableLibraryPath } from '../../../../shared/playlistPaths.ts'

type MusicStore=ReturnType<typeof useMusicStore>
export const externalMatchProgress=shallowRef<Record<string,{done:number;total:number;running:boolean}>>({})
let singleton:ReturnType<typeof createExternalPlaylistService>|undefined
export function getExternalPlaylistService(music:MusicStore) { return singleton??=createExternalPlaylistService(music) }

export function createExternalPlaylistService(music:MusicStore) {
  const registry=useMediaProviders(), jobs=new Map<string,AbortController>(), tails=new Map<string,Promise<unknown>>()
  const progress=(id:string,value:{done:number;total:number;running:boolean})=>{externalMatchProgress.value={...externalMatchProgress.value,[id]:value}}
  async function schedule<T>(source:string,action:()=>Promise<T>,signal:AbortSignal):Promise<T> {
    const previous=tails.get(source)??Promise.resolve()
    const task=previous.catch(()=>{}).then(async()=>{
      signal.throwIfAborted()
      try { return await action() } finally { await new Promise(resolve=>setTimeout(resolve,300)) }
    })
    tails.set(source,task)
    try { return await task } finally {if(tails.get(source)===task) tails.delete(source)}
  }
  async function localCandidates(song:ImportSong,signal:AbortSignal) {
    const mode=await window.api.library.getStorageMode()
    if (mode==='json') {
      const tracks=music.tracks.value,paths=new Set(song.locations?.map(normalizePortableLibraryPath))
      return {exactPath:tracks.find(t=>(!t.source||t.source==='local')&&paths.has(normalizePortableLibraryPath(t.filePath))),candidates:tracks.filter(t=>(!t.source||t.source==='local')&&chooseStrictImportCandidate(song,[t]).track)}
    }
    if (mode!=='sqlite') throw new Error('无法确认曲库存储，未进行自动匹配')
    const api=window.api.library.database
    let exactPath:Track|undefined
    let revision:number|undefined
    const paths=(song.locations??[]).filter(p=>!/^https?:/i.test(p)).slice(0,200)
    if (paths.length) {
      const lookup=await lookupLibraryTracksByPaths(paths,api)
      exactPath=lookup.tracks[0]
      revision=lookup.revision
    }
    const candidates=new Map<string,Track>()
    let ambiguous=false
    if (song.title) {
      let offset=0
      for (;;) {
        signal.throwIfAborted()
        const page=await api.queryTracks({search:song.title,sort:'title',offset,limit:200,contentRevision:revision})
        revision=page.revision
        for(const record of page.tracks) {
          const track=libraryTrack(record)
          if (!strictImportCandidate(song,track) || !(await window.api.fs.isAudioFileAuthorized(track.filePath))) continue
          candidates.set(`${track.source??'local'}:${track.id}`,track)
          if (candidates.size>1) {ambiguous=true;break}
        }
        if (ambiguous) break
        offset+=page.tracks.length
        if (offset>=page.total) break
        if (!page.tracks.length) throw new Error('本地曲库匹配分页中断')
      }
    }
    return {exactPath,candidates:[...candidates.values()],ambiguous}
  }
  const resolver=createExternalEntryResolver({providers:registry,localCandidates,authorizeLocal:track=>window.api.fs.isAudioFileAuthorized(track.filePath),schedule})
  function cancel(id:string) {jobs.get(id)?.abort();jobs.delete(id)}
  async function run(id:string,force=false,selected?:string[]) {
    cancel(id)
    const controller=new AbortController(),signal=controller.signal
    jobs.set(id,controller)
    const data=music.playlists.value.find(p=>p.id===id)?.imported
    if (!data) {jobs.delete(id); return}
    const generation=data.generation,chosen=selected?new Set(selected):null
    const entries=data.entries.filter(e=>chosen?chosen.has(e.entryId):force||e.resolution.state==='pending')
    let done=0;const updates:Array<{entryId:string;revision:number;resolution:ImportResolution}> = []
    const flush=()=>{if(updates.length) music.applyExternalResolutions(id,generation,updates.splice(0))}
    const cache=new Map<string,Promise<ImportResolution>>()
    progress(id,{done,total:entries.length,running:true})
    try {
      await syncPluginProviders()
      for (const entry of entries) {
        signal.throwIfAborted()
        const current=music.playlists.value.find(p=>p.id===id)?.imported
        if (!current||current.generation!==generation) break
        const key=entry.manualBinding?entry.entryId:importSongKey(entry.original)
        let task=cache.get(key)
        if (!task) {task=resolver.resolve(entry,signal).catch(error=>{signal.throwIfAborted();return importFailure(error)});cache.set(key,task)}
        const resolution=await task
        signal.throwIfAborted()
        updates.push({entryId:entry.entryId,revision:entry.revision,resolution});done++
        if (updates.length>=50||done===entries.length) {flush(); progress(id,{done,total:entries.length,running:true}); await new Promise(resolve=>setTimeout(resolve,0))}
      }
    } catch(error) {
      if (!signal.aborted) {
        const failure=importFailure(error)
        for (const entry of entries.slice(done)) updates.push({entryId:entry.entryId,revision:entry.revision,resolution:failure})
      }
    } finally {
      // Cancellation is visible and retryable. A replacement job owns its own
      // progress; an old job cannot reset it or write after deletion/refresh.
      if (jobs.get(id)===controller) {
        flush();jobs.delete(id);progress(id,{done,total:entries.length,running:false})
        if (!signal.aborted&&music.playlists.value.find(p=>p.id===id)?.imported?.entries.some(e=>e.resolution.state==='pending')) setTimeout(()=>{if(!jobs.has(id))void run(id)},0)
      }
    }
  }
  function stop(id:string) {
    const data=music.playlists.value.find(p=>p.id===id)?.imported
    cancel(id)
    if (data) music.applyExternalResolutions(id,data.generation,data.entries.filter(e=>e.resolution.state==='pending').map(e=>({entryId:e.entryId,revision:e.revision,resolution:{state:'cancelled',message:'补全已取消，可重新匹配'}})))
    const value=externalMatchProgress.value[id];if(value)progress(id,{...value,running:false})
  }
  const stopWatch=watch(()=>music.playlists.value.map(p=>`${p.id}:${p.imported?.generation}:${p.imported?.entries.length}`).join('|'),()=>{
    const existing=new Set(music.playlists.value.map(p=>p.id))
    for(const id of jobs.keys())if(!existing.has(id))cancel(id)
    for(const p of music.playlists.value)if(p.imported&&!jobs.has(p.id)&&p.imported.entries.some(e=>e.resolution.state==='pending'))void run(p.id)
  },{immediate:true})
  let timer:ReturnType<typeof setTimeout>|undefined
  const rematch=()=>{clearTimeout(timer);timer=setTimeout(()=>{for(const p of music.playlists.value)if(p.imported)void run(p.id,true)},800)}
  const offLibrary=window.api.library.onChanged(rematch),offPlugins=window.api.plugins.onChanged(()=>{void syncPluginProviders().then(rematch)})
  window.addEventListener('twilight-provider-auth-changed',rematch)
  return {run,stop,schedule,localCandidates,dispose(){stopWatch();offLibrary();offPlugins();clearTimeout(timer);window.removeEventListener('twilight-provider-auth-changed',rematch);for(const id of jobs.keys())cancel(id)}}
}
