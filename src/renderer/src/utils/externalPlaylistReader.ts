import { EXTERNAL_PLAYLIST_MAX_ENTRIES, recognizePlaylistLink, isNeteaseShortLink, providerMatchesImportPlatform, type PlaylistImportPage, type PlaylistImportDocument, type PlaylistLink } from '../../../shared/externalPlaylist.ts'
import { useMediaProviders, syncPluginProviders } from '../providers/index.ts'

export interface PlaylistImportAdapter {
  read(link:string, options:{signal:AbortSignal; credentials?:{accessToken?:string;developerToken?:string;userToken?:string;country?:string}; onLink?:(link:PlaylistLink)=>void; onPage?:(page:PlaylistImportPage)=>void}, bridge:PlaylistImportBridge):Promise<PlaylistImportDocument>
}
export interface PlaylistImportBridge {
  resolveNeteaseShortLink(request:{input:string;requestId:string}):Promise<PlaylistLink>
  readPage(request:{link:string;offset:number;cursor?:string;requestId?:string;credentials?:{accessToken?:string;developerToken?:string;userToken?:string;country?:string}}):Promise<PlaylistImportPage>
  cancelRead(requestId:string):Promise<boolean>
}
export const externalPlaylistAdapter:PlaylistImportAdapter = {
  async read(input,options,bridge) {
    options.signal.throwIfAborted()
    let link:PlaylistLink
    if(isNeteaseShortLink(input)) {
      const requestId=crypto.randomUUID(),cancel=()=>void bridge.cancelRead(requestId).catch(()=>undefined)
      options.signal.addEventListener('abort',cancel,{once:true})
      try { link=await bridge.resolveNeteaseShortLink({input,requestId}) }
      finally { options.signal.removeEventListener('abort',cancel) }
    } else link=recognizePlaylistLink(input)
    options.onLink?.(link)
    await syncPluginProviders()
    const provider=useMediaProviders().list().find(p=>providerMatchesImportPlatform(p.id,link.platform)), songs:PlaylistImportDocument['songs']=[]
    if (provider?.isEnabled && !(await provider.isEnabled())) throw new Error('对应音源尚未启用，请启用后重试，或选择文件导入')
    let offset=0,cursor:string|undefined,total:number|undefined,name=`${link.platform} 歌单`,expected:number|undefined
    for (;;) {
      options.signal.throwIfAborted()
      const requestId=crypto.randomUUID()
      const cancel=()=>{if(!provider)void bridge.cancelRead(requestId).catch(()=>undefined)}
      options.signal.addEventListener('abort',cancel,{once:true})
      let page:PlaylistImportPage
      try {
        page=provider?.readPlaylistImportPage
          ? await provider.readPlaylistImportPage(link.id,offset,100,{signal:options.signal})
          : await bridge.readPage({link:link.url,offset,cursor,requestId,credentials:options.credentials})
      } finally {options.signal.removeEventListener('abort',cancel)}
      options.signal.throwIfAborted()
      if (!page||!Array.isArray(page.songs)||!Number.isSafeInteger(page.total)||page.total<0||page.total>EXTERNAL_PLAYLIST_MAX_ENTRIES||!Number.isSafeInteger(page.nextOffset)||page.nextOffset!==offset+page.songs.length||typeof page.hasMore!=='boolean') throw new Error('平台返回了无效或超限的分页，未标记为完整歌单')
      if (page.hasMore && (!page.songs.length || page.nextOffset<=offset)) throw new Error('平台分页没有前进，请重试')
      // Providers with an exact total must not silently change membership while reading.
      if (provider?.readPlaylistImportPage) { expected??=page.total; if (expected!==page.total) throw new Error('歌单在读取期间发生变化，请重新读取') }
      songs.push(...page.songs.map(s=>({...s,platform:s.platform ?? link.platform})))
      if (songs.length>EXTERNAL_PLAYLIST_MAX_ENTRIES||(!page.hasMore && songs.length!==page.total)) throw new Error('歌单条目不完整，请重试或使用文件导入')
      total=page.total; name=page.name||name
      options.onPage?.({...page,songs:page.songs.map(s=>({...s,platform:s.platform??link.platform}))})
      if (!page.hasMore) break
      offset=page.nextOffset; cursor=page.nextCursor
    }
    return {name,songs,source:{kind:'platform',platform:link.platform,playlistId:link.id,url:link.url,label:link.platform},warnings:[],complete:true,total}
  }
}
