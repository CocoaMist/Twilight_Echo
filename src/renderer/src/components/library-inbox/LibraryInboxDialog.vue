<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Track } from '@renderer/types/music'
import LocalLibraryTagManager from '@renderer/components/LocalLibraryTagManager.vue'
import { useEscapeToClose, useFocusTrap } from '@renderer/app/useDismissLayer.ts'
import { useCoreConnection } from '@renderer/stores/coreConnection.ts'
import type { CoreInboxPage, CoreInboxState, InboxKind, InboxStatus } from '../../../../shared/coreInbox.ts'
import type { CoreDuplicatesStatus } from '../../../../shared/coreDuplicates.ts'
import type { LibrarySelectionRequest } from '../../../../shared/librarySelection.ts'
import {
  inboxLabels,
  INBOX_PAGE_SIZE
} from '@renderer/components/library-inbox/libraryInbox.ts'

const props = defineProps<{
  tracks: Track[]
  rescan: () => Promise<unknown>
  scanning: boolean
  restoreFocus?: HTMLElement | null
}>()
const emit = defineEmits<{
  close: []
  applied: [trackIds: string[]]
}>()
const core = useCoreConnection()
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const inboxState = shallowRef<CoreInboxState | null>(null)
const inboxPage = shallowRef<CoreInboxPage | null>(null)
const selection = shallowRef(new Set<string>())
const selectedTracks = shallowRef(new Map<string, Track>())
const editTracks = shallowRef<Track[]>([])
const editSelection = shallowRef<LibrarySelectionRequest | undefined>()
const kind = ref<InboxKind | ''>('')
const status = ref<InboxStatus>('pending')
const page = ref(0)
const error = ref('')
const notice = ref('')
const detecting = ref(false)
const rescanning = ref(false)
const marking = ref(false)
const mounted = ref(false)
let generation = 0
let disposed = false
const issues = computed(() =>
  (inboxPage.value?.items ?? []).map((item) => ({ ...item, key: String(item.index) }))
)
const issueIndex = computed(() => new Map(issues.value.map((issue) => [issue.key, issue])))
const counts = computed(
  () => inboxState.value?.counts[status.value] ?? { cover: 0, tags: 0, enrichment: 0, duplicate: 0 }
)
const filtered = computed(() => inboxPage.value?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value / INBOX_PAGE_SIZE)))
const visible = computed(() => issues.value)
watch(
  () => core.state.value?.libraryRevision,
  (revision, previous) => {
    if (revision != null && previous != null && revision !== previous)
      void refreshInbox('曲库已更新，问题已刷新；重复结果需重新检查。')
  }
)
const chosen = computed(() => {
  return [...selectedTracks.value.values()]
})
watch([kind, status], () => {
  page.value = 0
  selection.value = new Set()
  selectedTracks.value = new Map()
  void loadPage()
})
watch(pageCount, (count) => {
  page.value = Math.min(page.value, count - 1)
})
watch(page, () => {
  void nextTick(() => {
    if (list.value) list.value.scrollTop = 0
  })
  void loadPage()
})
watch(
  () => props.tracks,
  () => {
    generation++
    selection.value = new Set()
    selectedTracks.value = new Map()
    void refreshInbox('曲库已更新，问题已刷新；重复结果需重新检查。')
  }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
})
onMounted(() => {
  mounted.value = true
  void core.attach().then(() => refreshInbox()).catch((cause) => {
    error.value = cause instanceof Error ? cause.message : '整理收件箱读取失败'
  })
})
useFocusTrap(root, () => mounted.value && editTracks.value.length === 0)
useEscapeToClose(
  () => true,
  () => {
    if (editTracks.value.length === 0) emit('close')
  }
)

