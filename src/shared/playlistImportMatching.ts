import { normalizeLogicalTrackText } from './logicalTrackIdentity.ts'
import { recordingVersionHint } from './recordingIdentity.ts'
import { getTrackSource } from './trackSourceIdentity.ts'
import { providerMatchesImportPlatform, type ImportSong } from './externalPlaylist.ts'

export interface ImportCandidate { id:string; source?:string; ncmSongId?:number; isrc?:string; title:string; artist:string; album?:string; duration?:number }
const known = (value:string|undefined) => !!value && !/^(?:未知(?:歌手|艺术家|专辑|歌曲)?|unknown(?: artist| album| title)?)$/i.test(value.trim())
function importVersionHint(value:string|undefined) {
  return (value||'').normalize('NFKC').toLowerCase().match(/\blive\b|现场|演唱会|\bremaster(?:ed)?\b|重制|\bacoustic\b|\bunplugged\b|不插电|\binstrumental\b|伴奏|\bcover\b|翻唱|\bdemo\b|\bkaraoke\b|卡拉ok|\bremix\b|混音|\bradio edit\b|\bexplicit\b|\bclean\b|\bmono\b|\bstereo\b|\bsped up\b|\bslowed(?:\s*\+?\s*reverb)?\b/gi)?.sort().join(':')||''
}
export function strictImportCandidate(song: ImportSong, candidate: ImportCandidate): boolean {
  if (song.platform && song.platformId && providerMatchesImportPlatform(getTrackSource(candidate),song.platform) && (candidate.id===`${getTrackSource(candidate)}:${song.platformId}` || (song.platform==='ncm'&&String(candidate.ncmSongId)===song.platformId))) return true
  if (song.isrc && candidate.isrc && song.isrc.replace(/-/g,'').toUpperCase()===candidate.isrc.replace(/-/g,'').toUpperCase()) return true
  if (!known(song.title)||!known(song.artist)||!known(candidate.title)||!known(candidate.artist)) return false
  if (normalizeLogicalTrackText(song.title)!==normalizeLogicalTrackText(candidate.title) || normalizeLogicalTrackText(song.artist)!==normalizeLogicalTrackText(candidate.artist)) return false
  if (recordingVersionHint({id:'import',title:song.title!,artist:song.artist!,album:song.album})!==recordingVersionHint(candidate) || importVersionHint(`${song.title} ${song.album}`)!==importVersionHint(`${candidate.title} ${candidate.album||''}`)) return false
  if (song.duration && candidate.duration) return Math.abs(song.duration-candidate.duration)<=3
  return known(song.album) && known(candidate.album) && normalizeLogicalTrackText(song.album)===normalizeLogicalTrackText(candidate.album)
}
export function chooseStrictImportCandidate<T extends ImportCandidate>(song:ImportSong,candidates:T[]): {track?:T;ambiguous:boolean} {
  const matches=[...new Map(candidates.filter(c=>strictImportCandidate(song,c)).map(c=>[`${getTrackSource(c)}:${c.id}`,c])).values()]
  return {track:matches.length===1?matches[0]:undefined,ambiguous:matches.length>1}
}
