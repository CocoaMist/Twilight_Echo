import { EXTERNAL_PLAYLIST_MAX_ENTRIES, type ImportSong } from './externalPlaylist.ts'

export interface ImportTable { columns: string[]; rows: string[][]; basePath?: string }
export type ImportColumnMap = Partial<Record<'title'|'artist'|'album'|'duration'|'isrc'|'location', number>>
export function parseImportTable(text: string, delimiter = ','): ImportTable {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  for (let i=0;i<text.length;i++) {
    const c = text[i]
    if (c === '"') { if (quoted && text[i+1] === '"') { cell += '"'; i++ } else if (quoted || !cell) quoted = !quoted; else throw new Error('CSV 引号位置无效') }
    else if (!quoted && (c === delimiter || c === '\n')) { row.push(cell.trim()); cell=''; if (c === '\n') { if (row.some(Boolean)) rows.push(row); row=[]; if (rows.length > EXTERNAL_PLAYLIST_MAX_ENTRIES + 1) throw new Error('歌单超过 20,000 条上限') } }
    else if (c !== '\r' || quoted) cell+=c
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row)
  return {columns:rows.shift() ?? [], rows}
}
export function detectImportColumns(columns: string[]): ImportColumnMap {
  const aliases = {title:['title','name','trackname','songname','track','song','歌名','歌曲名称','歌曲'], artist:['artist','artists','artistname','歌手','艺术家'],album:['album','albumname','专辑'],duration:['duration','durationms','trackdurationms','durationseconds','totaltime','time','时长'],isrc:['isrc'],location:['location','path','filepath','url','trackuri','trackurl','文件路径','路径']} as const
  const result: ImportColumnMap = {}
  for (const [key, names] of Object.entries(aliases)) { const index = columns.findIndex(c => (names as readonly string[]).includes(c.toLowerCase().replace(/[\s_()-]/g,''))); if (index >= 0) result[key as keyof ImportColumnMap] = index }
  return result
}
export function mapImportTable(table: ImportTable, mapping = detectImportColumns(table.columns)): ImportSong[] {
  if (mapping.title === undefined && mapping.location === undefined) throw new Error('未识别歌名或路径列，请使用含 Title / Artist / Album 表头的文件')
  if (table.rows.length > EXTERNAL_PLAYLIST_MAX_ENTRIES) throw new Error('歌单超过 20,000 条上限')
  return table.rows.map(row => {
    const read = (key: keyof ImportColumnMap) => mapping[key] === undefined ? undefined : row[mapping[key]!] || undefined
    const rawDuration = read('duration'), numeric = rawDuration?.split(':').reduce((s,v) => s*60+Number(v),0)
    const duration = numeric && Number.isFinite(numeric) ? numeric / (/durationms|totaltime/i.test(table.columns[mapping.duration!].replace(/[\s_()-]/g,'')) ? 1000 : 1) : undefined
    const rawLocation=read('location'),location=rawLocation&&table.basePath?resolveTableLocation(rawLocation,table.basePath):rawLocation,spotifyId=location?.match(/(?:spotify:track:|https:\/\/open\.spotify\.com\/track\/)([\w]+)/)?.[1]
    return {title:read('title'),artist:read('artist'),album:read('album'),isrc:read('isrc'),duration,locations:location ? [location] : [],...(spotifyId?{platform:'spotify' as const,platformId:spotifyId}:{})}
  })
}
function resolveTableLocation(value:string,filename:string) {
  if (/^[a-z][\w+.-]*:/i.test(value)&&!/^file:/i.test(value)&&!/^[a-z]:[\\/]/i.test(value)) return value
  if (/^[a-z]:[\\/]|^\\\\|^\//i.test(value)) return value
  try {
    const windows=/^[a-z]:[\\/]/i.test(filename),base=windows?`file:///${filename.replaceAll('\\','/')}`:`file://${filename}`
    const url=new URL(value.replaceAll('\\','/'),base),pathname=decodeURIComponent(url.pathname)
    return windows?pathname.replace(/^\//,'').replaceAll('/','\\'):pathname
  } catch {return value}
}
