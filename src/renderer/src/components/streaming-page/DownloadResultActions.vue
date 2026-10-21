<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ProviderDownloadTaskSnapshot } from '../../../../shared/providerDownloads'
import { useMusicStore } from '../../stores/useMusicStore'
import { normalizePortableLibraryPath } from '../../stores/library/musicStoreData'
import type { Track } from '../../types/music'
import { lookupLibraryTrackByPath } from '../../utils/libraryTrackByPath.ts'
const props = defineProps<{ task: ProviderDownloadTaskSnapshot }>()
const music = useMusicStore()
const pending = ref(false)
const error = ref('')
const submitted = ref(false)
const indexState = ref<'checking' | 'indexed' | 'missing' | 'unknown'>('checking')
const indexedTrack = shallowRef<Track | null>(null)
const indexError = ref('')
const storageMode = ref<'json' | 'sqlite' | null>(null)
const indexed = computed(() => indexState.value === 'indexed' && indexedTrack.value !== null)
let indexRequest = 0
let stopLibraryChanged: (() => void) | undefined

async function findIndexedTrack(filePath: string): Promise<Track | null> {
  const mode = await window.api.library.getStorageMode()
  storageMode.value = mode === 'json' || mode === 'sqlite' ? mode : null
  if (mode === 'json') {
    const path = normalizePortableLibraryPath(filePath)
    return (
      music.tracks.value.find((track) => normalizePortableLibraryPath(track.filePath) === path) ??
      null
    )
  }
  if (mode === 'sqlite')
    return lookupLibraryTrackByPath(filePath, window.api.library.database)
  throw new Error('无法确认曲库存储状态')
}

async function refreshIndexedTrack() {
  const request = ++indexRequest
  const path = props.task.targetPath || ''
  indexState.value = 'checking'
  indexedTrack.value = null
  indexError.value = ''
  if (!path) {
    indexState.value = 'missing'
    return
  }
  try {
    const track = await findIndexedTrack(path)
    if (request !== indexRequest) return
    indexedTrack.value = track
    indexState.value = track ? 'indexed' : 'missing'
  } catch (cause) {
    if (request !== indexRequest) return
    indexError.value = cause instanceof Error ? cause.message : String(cause)
    indexState.value = 'unknown'
  }
}

watch(() => props.task.targetPath, refreshIndexedTrack, { immediate: true })
watch(
  () => (storageMode.value === 'json' ? music.tracks.value : null),
  () => {
    if (storageMode.value === 'json') void refreshIndexedTrack()
  }
)
onMounted(() => {
  stopLibraryChanged = window.api.library.onChanged(() => void refreshIndexedTrack())
})
onBeforeUnmount(() => {
  indexRequest++
  stopLibraryChanged?.()
})

const indexLabel = computed(() => {
  if (indexState.value === 'checking') return '正在检查曲库…'
  if (indexed.value) return '已在曲库'
  if (indexState.value === 'unknown') return '无法确认曲库状态'
  return submitted.value ? '已提交索引；稍后可在曲库查看' : '尚未在曲库索引中'
})

function fallbackTrack(filePath: string): Track {
  return {
    id: `download:${props.task.id}`,
    source: 'local',
    title: props.task.track.title,
    artist: props.task.track.artist,
    album: props.task.track.album || '',
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || '',
    duration: 0,
    size: props.task.fileSize || 0,
    cover: null,
    lyrics: null
  }
}
async function act(action: 'play' | 'reveal' | 'add') {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const filePath = await window.api.providerDownloads.result(props.task.id, action === 'add')
    if (action === 'add') submitted.value = true
    if (action === 'reveal') await window.api.shell.showItemInFolder(filePath)
    if (action === 'play') {
      const { usePlayerStore } = await import('../../stores/usePlayerStore')
      const track = (await findIndexedTrack(filePath).catch(() => null)) ?? fallbackTrack(filePath)
      await usePlayerStore().playTrack(track, [track])
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败，请重试'
  } finally {
    pending.value = false
  }
}
</script>
<template>
  <div class="download-results">
    <small>{{ indexLabel }}</small>
    <small v-if="indexError" role="alert">{{ indexError }}</small>
    <div>
      <button type="button" :disabled="pending" @click="act('play')">播放本地文件</button
      ><button type="button" :disabled="pending" @click="act('reveal')">打开目录</button
      ><button
        v-if="indexState === 'missing'"
        type="button"
        :disabled="pending"
        title="复制到第一个音乐库目录；原文件保留"
        @click="act('add')"
      >
        {{ submitted ? '重新索引' : '加入曲库（复制）' }}
      </button>
    </div>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
<style scoped>
.download-results {
  display: grid;
  gap: 8px;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
.download-results > div {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
button {
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  padding: 7px 12px;
}
button:hover {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
</style>
