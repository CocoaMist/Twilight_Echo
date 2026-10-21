import assert from 'node:assert/strict'
import test from 'node:test'
import { readOfficialPlaylistPage, resolveNeteaseShortPlaylistLink } from './playlistPlatformReader.ts'

function response(status:number,body:unknown):Response{return {status,ok:status>=200&&status<300,text:async()=>JSON.stringify(body)} as Response}
function redirect(location:string,status=302):Response{return {status,ok:false,headers:new Headers({location})} as Response}
test('resolves NetEase short links only through approved HTTPS playlist hosts',async()=>{
  const requested:string[]=[]
  const link=await resolveNeteaseShortPlaylistLink('https://163cn.tv/bi1XSgjy',async input=>{requested.push(String(input));return redirect('https://y.music.163.com/m/playlist?id=8504485414&userid=4966968342')})
  assert.deepEqual(requested,['https://163cn.tv/bi1XSgjy'])
  assert.deepEqual(link,{platform:'ncm',id:'8504485414',url:'https://y.music.163.com/m/playlist?id=8504485414&userid=4966968342'})
  await assert.rejects(resolveNeteaseShortPlaylistLink('https://163cn.tv/x',async()=>redirect('https://example.com/playlist?id=1')),/不受支持的域名/)
})
test('Spotify preserves unavailable and duplicate occurrences and uses the current items endpoint',async()=>{
  let requested=''
  const page=await readOfficialPlaylistPage({link:'https://open.spotify.com/playlist/p1',offset:0,credentials:{accessToken:'token'}},async input=>{requested=String(input);return response(200,{items:[{item:{id:'1',name:'Song',artists:[{name:'Artist'}],album:{name:'Album'},duration_ms:180000,external_ids:{isrc:'ISRC'},is_playable:true}},{item:null}],total:2,next:null})})
  assert.match(requested,/\/items\?/);assert.doesNotMatch(requested,/\/tracks\?/);assert.equal(page.songs.length,2);assert.equal(page.songs[0].duration,180);assert.equal(page.songs[1].unavailableReason!==undefined,true)
})
test('official reader classifies auth, rate limit and network failure distinctly',async()=>{
  const input={link:'https://open.spotify.com/playlist/p1',offset:0,credentials:{accessToken:'token'}}
  for(const [status,pattern] of [[401,/LOGIN/],[429,/RATE_LIMIT/],[500,/NETWORK/]] as const) await assert.rejects(readOfficialPlaylistPage(input,async()=>response(status,{})),pattern)
  await assert.rejects(readOfficialPlaylistPage({link:input.link,offset:0}),/LOGIN/)
})
test('Apple personal libraries require a user token and locale derives from playlist URL',async()=>{
  await assert.rejects(readOfficialPlaylistPage({link:'https://music.apple.com/cn/library/playlist/p.123',offset:0,credentials:{developerToken:'dev'}},async()=>response(200,{})),/Music User Token/)
  let requested=''
  const page=await readOfficialPlaylistPage({link:'https://music.apple.com/jp/playlist/name/pl.123',offset:0,credentials:{developerToken:'dev'}},async input=>{requested=String(input);return response(200,{data:[{id:'a',attributes:{name:'A',artistName:'X',albumName:'Y',durationInMillis:180000}}]})})
  assert.match(requested,/catalog\/jp/);assert.equal(page.songs[0].duration,180)
})
test('provider-limited platforms fail into the documented file-import path, never proxy',async()=>{
  for(const link of ['https://music.douyin.com/playlist/1','https://music.youtube.com/playlist?list=PL1','https://tidal.com/browse/playlist/1']) {
    await assert.rejects(readOfficialPlaylistPage({link,offset:0}),/LOGIN/)
  }
})
test('Kugou GCID links do not reach the legacy numeric specialid endpoint',async()=>{
  await assert.rejects(
    readOfficialPlaylistPage({link:'https://m.kugou.com/songlist/gcid_3z9eel5ez1oz0d8/',offset:0},async()=>{throw new Error('legacy endpoint must not be called')}),
    /GCID 歌单需要酷狗音源/
  )
})
