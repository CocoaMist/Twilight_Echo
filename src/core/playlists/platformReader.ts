import { recognizePlaylistLink, type PlaylistImportPage, type ImportSong, type PlaylistLink } from '../../shared/externalPlaylist.ts'

import type { PlaylistReadCredentials } from '../../shared/coreImports.ts'
export type { PlaylistReadCredentials } from '../../shared/coreImports.ts'
export interface PlaylistReadRequest { link: string; offset: number; cursor?: string; requestId?: string; credentials?: PlaylistReadCredentials }
type Json = Record<string, any>
const NETEASE_SHORT_HOST = '163cn.tv'
const NETEASE_PLAYLIST_HOSTS = new Set(['music.163.com', 'y.music.163.com'])
const MAX_SHORT_LINK_REDIRECTS = 5

export async function resolveNeteaseShortPlaylistLink(
  input: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<PlaylistLink> {
  const normalized = input.trim().replace(/https\\:\/\//gi, 'https://')
  const raw = normalized.match(/https?:\/\/[^\s<>"，。]+/i)?.[0]
  if (!raw) throw new Error('请粘贴完整的网易云分享链接')
  let current = new URL(raw)
  if (current.protocol !== 'https:' || current.hostname.toLowerCase() !== NETEASE_SHORT_HOST || current.username || current.password || current.port) {
    throw new Error('只支持 HTTPS 网易云短链接解析')
  }

  for (let redirectCount = 0; redirectCount <= MAX_SHORT_LINK_REDIRECTS; redirectCount++) {
    const host = current.hostname.toLowerCase()
    if (NETEASE_PLAYLIST_HOSTS.has(host)) return recognizePlaylistLink(current.href)
    if (host !== NETEASE_SHORT_HOST) throw new Error('网易云短链接跳转到了不受支持的域名')

    signal?.throwIfAborted()
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000)
    let response: Response
    try {
      response = await fetcher(current.href, { method: 'HEAD', redirect: 'manual', signal: requestSignal })
    } catch {
      if (signal?.aborted) signal.throwIfAborted()
      throw new Error('NETWORK: 网易云短链接解析失败，请检查网络或改用歌单文件导入')
    }

    const location = response.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      throw new Error('NETWORK: 网易云短链接未返回歌单跳转地址，请改用完整分享链接或歌单文件导入')
    }
    if (redirectCount === MAX_SHORT_LINK_REDIRECTS) throw new Error('网易云短链接跳转次数过多')

    current = new URL(location, current)
    if (
      current.protocol !== 'https:' ||
      current.username ||
      current.password ||
      current.port ||
      (current.hostname.toLowerCase() !== NETEASE_SHORT_HOST && !NETEASE_PLAYLIST_HOSTS.has(current.hostname.toLowerCase()))
    ) {
      throw new Error('网易云短链接跳转到了不受支持的域名')
    }
  }
  throw new Error('网易云短链接跳转次数过多')
}

/** Official hosts only. Tokens live in the import session, never in a playlist. */
export async function readOfficialPlaylistPage(request: PlaylistReadRequest, fetcher: typeof fetch = fetch, signal?:AbortSignal): Promise<PlaylistImportPage> {
  const link = recognizePlaylistLink(request.link), offset=request.offset, auth=request.credentials ?? {}
  if (!Number.isSafeInteger(offset)||offset<0||offset>=20_000) throw new Error('无效的歌单分页位置')
  for (const token of [auth.accessToken,auth.developerToken,auth.userToken]) if (token && (token.length>16_384 || /[\r\n]/.test(token))) throw new Error('无效的认证令牌')
  const country = auth.country?.trim() || (link.platform==='apple' ? new URL(link.url).pathname.split('/')[1] : 'US') || 'US'
  if (!/^[a-zA-Z]{2}$/.test(country)) throw new Error('地区代码须为两个字母，例如 CN 或 US')
  async function read(url: string, headers: Record<string,string> = {}): Promise<Json> {
    const response = await fetcher(url,{headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000)})
    if (response.status===401||response.status===403) throw new Error('LOGIN: 平台需要有效登录、歌单访问权限或地区授权；也可以选择文件导入')
    if (response.status===429) throw new Error('RATE_LIMIT: 平台请求限流，请稍后重试')
    if (!response.ok) throw new Error(`NETWORK: 平台读取失败（HTTP ${response.status}），请重试或使用文件导入`)
    const raw=await response.text()
    if (Buffer.byteLength(raw)>8*1024*1024) throw new Error('平台单页响应超过 8 MiB')
    return JSON.parse(raw)
  }
  if (link.platform==='qq') {
    const query={comm:{ct:24,cv:0},req_0:{module:'music.srfDissInfo.DissInfoServer',method:'CgiGetDiss',param:{disstid:Number(link.id),onlysong:0,song_begin:offset,song_num:100}}}
    const data=await read(`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(query))}`,{Referer:'https://y.qq.com/'})
    const payload=data.req_0?.data,items=payload?.songlist,total=payload?.total_song_num??payload?.songnum
    if(data.code||data.req_0?.code||!Array.isArray(items)||!Number.isSafeInteger(total)) throw new Error('LOGIN: QQ 音乐未开放此歌单的完整公开读取，请通过已登录的完整读取插件或文件导入')
    return {name:payload.dirinfo?.title,songs:items.map((item:Json):ImportSong=>{const t=item.songInfo??item;return {title:t.title??t.name??t.songname,artist:(t.singer??[]).map((a:Json)=>a.name).join(' / '),album:t.album?.title??t.albumname,duration:t.interval,platform:'qq',platformId:String(t.mid??t.songmid??t.id??t.songid),unavailableReason:!t.title&&!t.name&&!t.songname?'原平台缺少歌曲信息':undefined}}),total,nextOffset:offset+items.length,hasMore:offset+items.length<total}
  }
  if (link.platform==='kugou') {
    if (link.id.toLowerCase().startsWith('gcid_')) throw new Error('LOGIN: 此酷狗 GCID 歌单需要酷狗音源提供完整歌单读取；请启用支持歌单导入的酷狗音源，或使用 KGL / M3U8 文件导入')
    if(offset%100)throw new Error('无效的酷狗分页位置')
    const data=await read(`https://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(link.id)}&page=${offset/100+1}&pagesize=100&plat=0`),items=data.data?.info,total=data.data?.total
    if(data.status!==1||!Array.isArray(items)||!Number.isSafeInteger(total))throw new Error('LOGIN: 酷狗歌单读取受限，请使用已登录的完整读取插件或 KGL / M3U8 文件导入')
    return {songs:items.map((t:Json):ImportSong=>{const parts=String(t.filename??'').split(' - ');return {title:t.songname??(parts.length===2?parts[1]:t.filename),artist:t.singername??(parts.length===2?parts[0]:undefined),album:t.album_name,duration:t.duration??(t.timelength?t.timelength/1000:undefined),platform:'kugou',platformId:t.hash,unavailableReason:!t.hash?'原平台缺少歌曲标识':undefined}}),total,nextOffset:offset+items.length,hasMore:offset+items.length<total}
  }
  if (link.platform==='kuwo') {
    if(offset%100)throw new Error('无效的酷我分页位置')
    const data=await read(`https://www.kuwo.cn/api/www/playlist/playListInfo?pid=${encodeURIComponent(link.id)}&pn=${offset/100+1}&rn=100&httpsStatus=1`,{Referer:'https://www.kuwo.cn/'}),items=data.data?.musicList,total=Number(data.data?.total)
    if(data.code!==200||!Array.isArray(items)||!Number.isSafeInteger(total))throw new Error('LOGIN: 酷我要求网页验证或授权，无法完整直读；请使用 M3U8 / CSV 文件导入')
    return {name:data.data.name,songs:items.map((t:Json):ImportSong=>({title:t.name,artist:t.artist,album:t.album,duration:t.duration,platform:'kuwo',platformId:String(t.rid),unavailableReason:!t.name?'原平台缺少歌曲信息':undefined})),total,nextOffset:offset+items.length,hasMore:offset+items.length<total}
  }
  if (link.platform==='bili') {
    if(offset%20)throw new Error('无效的收藏夹分页位置')
    const data=await read(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(link.id)}&pn=${offset/20+1}&ps=20&platform=web`,{Referer:'https://www.bilibili.com/'})
    const payload=data.data,items=payload?.medias??(payload?.info?.media_count===0?[]:undefined),total=payload?.info?.media_count
    if(data.code!==0||!Array.isArray(items)||!Number.isSafeInteger(total))throw new Error('LOGIN: 收藏夹为私人、失效或需要登录；请使用已登录的完整读取插件或文件导入')
    return {name:payload.info.title,songs:items.map((t:Json):ImportSong=>({title:t.title,artist:t.upper?.name,duration:t.duration,platform:'bili',platformId:t.bvid||String(t.id),unavailableReason:t.title==='已失效视频'?'原收藏视频已失效':undefined})),total,nextOffset:offset+items.length,hasMore:payload.has_more===true}
  }
  if (link.platform==='ytm') {
    if(!auth.accessToken)throw new Error('LOGIN: YouTube Music 歌单需要完整读取插件或 YouTube Data API OAuth 令牌，也可使用 CSV / TXT 导入')
    const token=request.cursor?`&pageToken=${encodeURIComponent(request.cursor)}`:''
    const headers={Authorization:`Bearer ${auth.accessToken}`}
    const page=await read(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(link.id)}${token}`,headers)
    if(!Array.isArray(page.items)||!Number.isSafeInteger(page.pageInfo?.totalResults))throw new Error('YouTube 返回了不完整的歌单分页')
    const ids=page.items.map((t:Json)=>t.contentDetails?.videoId).filter(Boolean),details=ids.length?await read(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${ids.map(encodeURIComponent).join(',')}`,headers):{items:[]}
    const byId=new Map<string,Json>((details.items??[]).map((t:Json)=>[t.id,t]))
    return {songs:page.items.map((item:Json):ImportSong=>{const id=item.contentDetails?.videoId,t=byId.get(id),iso=t?.contentDetails?.duration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);return {title:t?.snippet?.title||item.snippet?.title,artist:t?.snippet?.channelTitle,duration:iso?Number(iso[1]||0)*3600+Number(iso[2]||0)*60+Number(iso[3]||0):undefined,platform:'ytm',platformId:id,unavailableReason:t?undefined:'原平台视频已删除、私人或地区受限'}}),total:page.pageInfo.totalResults,nextOffset:offset+page.items.length,hasMore:Boolean(page.nextPageToken),nextCursor:page.nextPageToken}
  }
  if (link.platform==='spotify') {
    if (!auth.accessToken) throw new Error('LOGIN: Spotify 需要 OAuth 访问令牌，只能读取本人或参与协作的歌单；受开发模式配额限制，也可导入 CSV')
    const data=await read(`https://api.spotify.com/v1/playlists/${encodeURIComponent(link.id)}/items?limit=100&offset=${offset}`,{Authorization:`Bearer ${auth.accessToken}`})
    const items=data.items
    if (!Array.isArray(items)||!Number.isSafeInteger(data.total)) throw new Error('Spotify 返回了不完整的歌单分页')
    return {songs:items.map((item:Json):ImportSong=>{const t=item.item ?? item.track; return t ? {title:t.name,artist:t.artists?.map((a:Json)=>a.name).join(' / '),album:t.album?.name,duration:t.duration_ms/1000,isrc:t.external_ids?.isrc,platform:'spotify',platformId:t.id,unavailableReason:t.is_playable===false?'原平台不可播放':undefined} : {platform:'spotify',unavailableReason:'原平台已删除或无权访问的歌曲'}}),total:data.total,nextOffset:offset+items.length,hasMore:Boolean(data.next)}
  }
  if (link.platform==='apple') {
    if (!auth.developerToken) throw new Error('LOGIN: Apple Music 需要开发者令牌；私人资料库另需 Music User Token，也可导入 XML / 文本')
    const privateLibrary=link.id.startsWith('p.'), headers:Record<string,string>={Authorization:`Bearer ${auth.developerToken}`}
    if (auth.userToken) headers['Music-User-Token']=auth.userToken
    if (privateLibrary&&!auth.userToken) throw new Error('LOGIN: 私人 Apple Music 歌单需要 Music User Token')
    const base=privateLibrary?'me/library':`catalog/${country.toLowerCase()}`
    const data=await read(`https://api.music.apple.com/v1/${base}/playlists/${encodeURIComponent(link.id)}/tracks?limit=100&offset=${offset}`,headers)
    if (!Array.isArray(data.data)) throw new Error('Apple Music 返回了不完整的歌单分页')
    const songs=data.data.map((t:Json):ImportSong=>({title:t.attributes?.name,artist:t.attributes?.artistName,album:t.attributes?.albumName,duration:t.attributes?.durationInMillis/1000,isrc:t.attributes?.isrc,platform:'apple',platformId:t.id,unavailableReason:!t.attributes?'原平台缺少歌曲信息':undefined}))
    const hasMore=Boolean(data.next), total=data.meta?.total ?? (hasMore?offset+songs.length+1:offset+songs.length)
    return {songs,total,nextOffset:offset+songs.length,hasMore}
  }
  if (link.platform==='deezer') {
    const data=await read(`https://api.deezer.com/playlist/${encodeURIComponent(link.id)}/tracks?limit=100&index=${offset}`)
    if (data.error) throw new Error(`LOGIN: Deezer 无法读取此歌单（${String(data.error.code ?? '受限')}），请使用文件导入`)
    if (!Array.isArray(data.data)||!Number.isSafeInteger(data.total)) throw new Error('Deezer 返回了不完整的歌单分页')
    return {songs:data.data.map((t:Json):ImportSong=>({title:t.title,artist:t.artist?.name,album:t.album?.title,duration:t.duration,isrc:t.isrc,platform:'deezer',platformId:String(t.id),unavailableReason:t.readable===false?'原平台不可播放':undefined})),total:data.total,nextOffset:offset+data.data.length,hasMore:Boolean(data.next)}
  }
  if (link.platform==='tidal') {
    if (!auth.accessToken) throw new Error('LOGIN: TIDAL 需要具有歌单读取权限的 OAuth 令牌，也可使用 CSV / TXT 文件导入')
    const root=`https://openapi.tidal.com/v2/playlists/${encodeURIComponent(link.id)}/relationships/items`
    const target=request.cursor ? new URL(request.cursor,root) : new URL(`${root}?countryCode=${country.toUpperCase()}&include=items&page%5Bsize%5D=100`)
    if (target.origin!=='https://openapi.tidal.com'||target.pathname!==new URL(root).pathname) throw new Error('TIDAL 返回了无效的分页地址')
    const data=await read(target.href,{Authorization:`Bearer ${auth.accessToken}`})
    if (!Array.isArray(data.data)) throw new Error('TIDAL 返回了不完整的歌单分页')
    const included=new Map<string,Json>((data.included ?? []).map((v:Json)=>[`${v.type}:${v.id}`,v]))
    const songs=data.data.map((ref:Json):ImportSong=>{const t=included.get(`${ref.type}:${ref.id}`)??ref, a=t.attributes??{};const artists=(t.relationships?.artists?.data??[]).map((r:Json)=>included.get(`${r.type}:${r.id}`)?.attributes?.name).filter(Boolean); return {platform:'tidal',platformId:ref.id,title:a.title,artist:artists.join(' / ')||a.artistName,album:a.albumTitle,isrc:a.isrc,duration:typeof a.duration==='number'?a.duration:undefined,unavailableReason:!a.title?'原平台未提供歌曲元数据，请导出 CSV 补充':undefined}})
    const next=typeof data.links?.next==='string'?data.links.next:data.links?.next?.href
    return {songs,total:data.meta?.total ?? offset+songs.length+(next?1:0),nextOffset:offset+songs.length,hasMore:Boolean(next),nextCursor:next}
  }
  throw new Error('LOGIN: 汽水分享歌单需要已登录音源提供“完整歌单读取”能力；请安装 / 更新对应插件，或选择 CSV / TXT / M3U8 文件导入')
}
