<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import AppNoticeHost from '../../src/renderer/src/components/AppNoticeHost.vue'
import { createPlaylistController } from '../../src/renderer/src/stores/library/playlistController.ts'
import { startPlaylistPersistenceNotifications } from '../../src/renderer/src/app/playlistPersistenceNotifications.ts'
import { PersistentDataRevisionConflictError } from '../../src/shared/versionedPersistence.ts'
import type { Playlist } from '../../src/renderer/src/stores/library/musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../../src/renderer/src/stores/playlistPersistence.ts'

const track = {
  id: 'local',
  title: '月光',
  artist: '测试艺术家',
  album: '测试专辑',
  filePath: 'D:/synthetic/music.flac',
  fileName: 'music.flac',
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null
}
const playlists = shallowRef<Playlist[]>([])
const status = ref<PlaylistPersistenceStatus>({
  state: 'idle',
  dirty: false,
  failureCount: 0,
  lastError: null
})
const reads = ref(0),
  writes = ref(0),
  failRead = ref(false),
  ready = ref(false),
  pending = ref(false),
  dark = ref(false)
let revision = 1
let authority: Playlist[] = [
  { id: 'favorites', name: '收藏', isDefault: true, trackIds: [], createdAt: '' },
  {
    id: 'source',
    name: '待移动歌曲',
    trackIds: [track.id],
    trackSnapshots: { local: track },
    createdAt: ''
  },
  {
    id: 'target',
    name: '导入歌单',
    trackIds: [],
    createdAt: '',
    imported: {
      version: 1,
      source: { kind: 'file', label: 'mix.csv' },
      entries: [],
      complete: true,
      importedAt: '',
      generation: 'refresh',
      membershipRevision: 0
    }
  }
]
function envelope() {
  return { version: 2 as const, revision, savedAt: '', data: structuredClone(authority) }
}
window.api.data = {
  ...window.api.data,
  loadPlaylists: async () => {
    reads.value++
    if (failRead.value) throw new Error('测试读取失败')
    return envelope()
  },
  savePlaylists: async (data, expected) => {
    if (expected !== revision) throw new PersistentDataRevisionConflictError(envelope(), expected)
    writes.value++
    authority = structuredClone(data as Playlist[])
    revision++
    return envelope()
  }
}
const controller = createPlaylistController({
  playlists,
  tracks: shallowRef([]),
  trackById: new Map(),
  getTracksRevision: () => 0,
  playlistPersistenceStatus: status,
  playlistPersistenceNotice: ref(null)
})
const stop = startPlaylistPersistenceNotifications(
  status,
  controller.reloadPlaylistsDiscardingChanges
)
onBeforeUnmount(stop)
onMounted(async () => {
  await controller.loadPlaylists()
  ready.value = true
})
async function conflict() {
  pending.value = true
  try {
    await controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(['local'])
    })
    authority[2].imported!.generation = crypto.randomUUID()
    authority[2].imported!.refreshGeneration = authority[2].imported!.generation
    revision++
    await controller.flushPlaylists()
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main :class="{ dark }">
    <header>Twilight Echo <span> / 歌单冲突恢复验收</span></header>
    <section>
      <p class="eyebrow">PLAYLIST RECOVERY</p>
      <h1>保留修改，<br />直到你决定重新读取。</h1>
      <p>
        生产歌单 controller、CAS 保存队列与全局通知。<br />仅使用隔离的合成数据，不访问个人曲库或磁盘。
      </p>
      <div class="controls">
        <button :disabled="!ready || pending || status.dirty" @click="conflict">
          制造并发刷新冲突
        </button>
        <label><input v-model="failRead" type="checkbox" /> 模拟读取失败</label>
        <label><input v-model="dark" type="checkbox" /> 深色</label>
      </div>
      <div class="state" role="status">
        <p>
          保存状态：{{
            status.canRetry === false
              ? '冲突 · 自动重试已停止'
              : status.dirty
                ? '等待保存'
                : '已同步'
          }}
        </p>
        <p>待移动歌曲：{{ playlists.find((p) => p.id === 'source')?.trackIds.length }} 首</p>
        <p>导入歌单：{{ playlists.find((p) => p.id === 'target')?.imported?.entries.length }} 条</p>
        <p>权威读取 {{ reads }} 次 · 成功写入 {{ writes }} 次</p>
      </div>
    </section>
    <AppNoticeHost />
  </main>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
main {
  --te-app-bg: #f7f8fc;
  --te-surface: #fff;
  --te-text: #202534;
  --te-text-secondary: #626b78;
  --te-border: #a6afbe;
  --te-primary-500: #8766df;
  --te-titlebar-inset: 52px;
  min-height: 100vh;
  color: var(--te-text);
  background: var(--te-app-bg);
}
main.dark {
  --te-app-bg: #15161b;
  --te-surface: #23242c;
  --te-text: #ececf4;
  --te-text-secondary: #a4a5b8;
  --te-border: #717184;
  --te-primary-500: #b29aef;
}
header {
  padding: 18px 28px;
  border-bottom: 1px solid color-mix(in srgb, var(--te-text) 10%, transparent);
  font-size: 14px;
}
header span,
section > p {
  color: var(--te-text-secondary);
}
section {
  padding: 70px 48px;
  max-width: 780px;
}
h1 {
  font-size: 40px;
  line-height: 1.4;
  margin: 14px 0;
  font-weight: 600;
  letter-spacing: -1px;
}
p {
  line-height: 1.8;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 2px;
}
.controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 22px;
  margin: 28px 0;
}
button {
  font: inherit;
  padding: 11px 16px;
  border: 0;
  border-radius: 8px;
  background: var(--te-text);
  color: var(--te-app-bg);
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}
.state {
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--te-text) 12%, transparent);
  font-size: 14px;
}
</style>
