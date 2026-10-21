import { createApp, computed, h, ref, shallowRef } from 'vue'
import LibraryQueueDrawer from '../../src/renderer/src/components/player-bar/LibraryQueueDrawer.vue'
import QueueSavePlaylistDialog from '../../src/renderer/src/components/player-bar/QueueSavePlaylistDialog.vue'
import { createPlaylistController } from '../../src/renderer/src/stores/library/playlistController.ts'
import { createLibraryPlaybackController } from '../../src/renderer/src/stores/player/libraryPlaybackController.ts'
import { libraryQueueTrack } from '../../src/renderer/src/utils/libraryQueuePlayback.ts'
import '../../src/renderer/src/assets/base.css'
import '../../src/renderer/src/assets/primeicons.css'

const rpc =
  (kind) =>
  async (...args) => {
    const response = await fetch('/fixture/queue', {
      method: 'POST',
      body: JSON.stringify({ kind, args })
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  }
const player = createLibraryPlaybackController({
  createQueue: rpc('create'),
  getQueue: rpc('get'),
  readQueue: rpc('read'),
  editQueue: rpc('edit'),
  deleteQueue: rpc('delete')
})
const playlists = shallowRef([]),
  writes = ref(0),
  open = ref(false),
  fail = ref(false),
  slow = ref(false)
window.api = {
  data: {
    savePlaylists: async () => {
      writes.value++
    }
  }
}
const controller = createPlaylistController({
  playlists,
  tracks: shallowRef([]),
  trackById: new Map(),
  getTracksRevision: () => 0,
  playlistPersistenceStatus: ref({ state: 'idle', dirty: false, failureCount: 0, lastError: null }),
  playlistPersistenceNotice: ref(null)
})
await player.create({ sort: 'playlist' }, '0', 'sequential')
const total = computed(() => playlists.value.reduce((count, p) => count + p.trackIds.length, 0))
async function save(name, signal) {
  return controller.createPlaylistWithTrackPages(
    name,
    async (append) => {
      const result = await player.forEachPage(async (page) => {
        if (slow.value) await new Promise((resolve) => setTimeout(resolve, 600))
        if (fail.value && page.offset >= 400) {
          fail.value = false
          throw new Error('队列读取失败，请重试')
        }
        await append(
          page.items.flatMap((item) =>
            item.track ? [libraryQueueTrack(item.track, item.queueEntryId)] : []
          )
        )
      })
      if (!result) throw new Error('队列已变化')
    },
    signal
  )
}
createApp({
  render: () =>
    h('main', [
      h('h1', 'SQLite 队列 · 保存事务'),
      h(
        'p',
        { id: 'saved-status', role: 'status' },
        `已发布 ${playlists.value.length} 个歌单 / ${total.value} 首 · 持久化 ${writes.value} 次`
      ),
      h('div', { class: 'fixture-controls' }, [
        h(
          'button',
          {
            onClick: () => {
              fail.value = true
            }
          },
          '下次保存读取失败'
        ),
        h(
          'button',
          {
            onClick: () => {
              slow.value = !slow.value
            }
          },
          slow.value ? '关闭慢速读取' : '启用慢速读取'
        ),
        h(
          'button',
          {
            onClick: () =>
              (document.documentElement.dataset.theme =
                document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
          },
          '切换明暗'
        )
      ]),
      h(LibraryQueueDrawer, {
        snapshot: player.snapshot.value,
        contentRevision: player.contentRevision.value,
        busy: player.busy.value,
        isPlaying: false,
        readPage: (page) => player.loadPage(page),
        playEntry: (id) => player.selectEntry(id, 'sequential'),
        editQueue: (edit) => player.edit(edit, 'sequential'),
        refreshQueue: () => player.refresh('sequential'),
        onSavePlaylist: () => {
          open.value = true
        }
      }),
      open.value
        ? h(QueueSavePlaylistDialog, {
            save,
            onClose: () => {
              open.value = false
            }
          })
        : null
    ])
}).mount('#app')
const style = document.createElement('style')
style.textContent =
  'body{margin:0;padding:36px;background:var(--te-neutral-100);color:var(--te-neutral-900);font-family:var(--te-font-sans)}h1{font-size:26px}.fixture-controls{display:flex;gap:12px;margin:24px 0}.fixture-controls button{padding:8px 12px}.playlist-panel{margin:40px 0 0;max-height:500px}'
document.head.append(style)