function toggle(key: string): void {
  const next = new Set(selection.value)
  const tracks = new Map(selectedTracks.value)
  if (next.has(key)) {
    next.delete(key)
    tracks.delete(key)
  } else {
    const issue = issueIndex.value.get(key)
    if (!issue) return
    next.add(key)
    tracks.set(key, { ...issue.track, source: issue.track.source ?? 'local' } as Track)
  }
  selection.value = next
  selectedTracks.value = tracks
}
function selectPage(): void {
  const next = new Set(selection.value)
  const tracks = new Map(selectedTracks.value)
  for (const issue of visible.value) {
    next.add(issue.key)
    tracks.set(issue.key, { ...issue.track, source: issue.track.source ?? 'local' } as Track)
  }
  selection.value = next
  selectedTracks.value = tracks
}
function mark(nextStatus: InboxStatus): void {
  const state = inboxState.value
  if (!state || !selection.value.size) return
  const indexes = [...selection.value].map(Number)
  marking.value = true
  void (async () => {
    let revision = state.revision
    for (let offset = 0; offset < indexes.length; offset += 128) {
      const next = (await core.command('library.inbox.mark', {
        id: state.id,
        revision,
        indexes: indexes.slice(offset, offset + 128),
        status: nextStatus
      })) as CoreInboxState
      revision = next.revision
      inboxState.value = next
    }
    await loadPage()
  })()
    .then(() => {
      selection.value = new Set()
      selectedTracks.value = new Map()
      error.value = ''
      notice.value = '整理状态已保存；标记已处理不会修改歌曲或文件。'
    })
    .catch((cause) => {
      error.value = cause instanceof Error ? cause.message : '整理状态保存失败，请重试。'
    })
    .finally(() => {
      marking.value = false
    })
}
async function detect(): Promise<void> {
  if (detecting.value) return
  const request = ++generation
  detecting.value = true
  error.value = ''
  try {
    const started = (await core.command('library.duplicates.start', {})) as CoreDuplicatesStatus
    let result = await core.query('library.duplicates.status', {})
    while (
      result &&
      result.id === started.id &&
      !['completed', 'failed', 'cancelled'].includes(result.state)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      result = await core.query('library.duplicates.status', {})
    }
    if (!result || result.id !== started.id || result.state !== 'completed')
      throw new Error(result?.error || '重复歌曲检查未完成')
    if (request !== generation || disposed) return
    inboxState.value = (await core.command('library.inbox.refresh', {
      duplicatesId: started.id
    })) as CoreInboxState
    await loadPage()
    notice.value = result.unavailable
      ? `${result.unavailable} 个文件无法读取完整 hash；其余证据仍可复核。`
      : `检查完成，发现 ${result.groups} 组候选。`
    kind.value = 'duplicate'
  } catch (cause) {
    if (request === generation && !disposed)
      error.value = cause instanceof Error ? cause.message : '重复检查失败，请重试。'
  } finally {
    detecting.value = false
  }
}
async function refreshInbox(message?: string): Promise<void> {
  const next = (await core.command('library.inbox.refresh', {})) as CoreInboxState
  inboxState.value = next
  await loadPage()
  if (message) notice.value = message
}
async function loadPage(): Promise<void> {
  const state = inboxState.value
  if (!state || disposed) return
  const result = await core.query('library.inbox.page', {
    id: state.id,
    revision: state.revision,
    ...(kind.value ? { kind: kind.value } : {}),
    status: status.value,
    offset: page.value * INBOX_PAGE_SIZE,
    limit: INBOX_PAGE_SIZE
  })
  if (disposed) return
  inboxPage.value = result
  inboxState.value = result.state
}
function editSelected(): void {
  const tracks = chosen.value
  if (!tracks.length || !inboxState.value) return
  editTracks.value = tracks
  editSelection.value = {
    query: {
      ids: tracks.map((track) => track.id),
      contentRevision: inboxState.value.libraryRevision,
      sort: 'insertion'
    },
    total: tracks.length,
    ranges: tracks.length ? [[0, tracks.length]] : []
  }
}
async function requestRescan(): Promise<void> {
  rescanning.value = true
  error.value = ''
  try {
    await props.rescan()
    notice.value = '重扫已返回；后台补全进度可在设置的曲库管理查看。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '后台重扫失败，请重试。'
  } finally {
    rescanning.value = false
  }
}
function applied(trackIds: string[]): void {
  if (trackIds.length) emit('applied', trackIds)
  notice.value = '已显示逐文件结果；封面与其他文件标签可通过显式后台重扫刷新。'
}
</script>

