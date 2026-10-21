import type { Track } from '../types/music.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore.ts'
import type { PlaylistPageProducer } from '../stores/library/musicStoreTypes.ts'

export async function copyTrackNames(
  tracks: readonly Pick<Track, 'title' | 'artist'>[]
): Promise<void> {
  if (tracks.length === 0) return
  await copyTrackNamePages(async (append) => {
    await append(tracks)
  })
}

/** Clipboard text is necessarily materialized; selected Track records are not. */
export async function copyTrackNamePages(
  produce: PlaylistPageProducer<Pick<Track, 'title' | 'artist'>>
): Promise<void> {
  const lines: string[] = []
  const guard = await produce(async (tracks) => {
    for (const track of tracks)
      lines.push([track.title.trim(), track.artist.trim()].filter(Boolean).join(' - '))
  })
  guard?.()
  if (!lines.length) return
  const { pushNotice } = useAppNoticeStore()
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    pushNotice({
      kind: 'success',
      message: lines.length > 1 ? `已复制 ${lines.length} 首歌曲名和作者` : '已复制歌曲名和作者',
      presentation: 'toast',
      durationMs: 2500
    })
  } catch {
    pushNotice({ kind: 'error', message: '复制歌曲名和作者失败，请重试' })
  }
}
