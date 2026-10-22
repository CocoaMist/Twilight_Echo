import type { Track } from '../types/music'
import {providerMatchesImportPlatform, type ImportedPlaylistEntry, type ImportResolution, type ImportSong } from '../../../shared/externalPlaylist.ts'
import type { MediaProvider, MediaProviderRegistry } from '../providers/mediaProvider.ts'
import { chooseStrictImportCandidate } from '../../../shared/playlistImportMatching.ts'

export function importFailure(error:unknown):ImportResolution {
  const message=error instanceof Error?error.message:String(error)
  return {state:/429|RATE_LIMIT|限流|too many/i.test(message)?'rate-limit':/LOGIN|401|403|登录|权限|会员|地域|地区|版权/i.test(message)?'login':'network',message}
}
export function createExternalEntryResolver(options:{
  providers:MediaProviderRegistry
  localCandidates(song:ImportSong,signal:AbortSignal):Promise<{candidates:Track[];exactPath?:Track;ambiguous?:boolean}>
  authorizeLocal(track:Track):Promise<boolean>
  /** All provider calls, including manual search, share a per-source serial gate. */
  schedule<T>(providerId:string,action:()=>Promise<T>,signal:AbortSignal):Promise<T>
}) {
  function available(track:Track,provider:MediaProvider) {
    // A provider identity is a durable playback reference. Resolve its
    // expiring URL only when the user actually starts playback.
    return Boolean(provider.getPlaybackUrl && track.id && track.source)
  }
  async function resolve(entry:ImportedPlaylistEntry,signal:AbortSignal):Promise<ImportResolution> {
    const finish=(result:ImportResolution):ImportResolution=>({...result,checkedAt:new Date().toISOString()})
    if (entry.manualBinding) {
      const track=entry.manualBinding as Track
      if (!track.source||track.source==='local') return finish(await options.authorizeLocal(track)?{state:'local',track,message:'手动绑定'}:{state:'missing',message:'手动绑定的本地文件已失效，请重新选源'})
      const provider=options.providers.get(track.source)
      if (!provider || (provider.isEnabled && !(await provider.isEnabled()))) return finish({state:'login',message:'手动绑定的音源未启用'})
      return finish(available(track,provider)?{state:'streaming',track,message:'手动绑定'}:{state:'missing',message:'手动绑定音源当前不可用，请重新选源'})
    }
    const song=entry.original
    // A failed local query cannot silently mean “no local match”.
    const local=await options.localCandidates(song,signal)
    signal.throwIfAborted()
    const valid:Track[]=[]
    if (local.exactPath && await options.authorizeLocal(local.exactPath)) return finish({state:'local',track:local.exactPath})
    for (const track of local.candidates) if (await options.authorizeLocal(track)) valid.push(track)
    const match=chooseStrictImportCandidate(song,valid)
    if (match.track) return finish({state:'local',track:match.track})
    let ambiguous=match.ambiguous || !!local.ambiguous
    const failures:ImportResolution[]=[]
    const providers=options.providers.list().filter(p=>p.getPlaybackUrl).sort((a,b)=>Number(providerMatchesImportPlatform(b.id,song.platform))-Number(providerMatchesImportPlatform(a.id,song.platform)))
    for (const provider of providers) {
      signal.throwIfAborted()
      if (provider.isEnabled && !(await provider.isEnabled())) continue
      try {
        if (providerMatchesImportPlatform(provider.id,song.platform) && song.platformId && !song.unavailableReason) {
          const track:Track={id:`${provider.id}:${song.platformId}`,source:provider.id,title:song.title||'信息缺失',artist:song.artist||'',album:song.album||'',duration:song.duration||0,filePath:`${provider.id}:${song.platformId}`,fileName:song.title||'信息缺失',size:0,cover:song.cover??null,coverSource:song.coverSource??song.cover??null,coverSmall:song.coverSmall??null,coverSmallSource:song.coverSmallSource??song.coverSource??song.cover??null,lyrics:null,...(provider.id==='ncm'?{ncmSongId:Number(song.platformId)}:{})}
          if (available(track,provider)) return finish({state:'streaming',track})
        }
        if (!provider.searchSongs||!song.title||!song.artist) continue
        const candidates:Track[]=[]
        let offset=0
        for (;;) {
          const page=await options.schedule(provider.id,()=>provider.searchSongs!(`${song.title} ${song.artist}`,100,offset,{signal}),signal)
          if (!page||!Array.isArray(page.items)||!Number.isFinite(page.total)) throw new Error('音源返回了无效搜索结果')
          candidates.push(...page.items); offset+=page.items.length
          if (offset>=page.total) break
          if (!page.items.length||offset>=1000) { ambiguous=true; break }
        }
        const selection=chooseStrictImportCandidate(song,candidates)
        ambiguous ||= selection.ambiguous
        if (selection.track && offset>=candidates.length && offset<1000 && available(selection.track,provider)) return finish({state:'streaming',track:selection.track})
      } catch(error) { signal.throwIfAborted(); failures.push(importFailure(error)) }
    }
    if (ambiguous) return finish({state:'ambiguous',message:'存在多个候选或版本不确定，请手动选源'})
    if (failures.length) return finish(failures.find(f=>f.state==='rate-limit')??failures[0])
    return finish({state:'missing',message:song.unavailableReason||'没有找到准确且可播放的音源'})
  }
  return {resolve}
}
