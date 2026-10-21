<script setup lang="ts">
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useLibraryThemeDashboard } from '@renderer/composables/useLibraryThemeDashboard.ts'
import ArchiveHome from '@renderer/components/local-dashboard/ArchiveHome.vue'
import LibraryDashboardStatus from '@renderer/components/local-dashboard/LibraryDashboardStatus.vue'

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()
const { currentTrack, isPlaying } = usePlayerStore()
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
} = useLibraryThemeDashboard('archive')

function openAlbum(index: number): void {
  const album = albumCards.value[index]
  if (album) emit('select-view', 'albums', album.key)
}
</script>

<template>
  <LibraryDashboardStatus v-if="loading || error" :error="error" @retry="retry" />
  <ArchiveHome
    v-if="ready"
    :summary="summary"
    :recent="recent"
    :added="recentlyAdded"
    :albums="albumCards"
    :hero="hero"
    :is-playing="isPlaying && heroIsCurrent"
    :current-track-id="currentTrack?.id ?? null"
    @play="play"
    @shuffle="shuffle"
    @open-album="openAlbum"
    @select-view="(category, filter) => emit('select-view', category, filter)"
    @open-library-settings="emit('open-library-settings')"
  />
</template>