<template>
  <div class="inbox-overlay">
    <section
      v-show="editTracks.length === 0"
      ref="root"
      class="inbox-dialog"
      data-dialog-panel
      role="dialog"
      aria-modal="true"
      aria-labelledby="inbox-title"
    >
      <header>
        <div>
          <h2 id="inbox-title">曲库整理收件箱</h2>
          <p>基于已加载曲库；已处理和忽略仅保存复核状态。</p>
        </div>
        <button @click="emit('close')">关闭</button>
      </header>
      <div class="inbox-controls">
        <label
          >问题
          <select v-model="kind" :disabled="marking">
            <option value="">全部</option>
            <option v-for="(label, value) in inboxLabels" :key="value" :value="value">
              {{ label }} · {{ counts[value] }}
            </option>
          </select></label
        >
        <label
          >状态
          <select v-model="status" :disabled="marking">
            <option value="pending">待处理</option>
            <option value="ignored">已忽略</option>
            <option value="done">已处理</option>
          </select></label
        >
        <button :disabled="detecting" @click="detect">
          {{ detecting ? '检查中…' : '检查疑似重复' }}
        </button>
        <button :disabled="rescanning || scanning" @click="requestRescan">
          {{ rescanning || scanning ? '重扫中…' : '全库后台重扫与补全' }}
        </button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <p role="status">{{ notice }}</p>
      <div class="inbox-controls">
        <button :disabled="marking" @click="selectPage">选择本页</button
        ><button :disabled="marking" @click="selection = new Set(); selectedTracks = new Map()">清空选择</button>
        <span>{{ chosen.length }} 首已选</span>
        <button :disabled="marking || !chosen.length" @click="editSelected">预览并编辑标签</button>
        <button :disabled="marking || !chosen.length" @click="mark('ignored')">忽略</button>
        <button :disabled="marking || !chosen.length" @click="mark('done')">标记已处理</button>
        <button :disabled="marking || !chosen.length" @click="mark('pending')">重新打开</button>
      </div>
      <p v-if="!visible.length">
        {{
          kind === 'duplicate' && !inboxPage
            ? '点击“检查疑似重复”开始只读复核。'
            : '当前筛选没有待展示的问题。'
        }}
      </p>
      <ul ref="list" class="inbox-list">
        <li v-for="issue in visible" :key="issue.key" class="inbox-row">
          <label
            ><input
              type="checkbox"
              :disabled="marking"
              :checked="selection.has(issue.key)"
              @change="toggle(issue.key)"
            /><strong>{{ issue.track.title || issue.track.id }}</strong> ·
            {{ inboxLabels[issue.kind] }}</label
          >
          <p>{{ issue.track.artist }} · {{ issue.track.album }} · {{ issue.reason }}</p>
          <small>{{ issue.track.id }}</small>
        </li>
      </ul>
      <footer>
        <button :disabled="page === 0" @click="page--">上一页</button
        ><span>第 {{ page + 1 }} / {{ pageCount }} 页 · {{ filtered }} 项</span
        ><button :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
      </footer>
    </section>
    <LocalLibraryTagManager
      v-if="editTracks.length"
      :tracks="editTracks"
      :selection="editSelection"
      :current-tracks="tracks"
      @close="editTracks = []; editSelection = undefined"
      @applied="applied"
    />
  </div>
</template>

<style scoped>
.inbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--te-neutral-900) 35%, transparent);
}
.inbox-dialog {
  width: min(960px, calc(100vw - 32px));
  height: min(780px, calc(100vh - 48px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: var(--te-font-size-body, 14px);
  padding: 20px;
  border-radius: 12px;
  background: var(--te-glass-bg-strong);
  color: var(--te-neutral-900);
  border: 1px solid var(--te-glass-border);
}
header,
footer,
.inbox-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
header,
footer {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
}
p,
small {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
}
.inbox-controls {
  margin: 12px 0;
}
button,
select {
  font: inherit;
  color: inherit;
  background: var(--te-glass-bg);
  border: 1px solid var(--te-glass-border);
  border-radius: 6px;
  padding: 7px 10px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.inbox-list {
  flex: 1;
  min-height: 80px;
  overflow: auto;
  list-style: none;
  padding: 0;
}
.inbox-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--te-glass-border);
}
.inbox-row p {
  margin: 5px 0;
}
input {
  margin-right: 8px;
}
</style>
