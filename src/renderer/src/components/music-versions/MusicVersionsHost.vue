<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import type { Track } from '@renderer/types/music'
import type { VersionScope } from '@renderer/utils/musicVersions.ts'
import { getTrackSource, versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
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
const emit = defineEmits<{ close: [] }>()
const music = useMusicStore()
const dialog = ref<HTMLDialogElement | null>(null)
const storageMode = ref<'json' | 'sqlite' | null>(null)
const storageModeError = ref('')
useNativeDialog(dialog, () => props.restoreFocus)
onMounted(async () => {
  try {
    storageMode.value = await window.api.library.getStorageMode()
    storageModeError.value = ''
  } catch (error) {
    storageModeError.value = error instanceof Error ? error.message : '无法确认曲库存储模式'
  }
})
const tracks = computed(() => {
  if (!storageMode.value) return []
  const result = new Map<string, Track>()
  if (storageMode.value === 'json')
    for (const track of music.tracks.value) result.set(versionSourceKey(track), track)
  for (const playlist of music.playlists.value)
    for (const track of Object.values(playlist.trackSnapshots ?? {})) {
      if (storageMode.value === 'sqlite' && getTrackSource(track) === 'local') continue
      const key = versionSourceKey(track)
      if (!result.has(key)) result.set(key, track)
    }
  if (
    props.initialTrack &&
    (storageMode.value === 'json' || getTrackSource(props.initialTrack) !== 'local')
  )
    result.set(versionSourceKey(props.initialTrack), props.initialTrack)
  return [...result.values()]
})
function play(selected: Track[]): void {
  if (selected.length) usePlayerStore().playTrack(selected[0], selected)
}

function playQuery(query: LibraryQuery, selectedId: string): void {
  void usePlayerStore().playLibraryQuery(query, selectedId)
}
</script>

<template>
  <MusicVersionsPanel
    v-if="embedded && storageMode"
    :tracks="tracks"
    :sqlite-mode="storageMode === 'sqlite'"
    :initial-track="initialTrack"
    :initial-scope="initialScope"
    @close="emit('close')"
    @play="play"
    @play-query="playQuery"
  />
  <p v-else-if="embedded && storageModeError" role="alert">{{ storageModeError }}</p>
  <p v-else-if="embedded" role="status">正在读取曲库...</p>
  <dialog
    v-else
    ref="dialog"
    class="music-versions-dialog"
    aria-label="歌曲与专辑版本管理"
    @cancel.prevent="emit('close')"
  >
    <MusicVersionsPanel
      v-if="storageMode"
      :tracks="tracks"
      :sqlite-mode="storageMode === 'sqlite'"
      :initial-track="initialTrack"
      :initial-scope="initialScope"
      @close="emit('close')"
      @play="play"
      @play-query="playQuery"
    />
    <p v-else-if="storageModeError" role="alert">{{ storageModeError }}</p>
    <p v-else role="status">正在读取曲库...</p>
  </dialog>
</template>

<style scoped>
.music-versions-dialog {
  width: min(1000px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  margin: auto;
  padding: 0;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-dialog-radius, 8px);
  box-sizing: border-box;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  overflow: auto;
}
.music-versions-dialog::backdrop {
  background: var(--te-dialog-backdrop);
}
</style>
