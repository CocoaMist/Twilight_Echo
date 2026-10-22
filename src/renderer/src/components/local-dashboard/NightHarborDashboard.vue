<script setup lang="ts">
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useLibraryThemeDashboard } from '@renderer/composables/useLibraryThemeDashboard.ts'
import NightHarborHome from '@renderer/components/local-dashboard/NightHarborHome.vue'
import LibraryDashboardStatus from '@renderer/components/local-dashboard/LibraryDashboardStatus.vue'

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()
const { currentTrack, isPlaying, currentTime, duration, seek } = usePlayerStore()
const {
  summary,
  recent,
  recentlyAdded,
  hero,
  heroIsCurrent,
  albumCards,
  play,
  shuffle,
  ready,
  loading,
  error,
  retry
} = useLibraryThemeDashboard('nightHarbor')

function openAlbum(index: number): void {
  const album = albumCards.value[index]
  if (album) emit('select-view', 'albums', album.key)
}

function seekHero(position: number): void {
  if (heroIsCurrent.value && duration.value > 0) seek(position)
}
</script>

<template>
  <LibraryDashboardStatus v-if="loading || error" :error="error" @retry="retry" />
  <NightHarborHome
    v-if="ready"
    :summary="summary"
    :hero="hero"
    :recent="recent"
    :added="recentlyAdded"
    :albums="albumCards"
    :is-playing="isPlaying"
    :current-track-id="currentTrack?.id ?? null"
    :current-time="heroIsCurrent ? currentTime : 0"
    :duration="heroIsCurrent ? duration : 0"
    @play="play"
    @shuffle="shuffle"
    @seek="seekHero"
    @open-album="openAlbum"
    @select-view="(category, filter) => emit('select-view', category, filter)"
    @open-library-settings="emit('open-library-settings')"
  />
</template>
