<script setup lang="ts">
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useLibraryThemeDashboard } from '@renderer/composables/useLibraryThemeDashboard.ts'
import SoundFieldHome from '@renderer/components/local-dashboard/SoundFieldHome.vue'
import LibraryDashboardStatus from '@renderer/components/local-dashboard/LibraryDashboardStatus.vue'

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()
const { currentTrack, isPlaying, currentTime, duration, seek, prev, next } = usePlayerStore()
const {
  summary,
  recent,
  recentlyAdded,
  hero: featured,
  heroIsCurrent: isCurrent,
  albumCards,
  play,
  shuffle,
  ready,
  loading,
  error,
  retry
} = useLibraryThemeDashboard('soundField')

function openAlbum(index: number): void {
  const album = albumCards.value[index]
  if (album) emit('select-view', 'albums', album.key)
}

function seekFeatured(position: number): void {
  if (isCurrent.value && duration.value > 0) seek(position)
}
</script>

<template>
  <LibraryDashboardStatus v-if="loading || error" :error="error" @retry="retry" />
  <SoundFieldHome
    v-if="ready"
    :summary="summary"
    :featured="featured"
    :recent="recent"
    :added="recentlyAdded"
    :albums="albumCards"
    :is-playing="isPlaying"
    :current-track-id="currentTrack?.id ?? null"
    :current-time="isCurrent ? currentTime : 0"
    :duration="isCurrent ? duration : 0"
    @play="play"
    @shuffle="shuffle"
    @seek="seekFeatured"
    @previous="prev"
    @next="next"
    @open-album="openAlbum"
    @select-view="(category, filter) => emit('select-view', category, filter)"
    @open-library-settings="emit('open-library-settings')"
  />
</template>
