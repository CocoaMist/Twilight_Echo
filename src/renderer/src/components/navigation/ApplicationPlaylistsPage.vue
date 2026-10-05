<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
const SongList = defineAsyncComponent(() => import('@renderer/components/SongList.vue'))
const AggregatePlaylistPage = defineAsyncComponent(
  () => import('@renderer/components/aggregate-playlist/AggregatePlaylistPage.vue')
)
defineProps<{
  category: string
  filter: string | null
  hasPlayer: boolean
  transitionName: 'page-down' | 'page-up'
  returnFromDetail: () => void
}>()
const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  customizeAppearance: []
}>()
</script>

<template>
  <section class="application-playlists-page">
    <div class="playlist-tabs" aria-label="歌单分类">
      <button
        type="button"
        :aria-pressed="category === 'playlists'"
        @click="emit('selectView', 'playlists', null)"
      >
        应用歌单
      </button>
      <button
        type="button"
        :aria-pressed="category === 'aggregate'"
        @click="emit('selectView', 'aggregate', null)"
      >
        聚合歌单
      </button>
    </div>
    <div class="playlist-content">
      <AggregatePlaylistPage
        v-if="category === 'aggregate'"
        :has-player="hasPlayer"
        surface="local"
        :initial-playlist-id="filter"
        :navigate-playlist="(id) => emit('selectView', 'aggregate', id)"
        :return-from-detail="returnFromDetail"
      />
      <SongList
        v-else
        category="playlists"
        :filter="filter"
        :has-player="hasPlayer"
        :transition-name="transitionName"
        :return-from-detail="returnFromDetail"
        @select-view="(category, filter) => emit('selectView', category, filter)"
        @customize-appearance="emit('customizeAppearance')"
      />
    </div>
  </section>
</template>

<style scoped>
.application-playlists-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
}
.playlist-tabs {
  display: flex;
  flex-wrap: wrap;
  flex-shrink: 0;
  gap: 8px;
  padding: var(--te-page-top) var(--te-page-gutter) 0;
}
.playlist-tabs button {
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  padding: 9px 14px;
  font: inherit;
  cursor: pointer;
}
.playlist-tabs button[aria-pressed='true'] {
  background: var(--te-navigation-active);
  color: var(--te-navigation-active-text);
}
.playlist-tabs button:focus-visible {
  outline: 2px solid var(--te-navigation-indicator);
  outline-offset: 2px;
}
.playlist-content {
  --te-page-top: 20px;
  flex: 1;
  min-height: 0;
}
.playlist-content :deep(.song-list),
.playlist-content :deep(.aggregate-page) {
  height: 100% !important;
}
:global(html[data-te-shell-layout='custom'] .application-playlists-page) {
  height: 100%;
}
</style>
