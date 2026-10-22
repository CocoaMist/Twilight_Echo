import { createApp, h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import { installScrollToTopButton } from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'

const faults = ref(false),
  delay = ref(0),
  reads = ref(0),
  active = ref(0),
  peak = ref(0)
const playback = ref('尚未播放'),
  errors = ref([]),
  currentTrack = ref(null),
  jump = ref(199)
const category = ref('allSongs'),
  filter = ref(null)
window.api = {
  library: {
    getStorageMode: async () => 'sqlite',
    onChanged: () => () => {},
    database: {
      queryTracks: async (query) => {
        reads.value++
        active.value++
        peak.value = Math.max(peak.value, active.value)
        const fail = faults.value
        try {
          if (delay.value) await new Promise((resolve) => setTimeout(resolve, delay.value))
          if (fail) throw new Error('测试磁盘暂不可读')
          const response = await fetch('/fixture/query', {
            method: 'POST',
            body: JSON.stringify(query)
          })
          const page = await response.json()
          if (!response.ok) throw new Error(page.error)
          return page
        } finally {
          active.value--
        }
      }
    }
  },
  data: { loadPlaybackBookmarks: async () => null },
  providers: { list: async () => [] }
}
window.songListPlayer = {
  currentTrack,
  isPlaying: ref(false),
  mode: 'order',
  playTrack() {
    throw new Error('SQLite fixture must not play a renderer array')
  },
  playTrackFromPosition() {
    throw new Error('Unexpected legacy bookmark playback')
  },
  playNextTrack() {
    throw new Error('Playback next is outside this fixture')
  },
  setPlayMode() {
    throw new Error('Query playback must carry its own mode')
  },
  appendQueueTracks() {
    throw new Error('Queue mutation is outside this fixture')
  },
  playLibraryQuery: async (query, id) => {
    playback.value = JSON.stringify({ query, id })
    if (id !== null) {
      const page = await window.api.library.database.queryTracks({
        ...query,
        anchorId: id,
        limit: 200
      })
      currentTrack.value = page.tracks[page.anchorIndex - page.offset]
    }
  }
}
const pinia = createPinia()
setActivePinia(pinia)
const music = useMusicStore()
if (music.tracks.value.length) throw new Error('Fixture must start without compatibility Track[]')
const initial = await window.api.library.database.queryTracks({ sort: 'title', limit: 1 })
currentTrack.value = { id: String(initial.total - 5), title: '当前深处歌曲' }
function scrollToIndex() {
  const container = document.querySelector('.song-list'),
    tbody = container?.querySelector('tbody')
  if (!tbody) return
  const tableTop =
    tbody.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    container.clientTop
  container.scrollTop = tableTop + Number(jump.value) * 68
  container.dispatchEvent(new Event('scroll'))
}
const app = createApp({
  setup: () => () =>
    h('main', [
      h('aside', { class: 'fixture-controls' }, [
        h('strong', 'SQLite · 真实查询 / 合成媒体'),
        h('label', [
          '绝对行 ',
          h('input', {
            'aria-label': '跳转行索引',
            type: 'number',
            value: jump.value,
            onInput: (e) => (jump.value = e.target.value)
          })
        ]),
        h('button', { onClick: scrollToIndex }, '跳转'),
        h('label', [
          h('input', {
            type: 'checkbox',
            checked: faults.value,
            onChange: (e) => (faults.value = e.target.checked)
          }),
          '模拟读取失败'
        ]),
        h('label', [
          '延迟 ms ',
          h('input', {
            'aria-label': '读取延迟',
            type: 'number',
            value: delay.value,
            onInput: (e) => (delay.value = Number(e.target.value))
          })
        ]),
        h(
          'button',
          {
            onClick: () => {
              category.value = category.value === 'allSongs' ? 'artists' : 'allSongs'
              filter.value = category.value === 'artists' ? 'artist:测试艺术家 0' : null
            }
          },
          '切换艺术家详情/全部'
        ),
        h(
          'span',
          `读取 ${reads.value} · 进行中 ${active.value} · 峰值 ${peak.value} · 兼容曲目 ${music.tracks.value.length}`
        ),
        h('output', { 'aria-label': '播放边界' }, playback.value),
        h('output', { role: errors.value.length ? 'alert' : undefined }, errors.value.join('\n'))
      ]),
      h(SongList, {
        category: category.value,
        filter: filter.value,
        hasPlayer: false,
        transitionName: 'page-up',
        onSelectView: (next, value) => {
          category.value = next
          filter.value = value
        }
      })
    ])
})
app.use(pinia)
app.config.errorHandler = (error) => (errors.value = [...errors.value, String(error)])
window.addEventListener(
  'unhandledrejection',
  (event) => (errors.value = [...errors.value, String(event.reason)])
)
app.mount('#app')
installScrollToTopButton()
const style = document.createElement('style')
style.textContent = `body{margin:0;font-family:system-ui}main{height:100vh;display:flex;flex-direction:column}.fixture-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;background:#e9edf3;color:#182032;font-size:13px}.fixture-controls input[type=number]{width:85px}.fixture-controls output{display:block;width:100%;overflow-wrap:anywhere}.song-list{flex:1;min-height:0;height:auto!important}`
document.head.append(style)
