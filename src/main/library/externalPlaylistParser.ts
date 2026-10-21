import { DOMParser } from '@xmldom/xmldom'
import iconv from 'iconv-lite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTERNAL_PLAYLIST_MAX_BYTES, EXTERNAL_PLAYLIST_MAX_ENTRIES, type ImportSong, type PlaylistImportDocument } from '../../shared/externalPlaylist.ts'
import { parseImportTable, mapImportTable, type ImportTable } from '../../shared/playlistImportTable.ts'

const extensions = new Set(['m3u','m3u8','pls','xspf','wpl','asx','wax','kgl','xml','txt','csv','tsv'])
const elements = (node: Element | Document, tag: string): Element[] => Array.from(node.getElementsByTagName(tag))
const children = (node: Element) => Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1)
const content = (node: Element | undefined) => node?.textContent?.trim() || undefined
const value = (node: Element, tag: string) => content(elements(node, tag)[0])
function seconds(input: string | undefined, scale = 1): number | undefined {
  if (!input) return undefined
  const pieces = input.split(':').map(Number)
  const n = pieces.reduce((sum, n) => sum * 60 + n, 0) / scale
  return Number.isFinite(n) && n > 0 ? n : undefined
}
function decode(bytes: Buffer, extension: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes, 'utf16-le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes, 'utf16-be')
  if (bytes.subarray(0, 80).includes(0)) return iconv.decode(bytes, 'utf16-le')
  const declaration = bytes.subarray(0, 200).toString('ascii').match(/encoding\s*=\s*["']([^"']+)/i)?.[1]
  if (declaration && iconv.encodingExists(declaration)) return iconv.decode(bytes, declaration)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { if (extension === 'm3u8') throw new Error('M3U8 必须使用 UTF-8 编码'); return iconv.decode(bytes, 'gb18030') }
}

export function parseExternalPlaylistFile(bytes: Buffer, filename: string): PlaylistImportDocument {
  if (bytes.length > EXTERNAL_PLAYLIST_MAX_BYTES) throw new Error('歌单文件超过 8 MiB 上限')
  const ext = path.extname(filename).slice(1).toLowerCase()
  if (!extensions.has(ext)) throw new Error(/fpl/i.test(ext) ? 'FPL / FPLite 请使用歌单文件桥接插件，或导出 M3U8' : '不支持的歌单格式')
  const text = decode(bytes, ext).replace(/^\uFEFF/, '')
  if (!text.trim()) throw new Error('歌单文件为空')
  if (text.includes('\0')) throw new Error('歌单文件包含无效字符')
  let name = path.basename(filename, path.extname(filename))
  const warnings: string[] = []
  let songs: ImportSong[] = [], playlists: PlaylistImportDocument['playlists']
  let table: ImportTable | undefined
  const locate = (input: string): string => {
    const trimmed = input.trim()
    if (/^file:/i.test(trimmed)) { try { return fileURLToPath(trimmed) } catch { throw new Error('无效的 file:// 路径') } }
    if (/^[a-z][\w+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return trimmed
    // Windows exports are portable even when the app runs on another OS.
    const api = /^[a-z]:[\\/]/i.test(filename) ? path.win32 : path
    return api.isAbsolute(trimmed) ? api.normalize(trimmed) : api.resolve(api.dirname(filename), trimmed)
  }
  const add = (song: ImportSong) => { if (songs.length >= EXTERNAL_PLAYLIST_MAX_ENTRIES) throw new Error('歌单超过 20,000 条上限'); songs.push(song) }
  if (ext === 'm3u' || ext === 'm3u8') {
    if (/^#EXT-X-/im.test(text)) throw new Error('这是 HLS 媒体清单，不是歌曲列表')
    let pending: ImportSong = {}
    for (const line of text.split(/\r?\n/).map(s => s.trim())) {
      if (!line) continue
      const info = line.match(/^#EXTINF:\s*([-\d.]+)[^,]*,(.*)$/i)
      if (info) { const parts=info[2].trim().split(/\s+-\s+/);pending = { title: parts.length===2?parts[1]:info[2].trim()||undefined, ...(parts.length===2?{artist:parts[0]}:{}), duration: seconds(info[1]) }; continue }
      if (line.startsWith('#')) continue
      add({ ...pending, locations: [locate(line)] }); pending = {}
    }
  } else if (ext === 'pls') {
    if (!/^\s*\[playlist\]/im.test(text)) throw new Error('无效的 PLS 歌单')
    const indexed = new Map<number, Record<string,string>>()
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^(File|Title|Length)(\d+)=(.*)$/i)
      if (!match) continue
      const index = Number(match[2]), record = indexed.get(index) ?? {}; record[match[1].toLowerCase()] = match[3].trim(); indexed.set(index, record)
    }
    for (const [, record] of [...indexed].sort((a,b) => a[0]-b[0])) add({ locations: record.file ? [locate(record.file)] : [], title: record.title, duration: seconds(record.length) })
    const count = Number(text.match(/^NumberOfEntries=(\d+)/im)?.[1])
    if (count && count !== songs.length) throw new Error('PLS 声明的歌曲数量与内容不一致')
  } else if (['xspf','wpl','asx','wax','kgl','xml'].includes(ext)) {
    // xmldom does not fetch resources. Reject DTD/custom entity expansion too.
    const safe = text.replace(/<!DOCTYPE\s+plist\s+PUBLIC\s+"-\/\/Apple\/\/DTD PLIST 1.0\/\/EN"\s+"http:\/\/www.apple.com\/DTDs\/PropertyList-1.0.dtd"\s*>/i, '')
    if (/<!DOCTYPE|<!ENTITY/i.test(safe)) throw new Error('不支持含自定义 DTD 或实体的歌单')
    let xml: Document
    try { xml = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message) } }).parseFromString(safe, 'text/xml') as unknown as Document }
    catch { throw new Error('XML 歌单损坏，请重新导出') }
    const root = xml.documentElement, rootName = root.tagName.toLowerCase()
    if (ext === 'xspf' || rootName === 'playlist') {
      name = content(children(root).find(n => n.tagName === 'title')) || name
      for (const track of elements(root, 'track')) add({ title: value(track,'title'), artist: value(track,'creator'), album: value(track,'album'), duration: seconds(value(track,'duration'),1000), locations: elements(track,'location').map(n => locate(content(n) || '')) })
    } else if (ext === 'wpl' || rootName === 'smil') {
      if (elements(root, 'querySet').length || elements(root, 'query').length) throw new Error('动态 WPL 查询不能作为完整歌单，请导出静态播放列表')
      name = value(root,'title') || name
      for (const media of elements(root,'media')) add({ title: media.getAttribute('title') || undefined, locations: media.getAttribute('src') ? [locate(media.getAttribute('src')!)] : [] })
    } else if (ext === 'asx' || ext === 'wax' || rootName === 'asx') {
      const all = elements(root,'*'), entries = all.filter(n => n.tagName.toLowerCase() === 'entry')
      if (all.some(n => n.tagName.toLowerCase() === 'entryref')) throw new Error('ASX 包含嵌套清单，请导出展开后的静态列表')
      for (const entry of entries) {
        const nested = elements(entry,'*'), read = (tag: string) => content(nested.find(n => n.tagName.toLowerCase() === tag))
        add({ title: read('title'), artist: read('author'), locations: nested.filter(n => n.tagName.toLowerCase() === 'ref').map(n => locate(n.getAttribute('href') || n.getAttribute('HREF') || '')) })
      }
    } else if (ext === 'kgl' || rootName === 'list') {
      name = root.getAttribute('ListName') || name
      for (const file of elements(root,'File')) { const location = value(file,'FilePath') || value(file,'FileName'),parts=location?.split(/[\\/]/).at(-1)?.replace(/\.[\w]+$/,'').split(/\s+-\s+/)??[]; add({ title: value(file,'SongName')||(parts.length>=2?parts[1]:undefined), artist: value(file,'SingerName')||(parts.length>=2?parts[0]:undefined), album: value(file,'AlbumName')||(parts.length===3?parts[2]:undefined), locations: location ? [locate(location)] : [] }) }
    } else if (rootName === 'plist') {
      function plist(node: Element): unknown {
        if (node.tagName === 'dict') { const list = children(node), result: Record<string,unknown> = {}; if (list.length % 2) throw new Error('Apple XML 字典损坏'); for (let i=0;i<list.length;i+=2) { if (list[i].tagName !== 'key') throw new Error('Apple XML 字典损坏'); result[list[i].textContent || ''] = plist(list[i+1]) }; return result }
        if (node.tagName === 'array') return children(node).map(plist)
        return node.textContent || ''
      }
      const data = plist(children(root)[0]) as Record<string,unknown>, tracks = data.Tracks as Record<string, Record<string,string>> | undefined
      if (!tracks) throw new Error('Apple XML 缺少 Tracks')
      const readTrack = (id: string): ImportSong => {
        const t = tracks![id]
        return t ? { title:t.Name, artist:t.Artist, album:t.Album, duration:seconds(t['Total Time'],1000), locations:t.Location ? [locate(t.Location)] : [], unavailableReason:t.Disabled === 'true' ? '原资料库已停用' : undefined } : { platformId:id, unavailableReason:'原资料库缺少歌曲信息' }
      }
      const lists = data.Playlists as Array<Record<string,unknown>> | undefined
      playlists = lists?.filter(p => p['Playlist Items'] || p.Name).map(p => ({ name: String(p.Name || name), songs: ((p['Playlist Items'] || []) as Array<Record<string,string>>).map(e => readTrack(e['Track ID'])) }))
      if (playlists?.length) { name = playlists[0].name; songs = playlists[0].songs }
      else songs = Object.keys(tracks).map(readTrack)
    } else throw new Error('无法识别 XML 歌单结构')
  } else {
    table = parseImportTable(text, ext === 'tsv' || text.split(/\r?\n/)[0].includes('\t') ? '\t' : ',')
    table.basePath=filename
    if (table.columns.length > 1) {
      try {songs = mapImportTable(table).map(song=>({...song,locations:song.locations?.map(locate)}))}
      catch(error) {if(!String(error).includes('未识别歌名'))throw error;warnings.push('未识别表头，请在预览中指定歌名或路径列')}
    }
    else {
      table = undefined
      for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
        if (/^https?:|^file:|^[a-z]:[\\/]|\.(?:mp3|flac|wav|m4a|ogg|opus)$/i.test(line)) add({ locations: [locate(line)] })
        else { const parts = line.split(/\s+-\s+/); add(parts.length === 2 ? { artist:parts[0], title:parts[1] } : { title:line }) }
      }
      warnings.push('纯文本按“艺术家 - 歌名”识别；缺少足够元数据的歌曲需要手动匹配')
    }
  }
  if (songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES || playlists?.some(p => p.songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES)) throw new Error('歌单超过 20,000 条上限')
  return { name, songs, source:{kind:'file',label:path.basename(filename)}, warnings, complete:true, total:songs.length, ...(playlists?.length ? {playlists} : {}), ...(table ? {columns:table.columns, table} : {}) }
}
