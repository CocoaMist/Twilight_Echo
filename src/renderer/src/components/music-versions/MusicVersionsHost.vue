<script setup lang="ts">
import { ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import type { Track } from '@renderer/types/music'
import type { VersionScope } from '@renderer/utils/musicVersions.ts'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore.ts'
import MusicVersionsPanel from '@renderer/components/music-versions/MusicVersionsPanel.vue'
const props = withDefaults(
  defineProps<{
    initialTrack?: Track
    initialScope?: VersionScope
    embedded?: boolean
    restoreFocus?: HTMLElement | null
  }>(),
  { initialScope: 'tracks', embedded: false }
)
const emit = defineEmits<{ close: [] }>(),
  dialog = ref<HTMLDialogElement | null>(null)
useNativeDialog(dialog, () => props.restoreFocus)
function play(selected: Track[]) {
  if (selected.length) void usePlayerStore().playTrack(selected[0], selected)
}
function playQuery(query: LibraryQuery, selectedId: string) {
  void usePlayerStore().playLibraryQuery(query, selectedId)
}
</script>

<template>
  <MusicVersionsPanel
    v-if="embedded"
    :tracks="[]"
    :sqlite-mode="true"
    :initial-track="initialTrack"
    :initial-scope="initialScope"
    @close="emit('close')"
    @play="play"
    @play-query="playQuery"
  />

  <dialog
    v-else
    ref="dialog"
    class="music-versions-dialog"
    aria-label="歌曲与专辑版本管理"
    @cancel.prevent="emit('close')"
  >
    <MusicVersionsPanel
      :tracks="[]"
      :sqlite-mode="true"
      :initial-track="initialTrack"
      :initial-scope="initialScope"
      @close="emit('close')"
      @play="play"
      @play-query="playQuery"
    />
  </dialog>
</template>

<style scoped>
.music-versions-dialog {
  width: min(1000px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  overflow: auto;
}
.music-versions-dialog::backdrop {
  background: color-mix(in srgb, var(--te-neutral-900) 35%, transparent);
}
</style>
