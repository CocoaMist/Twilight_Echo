import { computed, watch, type Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import { useTrackLocator } from '@renderer/composables/useTrackLocator'
import { registerScrollToTopCompanion } from '@renderer/utils/scrollToTopButton'

/** Locate in the filtered, sorted list without changing playback or selection. */
export function useLocatePlayingTrack(options: {
  containerRef: Ref<HTMLElement | null>
  tbodyRef: Ref<HTMLElement | null>
  displayTracks: Readonly<Ref<Track[]>>
  libraryTracks?: Readonly<Ref<Track[]>>
  currentTrack: Readonly<Ref<Track | null>>
  enabled: Readonly<Ref<boolean>>
  rowHeight: number
  playingRowSelector?: string
  database?: {
    enabled: Readonly<Ref<boolean>>
    locate: (id: string) => void
  }
}): void {
  const { containerRef, tbodyRef, displayTracks, libraryTracks, currentTrack, enabled, rowHeight } =
    options
  // Searching is cached across scroll events; only list/song changes recompute it.
  const currentIndex = computed(() => {
    const id = currentTrack.value?.id
    if (
      !enabled.value ||
      !id ||
      (libraryTracks && !libraryTracks.value.some((track) => track.id === id))
    )
      return -1
    return displayTracks.value.findIndex((track) => track.id === id)
  })

  useTrackLocator(
    computed(() => (options.database?.enabled.value ? null : containerRef.value)),
    {
      bounds: () => {
        const body = tbodyRef.value
        if (currentIndex.value < 0 || !body) return []
        const row = body.querySelector<HTMLElement>(options.playingRowSelector ?? '.track-playing')
        const rect = row?.getBoundingClientRect()
        const top = rect?.top ?? body.getBoundingClientRect().top + currentIndex.value * rowHeight
        return [
          {
            top,
            bottom: rect?.bottom ?? top + rowHeight,
            visibleTop: body.previousElementSibling?.getBoundingClientRect().bottom
          }
        ]
      }
    },
    [currentIndex, tbodyRef, displayTracks, enabled]
  )

  if (options.database) {
    const database = options.database
    watch(
      [containerRef, database.enabled],
      ([container, active], _previous, onCleanup) => {
        if (!container || !active) return
        const registration = registerScrollToTopCompanion(container, {
          label: '定位正在播放的歌曲',
          icon: 'ph ph-crosshair',
          isVisible: (viewport) => {
            if (!enabled.value || !currentTrack.value || !tbodyRef.value) return false
            const body = tbodyRef.value
            const row = body.querySelector<HTMLElement>(
              options.playingRowSelector ?? '.track-playing'
            )
            const rect = row?.getBoundingClientRect()
            const visibleTop = Math.max(
              viewport.top,
              body.previousElementSibling?.getBoundingClientRect().bottom ?? viewport.top
            )
            return !rect || rect.bottom <= visibleTop || rect.top >= viewport.bottom
          },
          activate: () => {
            if (currentTrack.value) database.locate(currentTrack.value.id)
          }
        })
        const stop = watch([currentTrack, tbodyRef, enabled], registration.refresh, {
          flush: 'post'
        })
        onCleanup(() => {
          stop()
          registration.dispose()
        })
      },
      { immediate: true, flush: 'post' }
    )
  }
}
