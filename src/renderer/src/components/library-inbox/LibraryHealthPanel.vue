<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef
} from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import type { EntityMetadataDetail } from '../../../../shared/entityMetadata.ts'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import type {
  HealthCategory,
  HealthIssueState,
  LibraryHealthIssue,
  LibraryHealthState
} from '../../../../shared/libraryHealth.ts'
import {
  createLibraryHealthView,
  HEALTH_PAGE_SIZE,
  healthLabels,
  healthStateLabels
} from './libraryHealthView.ts'
import { metadataTaskReasonLabel } from '../music-metadata/metadataTasksView.ts'
import IdentityReviewInbox from '../music-metadata/IdentityReviewInbox.vue'

const IdentityReviewPanel = defineAsyncComponent(
  () => import('../music-metadata/IdentityReviewPanel.vue')
)
const IntroductionEditor = defineAsyncComponent(
  () => import('../music-metadata/IntroductionEditor.vue')
)
const PersonalMetadataEditor = defineAsyncComponent(
  () => import('../music-metadata/PersonalMetadataEditor.vue')
)
const MetadataTaskList = defineAsyncComponent(
  () => import('../music-metadata/MetadataTaskList.vue')
)
const emit = defineEmits<{
  navigate: [section: 'files' | 'metadata' | 'genres' | 'versions']
  edit: [track: CoreTrackView, revision: number]
}>()
const core = useCoreConnection()
const view = createLibraryHealthView(
  {
    status: () => core.query('library.health.status', {}),
    start: async () => (await core.command('library.health.start', {})) as LibraryHealthState,
    repair: async (request) =>
      (await core.command('library.health.repair', request)) as LibraryHealthState,
    page: (query, signal) => core.query('library.health.page', query, signal)
  },
  { findings: false, scanOnOpen: false }
)
const state = view.state
const snapshot = computed(() => state.value.snapshot)
const report = computed(() => snapshot.value?.report)
const busy = computed(
  () => state.value.loading || ['scanning', 'repairing'].includes(snapshot.value?.phase ?? '')
)
const outdated = computed(
  () =>
    !!report.value &&
    (report.value.libraryRevision !== core.state.value?.libraryRevision ||
      report.value.catalogRevision !== core.state.value?.catalogRevision ||
      report.value.metadataRevision !== core.state.value?.entityMetadataRevision)
)
const groups: Array<{ title: string; note: string; categories: HealthCategory[] }> = [
  {
    title: '歌手资料',
    note: '包含本地与已入库流媒体歌手',
    categories: ['artist_identity', 'artist_name', 'artist_image', 'artist_intro']
  },
  {
    title: '专辑与版本',
    note: '作品简介与具体发行分别检查',
    categories: ['album_identity', 'album_intro', 'release_identity']
  },
  {
    title: '本地歌曲',
    note: '检查文件已有标签，不自动改写音频文件',
    categories: ['track_tags', 'track_cover', 'track_genre']
  }
]
const selected = shallowRef<LibraryHealthIssue | null>(null)
const detail = shallowRef<EntityMetadataDetail | null>(null)
const detailLoading = ref(false),
  detailError = ref(''),
  showTasks = ref(false),
  showCoverage = ref(false)
const activity = computed(() => {
  if (snapshot.value?.phase === 'scanning') return '正在检查可补充的资料…'
  if (snapshot.value?.phase === 'repairing') return '正在后台补充资料，可以继续听歌'
  if (snapshot.value?.repair?.stage === 'completed') return '本轮查询已结束'
  return '只补充可用资料，保留手动修改'
})
function toggleCoverage(event: Event) {
  showCoverage.value = (event.target as HTMLDetailsElement).open
  void view.findings(showCoverage.value)
  if (showCoverage.value && !report.value && !busy.value) void view.refresh()
  if (!showCoverage.value) closeDetail()
}
const detailPanel = ref<HTMLElement | null>(null)
const findingsPanel = ref<HTMLElement | null>(null)
let disposed = false,
  detailGeneration = 0
