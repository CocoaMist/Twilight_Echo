import type { Track } from '../types/music'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'

export async function copyTrackNames(
  tracks: readonly Pick<Track, 'title' | 'artist'>[]
): Promise<void> {
  if (tracks.length === 0) return
  const text = tracks
    .map((track) => [track.title.trim(), track.artist.trim()].filter(Boolean).join(' - '))
    .join('\n')
  const { pushNotice } = useAppNoticeStore()
  try {
    await navigator.clipboard.writeText(text)
    pushNotice({
      kind: 'success',
      message: tracks.length > 1 ? `已复制 ${tracks.length} 首歌曲名和作者` : '已复制歌曲名和作者',
      presentation: 'toast',
      durationMs: 2500
    })
  } catch {
    pushNotice({ kind: 'error', message: '复制歌曲名和作者失败，请重试' })
  }
}
