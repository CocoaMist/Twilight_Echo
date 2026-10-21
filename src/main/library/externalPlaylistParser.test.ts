import assert from 'node:assert/strict'
import test from 'node:test'
import iconv from 'iconv-lite'
import { parseExternalPlaylistFile as parse } from './externalPlaylistParser.ts'
const read=(name:string,text:string)=>parse(Buffer.from(text),`D:/Lists/${name}`)

test('M3U8 preserves duplicate occurrences, missing tags, relative/file paths and rejects HLS',()=>{
  const result=read('mix.m3u8','#EXTM3U\n#EXTINF:183,夜曲\n../Music/a.flac\nfile:///D:/Music/a.flac\n../Music/a.flac')
  assert.equal(result.songs.length,3);assert.equal(result.songs[0].title,'夜曲');assert.equal(result.songs[0].duration,183)
  assert.equal(result.songs[0].locations?.[0],'D:\\Music\\a.flac');assert.equal(result.songs[1].locations?.[0].replaceAll('\\','/'),'D:/Music/a.flac')
  assert.throws(()=>read('hls.m3u8','#EXTM3U\n#EXT-X-TARGETDURATION:10\nsegment.ts'),/HLS/)
})
test('legacy encodings and byte limits are enforced',()=>{
  assert.equal(parse(iconv.encode('#EXTM3U\n#EXTINF:1,中文\na.mp3','gb18030'),'D:/a.m3u').songs[0].title,'中文')
  assert.equal(parse(iconv.encode('Name\tArtist\tAlbum\n夜曲\t周杰伦\t十一月的萧邦','utf16-le'),'D:/a.txt').songs[0].title,'夜曲')
  assert.throws(()=>parse(Buffer.alloc(8*1024*1024+1),'x.m3u8'),/8 MiB/)
  assert.throws(()=>read('many.m3u8',Array(20001).fill('song.mp3').join('\n')),/20,000/)
})
test('PLS follows numeric indices and retains an unavailable entry',()=>{
  const result=read('mix.pls','[playlist]\nFile10=a.mp3\nTitle10=ten\nTitle2=missing\nFile1=b.mp3\nNumberOfEntries=3')
  assert.deepEqual(result.songs.map(s=>s.title),[undefined,'missing','ten'])
  assert.equal(result.songs[1].locations?.length,0)
  assert.throws(()=>read('bad.pls','[playlist]\nFile1=x.mp3\nNumberOfEntries=3'),/数量/)
})
test('XSPF locations are alternatives, entities and millisecond durations survive',()=>{
  const result=read('mix.xspf','<playlist xmlns="http://xspf.org/ns/0/"><title>Mix &amp; More</title><trackList><track><title>A &amp; B</title><creator>歌手</creator><album>专辑</album><duration>180001</duration><location>../a.flac</location><location>file:///D:/a.flac</location></track></trackList></playlist>')
  assert.equal(result.name,'Mix & More');assert.equal(result.songs.length,1);assert.equal(result.songs[0].locations?.length,2);assert.equal(result.songs[0].duration,180.001)
})
test('WPL, uppercase ASX/WAX and KGL preserve all media occurrences',()=>{
  assert.equal(read('x.wpl','<smil><body><seq><media src="a.mp3"/><media src="a.mp3"/></seq></body></smil>').songs.length,2)
  assert.equal(read('x.wax','<ASX><ENTRY><TITLE>Song</TITLE><AUTHOR>Artist</AUTHOR><REF HREF="a.mp3"/></ENTRY></ASX>').songs[0].artist,'Artist')
  assert.equal(read('x.kgl','<List ListName="中文"><File><FileName>Artist - Title.mp3</FileName></File><File/></List>').songs.length,2)
  assert.throws(()=>read('smart.wpl','<smil><querySet/></smil>'),/动态/)
  assert.throws(()=>read('ref.asx','<asx><entryref href="https://example.com/x.asx"/></asx>'),/嵌套/)
})
test('Apple plist chooses a playlist, preserving duplicates and missing track IDs',()=>{
  const result=read('iTunes.xml','<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist><dict><key>Tracks</key><dict><key>1</key><dict><key>Name</key><string>A &amp; B</string><key>Artist</key><string>Artist</string><key>Total Time</key><integer>180000</integer></dict></dict><key>Playlists</key><array><dict><key>Name</key><string>Favorites</string><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1</integer></dict><dict><key>Track ID</key><integer>1</integer></dict><dict><key>Track ID</key><integer>2</integer></dict></array></dict><dict><key>Name</key><string>Empty</string><key>Playlist Items</key><array/></dict></array></dict></plist>')
  assert.equal(result.name,'Favorites');assert.equal(result.songs.length,3);assert.equal(result.songs[0].duration,180);assert.ok(result.songs[2].unavailableReason);assert.equal(result.playlists?.[1].songs.length,0)
})
test('quoted CSV, tab exports and structured TXT recognize metadata without fabricating playback',()=>{
  const result=read('x.csv','Track name,Artist name,Album name,Duration (ms),ISRC\n"Hello, ""World""",歌手,专辑,183000,CN123\n"Hello, ""World""",歌手,专辑,183000,CN123')
  assert.equal(result.songs[0].title,'Hello, "World"');assert.equal(result.songs[0].duration,183);assert.equal(result.songs.length,2)
  assert.equal(read('x.txt','歌手 - 歌名\n歌手 - 歌名').songs.length,2)
  assert.throws(()=>read('bad.csv','Title,Artist\n"unclosed,artist'),/引号/)
})
test('damaged XML, DTD and unsupported binary formats fail explicitly',()=>{
  assert.throws(()=>read('bad.xml','<plist><dict></plist>'),/XML/)
  assert.throws(()=>read('bad.xspf','<!DOCTYPE playlist [<!ENTITY x SYSTEM "file:///etc/passwd">]><playlist/>'),/DTD/)
  assert.throws(()=>read('x.fpl','binary'),/桥接/)
  assert.equal(read('empty.xspf','<playlist><trackList/></playlist>').songs.length,0)
})