const scope = computed(() => JSON.stringify([core.state.value?.epoch, selected.value?.entity?.id]))
async function readDetail() {
  const entity = selected.value?.entity
  if (!entity || !report.value) return
  const generation = ++detailGeneration
  detailLoading.value = true
  detailError.value = ''
  try {
    const result = await core.query('metadata.entity.detail', {
      entityId: entity.id,
      language: report.value.language
    })
    if (!disposed && generation === detailGeneration) detail.value = result
  } catch (error) {
    if (!disposed && generation === detailGeneration)
      detailError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (!disposed && generation === detailGeneration) detailLoading.value = false
  }
}
async function inspect(issue: LibraryHealthIssue) {
  selected.value = issue
  detail.value = null
  await readDetail()
  await nextTick()
  if (!disposed) {
    detailPanel.value?.scrollIntoView({ block: 'nearest' })
    detailPanel.value?.focus()
  }
}
function closeDetail() {
  detailGeneration++
  selected.value = null
  detail.value = null
  detailLoading.value = false
}
async function showFindings(category: HealthCategory | '', filter: HealthIssueState | '' = '') {
  closeDetail()
  await view.filter(category, filter)
  await nextTick()
  if (!disposed) {
    findingsPanel.value?.scrollIntoView({ block: 'start' })
    findingsPanel.value?.focus({ preventScroll: true })
  }
}
onMounted(() => {
  void core
    .attach()
    .then(() => view.open())
    .catch((error) => {
      state.value = {
        ...state.value,
        error: error instanceof Error ? error.message : String(error)
      }
    })
})
onBeforeUnmount(() => {
  disposed = true
  detailGeneration++
  view.dispose()
})
function edit(issue: LibraryHealthIssue) {
  if (issue.track && report.value) emit('edit', issue.track, report.value.libraryRevision)
}
</script>

<template>
  <div class="health-panel" aria-label="音乐库整理" :aria-busy="busy">
    <section class="health-hero">
      <div>
        <p v-if="report" class="muted inventory">{{ report.totals.tracks }} 首本地歌曲</p>
        <p class="activity" role="status"><span class="activity-dot" />{{ activity }}</p>
      </div>
      <div class="hero-actions">
        <button type="button" class="primary" :disabled="busy" @click="view.complete()">
          {{ snapshot?.phase === 'repairing' ? '补充中…' : '补充资料' }}
        </button>
      </div>
    </section>

    <p v-if="state.error || snapshot?.error" role="alert" class="error">
      {{ state.error || snapshot?.error }}
    </p>
    <p v-if="snapshot?.repair?.errors" role="alert" class="error">
      {{ snapshot.repair.errors }} 项查询未能提交：{{
        metadataTaskReasonLabel(snapshot.repair.lastError)
      }}
    </p>

    <IdentityReviewInbox compact />

    <details
      class="records-disclosure"
      @toggle="showTasks = ($event.target as HTMLDetailsElement).open"
    >
      <summary>处理记录</summary>
      <MetadataTaskList v-if="showTasks" :active="true" filter="all" :expanded="true" />
    </details>

    <details class="coverage-disclosure" @toggle="toggleCoverage">
      <summary>资料覆盖明细</summary>
      <div v-if="showCoverage" class="coverage-content">
        <div class="findings-heading">
          <p class="muted">按资料字段统计；同一条目可能缺少多项资料。</p>
          <button type="button" :disabled="busy" @click="view.refresh()">重新检查</button>
        </div>

        <template v-if="report">
          <div class="status-shortcuts" aria-label="按处理状态查看缺项">
            <button
              v-for="(label, key) in healthStateLabels"
              v-show="report.states[key]"
              :key="key"
              type="button"
              :aria-pressed="state.filter === key"
              @click="showFindings('', key)"
            >
              {{ label }} <strong>{{ report.states[key] }}</strong>
            </button>
          </div>
          <div class="report-context">
            <p class="muted">
              {{ new Date(report.checkedAt).toLocaleString() }} 检查 ·
              补充资料会联网查询；手动介绍、图片与隐藏选择优先。
            </p>
            <span v-if="outdated && !busy" class="update-note"
              >曲库或资料已更新，重新检查可查看最新覆盖情况。</span
            >
          </div>

          <section v-for="group in groups" :key="group.title" class="metric-group">
            <header class="group-heading">
              <h4>{{ group.title }}</h4>
              <span class="muted">{{ group.note }}</span>
            </header>
            <div class="metric-grid">
              <button
                v-for="category in group.categories"
                :key="category"
                type="button"
                class="metric"
                :aria-pressed="state.category === category"
                @click="showFindings(category)"
              >
                <span class="metric-top"
                  ><strong>{{ healthLabels[category] }}</strong
                  ><span :class="{ missing: report.metrics[category].missing }">{{
                    report.metrics[category].missing
                      ? `缺 ${report.metrics[category].missing} 项`
                      : '无缺项'
                  }}</span></span
                >
                <span class="meter" aria-hidden="true"
                  ><span
                    :style="{
                      width: `${report.metrics[category].total ? ((report.metrics[category].present + report.metrics[category].hidden) / report.metrics[category].total) * 100 : 0}%`
                    }"
                /></span>
                <span class="metric-bottom muted"
                  >已有 {{ report.metrics[category].present }} / {{ report.metrics[category].total
                  }}<span v-if="report.metrics[category].hidden">
                    · 已隐藏 {{ report.metrics[category].hidden }}</span
                  ><span v-if="report.metrics[category].repairable" class="actionable">
                    · 可处理 {{ report.metrics[category].repairable }}</span
                  ></span
                >
              </button>
            </div>
          </section>

          <section
            ref="findingsPanel"
            class="health-findings"
            tabindex="-1"
            aria-label="资料覆盖缺项明细"
          >
            <header class="findings-heading">
              <h4>
                缺项明细 <span class="muted">{{ state.page?.total ?? '…' }} 项</span>
              </h4>
              <button
                v-if="state.category && report.metrics[state.category].repairable"
                type="button"
                :disabled="busy || snapshot?.phase !== 'ready'"
                @click="view.repair(state.category)"
              >
                补全此类缺项
              </button>
            </header>
            <div class="finding-filters">
              <label
                >检查项目<select
                  :value="state.category"
                  @change="
                    view.filter(
                      ($event.target as HTMLSelectElement).value as HealthCategory | '',
                      state.filter
                    )
                  "
                >
                  <option value="">全部项目</option>
                  <option v-for="(label, key) in healthLabels" :key="key" :value="key">
                    {{ label }}
                  </option>
                </select></label
              >
              <label
                >处理状态<select
                  :value="state.filter"
                  @change="
                    view.filter(
                      state.category,
                      ($event.target as HTMLSelectElement).value as HealthIssueState | ''
                    )
                  "
                >
                  <option value="">全部状态</option>
                  <option v-for="(label, key) in healthStateLabels" :key="key" :value="key">
                    {{ label }} · {{ report.states[key] }}
                  </option>
                </select></label
              >
            </div>
            <p v-if="state.filter === 'blocked'" class="source-note">
              请在设置 →
              曲库管理检查音乐资料源、部署授权与账号状态。公共服务配置由应用部署方提供，用户不需要自己申请公共服务密钥。
            </p>
            <p v-if="state.page && !state.page.total" class="empty">当前筛选没有缺项。</p>
            <ul class="finding-list">
              <li
                v-for="issue in state.page?.items ?? []"
                :key="`${state.page?.id}:${issue.index}`"
              >
                <div class="finding-content">
                  <strong>{{ issue.title || '未命名条目' }}</strong
                  ><span class="muted"
                    >{{ issue.subtitle }} · {{ healthLabels[issue.category] }}</span
                  >
                  <p>{{ metadataTaskReasonLabel(issue.reason) }}</p>
                </div>
                <div class="finding-actions">
                  <span class="state-badge" :data-state="issue.state">{{
                    healthStateLabels[issue.state]
                  }}</span>
                  <button v-if="issue.entity" type="button" @click="inspect(issue)">
                    {{ issue.state === 'review' ? '核对身份' : '查看与补充' }}
                  </button>
                  <template v-else>
                    <button
                      v-if="issue.category === 'track_genre'"
                      type="button"
                      @click="emit('navigate', 'genres')"
                    >
                      整理流派
                    </button>
                    <button type="button" @click="edit(issue)">预览并编辑标签</button>
                  </template>
                </div>
              </li>
            </ul>
            <nav
              v-if="state.page && state.page.total > HEALTH_PAGE_SIZE"
              class="pagination"
              aria-label="资料覆盖缺项分页"
            >
              <button
                type="button"
                :disabled="!state.offset"
                @click="view.page(Math.max(0, state.offset - HEALTH_PAGE_SIZE))"
              >
                上一页
              </button>
              <span class="muted"
                >{{ state.offset + 1 }}–{{ state.offset + state.page.items.length }} /
                {{ state.page.total }}</span
              >
              <button
                type="button"
                :disabled="state.offset + HEALTH_PAGE_SIZE >= state.page.total"
                @click="view.page(state.offset + HEALTH_PAGE_SIZE)"
              >
                下一页
              </button>
            </nav>
          </section>
          <section
            v-if="selected?.entity"
            ref="detailPanel"
            class="detail-pane"
            tabindex="-1"
            aria-label="补充条目资料"
          >
            <header class="findings-heading">
              <h4>{{ selected.title }} · {{ healthLabels[selected.category] }}</h4>
              <button type="button" @click="closeDetail">收起条目</button>
            </header>
            <p v-if="detailError" role="alert" class="error">{{ detailError }}</p>
            <IdentityReviewPanel
              v-if="selected.state === 'review'"
              :entity-id="selected.entity.id"
              :scope="scope"
              @changed="readDetail"
            />
            <p v-if="detailLoading" role="status" class="muted">正在读取条目资料…</p>
            <template v-if="detail && !detailLoading">
              <p class="saved-intro">
                {{
                  detail.introduction?.value ||
                  '当前没有可展示的简介。可以手动填写，也可在确认身份后使用自动补全。'
                }}
              </p>
              <IntroductionEditor
                :key="scope"
                :scope="scope"
                :selected="selected.entity.id"
                :detail="detail"
                :language="report.language"
                :available="!detailLoading"
                :refresh="readDetail"
              />
              <PersonalMetadataEditor
                :key="scope"
                :scope="scope"
                :selected="selected.entity.id"
                :detail="detail"
                :language="report.language"
                :available="!detailLoading"
                :refresh="readDetail"
              />
            </template>
          </section>
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
.health-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 4px 4px 0;
  font-size: 13px;
  line-height: 1.55;
}
.health-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 2px 0 18px;
}
h4 {
  font-size: 14px;
  margin: 0;
}
p {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.muted {
  color: var(--te-neutral-500);
}
.inventory {
  font-size: 13px;
}
.hero-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
button,
select {
  color: inherit;
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--te-card-border);
  border-radius: 7px;
  background: var(--te-card-bg, Canvas);
  padding: 7px 10px;
}
button {
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.primary {
  background: var(--te-primary-600, var(--te-primary-500));
  color: var(--te-neutral-50, #fff);
  border-color: transparent;
  font-weight: 600;
}
.primary:hover:not(:disabled) {
  background: var(--te-primary-700, var(--te-primary-500));
}
.activity {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--te-neutral-500);
  font-size: 13px;
  margin-top: 5px;
}
.activity-dot {
  height: 7px;
  width: 7px;
  border-radius: 50%;
  background: var(--te-neutral-500);
}
.error {
  color: var(--te-danger, #d45151);
}
.report-context {
  font-size: 12px;
  margin-bottom: 18px;
}
.status-shortcuts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 2px 0 12px;
}
.status-shortcuts button {
  border-color: transparent;
  background: color-mix(in srgb, var(--te-neutral-500) 7%, transparent);
  padding: 4px 8px;
}
.status-shortcuts button[aria-pressed='true'] {
  color: var(--te-primary-600, var(--te-primary-500));
  border-color: var(--te-primary-500);
}
.status-shortcuts strong {
  margin-left: 3px;
}
.update-note {
  color: var(--te-primary-600, var(--te-primary-500));
}
.metric-group {
  margin: 0 0 18px;
}
.group-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.group-heading .muted {
  font-size: 12px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.metric {
  text-align: left;
  padding: 12px 14px;
  border-radius: 10px;
  min-width: 0;
}
.metric[aria-pressed='true'] {
  border-color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500) 7%, var(--te-card-bg));
}
.metric-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.metric-top strong {
  font-size: 13px;
  font-weight: 600;
}
.metric-top > span {
  color: var(--te-neutral-500);
  font-size: 12px;
}
.metric-top > span.missing {
  color: var(--te-neutral-500);
}
.meter {
  display: block;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--te-neutral-500) 14%, transparent);
  margin: 10px 0 7px;
  overflow: hidden;
}
.meter > span {
  display: block;
  height: 100%;
  background: var(--te-neutral-500);
}
.metric-bottom {
  display: block;
  font-size: 12px;
}
.actionable {
  color: var(--te-neutral-700, var(--te-neutral-500));
}
.records-disclosure,
.coverage-disclosure {
  border-top: 1px solid var(--te-card-border);
  padding: 14px 0;
}
summary {
  cursor: pointer;
  width: fit-content;
  color: var(--te-neutral-500);
  font-size: 13px;
}
summary:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.coverage-content {
  padding-top: 16px;
}
.findings-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.finding-filters {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.finding-filters label {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 12px;
}
.finding-filters select {
  max-width: 200px;
}
.finding-list {
  padding: 0;
  margin: 0;
  list-style: none;
}
.finding-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px solid var(--te-card-border);
}
.finding-content {
  min-width: 0;
  flex: 1;
}
.finding-content > strong,
.finding-content > span {
  display: block;
  overflow-wrap: anywhere;
}
.finding-content p {
  color: var(--te-neutral-700, var(--te-neutral-500));
  font-size: 12px;
}
.finding-content > span {
  font-size: 12px;
}
.finding-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  flex-shrink: 0;
}
.state-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--te-neutral-500) 9%, transparent);
  color: var(--te-neutral-500);
}
.state-badge[data-state='ready'],
.state-badge[data-state='processing'] {
  color: var(--te-primary-600, var(--te-primary-500));
  background: color-mix(in srgb, var(--te-primary-500) 9%, transparent);
}
.state-badge[data-state='failed'] {
  color: var(--te-danger, #d45151);
}
.pagination {
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
  padding: 14px 0;
}
.empty,
.source-note {
  padding: 12px 0;
  color: var(--te-neutral-500);
}
.detail-pane {
  border: 1px solid var(--te-card-border);
  padding: 14px;
  border-radius: 10px;
  margin-top: 16px;
}
.detail-pane {
  overflow-wrap: anywhere;
}
.saved-intro {
  white-space: pre-wrap;
  margin: 14px 0;
}
@media (max-width: 640px) {
  .health-hero {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
  }
  .hero-actions {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .metric-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .group-heading {
    flex-direction: column;
    gap: 1px;
  }
  .finding-list li {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .finding-actions {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
  }
}
</style>
