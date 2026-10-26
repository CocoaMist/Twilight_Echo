<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import type { UnifiedPlaybackResult } from '../../../../shared/musicUnifiedPlayback.ts'
import PersonalRatingsPanel from '../music-ratings/PersonalRatingsPanel.vue'
import {
  ALBUM_RELEASE_PAGE_SIZE,
  ALBUM_SOURCE_PAGE_SIZE,
  albumAvailabilityLabel,
  albumProviderOrder,
  albumProviderLabel,
  createAlbumVersionsView,
  type AlbumSourceOrder
} from './albumVersionsView.ts'

const props = defineProps<{
  entityId: string
  activeSection?: 'overview' | 'versions' | 'curation' | 'all'
}>()
const isOverviewMode = computed(() => props.activeSection === 'overview')
const showVersionsBody = computed(
  () => !props.activeSection || props.activeSection === 'versions' || props.activeSection === 'all'
)
const core = useCoreConnection()
const view = createAlbumVersionsView({
  browse: (query, signal) => core.query('albums.browse', query, signal),
  sources: (query, signal) => core.query('albums.sources', query, signal),
  play: (sourceId, revision, signal) =>
    core.command('catalog.play', { sourceId, revision }, signal),
  playUnified: async (sourceId, revision, albumScope, signal, providerOrder) =>
    (await core.command(
      'catalog.playUnified',
      { sourceId, revision, albumScope, providerOrder },
      signal
    )) as UnifiedPlaybackResult
})
const { state, busy, ready } = view
const managing = ref(false)
const reviewingVersionId = ref<string | null>(null)
const sourceOrder = ref<AlbumSourceOrder>('default')
const orderNotice = ref('')
const providersComplete = computed(
  () =>
    !!state.value.sources &&
    state.value.sources.providerCount === state.value.sources.providers.length
)
const providerOrder = computed(() =>
  albumProviderOrder(
    sourceOrder.value === 'streaming-first' && !providersComplete.value
      ? 'default'
      : sourceOrder.value,
    state.value.sources?.providers ?? []
  )
)
watch(
  () => state.value.sources,
  (sources) => {
    orderNotice.value = ''
    if (
      sources &&
      sources.providerCount > sources.providers.length &&
      sourceOrder.value === 'streaming-first'
    ) {
      sourceOrder.value = 'default'
      orderNotice.value = '平台名单未完整列出，来源顺序已恢复默认。'
    }
  },
  { flush: 'sync' }
)
const MusicVersionsHost = defineAsyncComponent(() => import('./MusicVersionsHost.vue'))
const IdentityReviewPanel = defineAsyncComponent(
  () => import('../music-metadata/IdentityReviewPanel.vue')
)
const selectedRelease = computed(() => state.value.sources?.release)
const ratingRelease = ref<{ entityId: string; groupId: string; title: string; artist: string } | null>(null)
watch([() => state.value.selectedReleaseId, () => selectedRelease.value], ([groupId, release]) => {
  if (release) ratingRelease.value = { entityId: release.entityId, groupId: release.id, title: release.title, artist: release.artist }
  else if (groupId !== ratingRelease.value?.groupId) ratingRelease.value = null
}, { flush: 'sync' })
const chosenSource = computed(() =>
  state.value.sources?.items.find((source) => source.sourceId === state.value.playResult?.sourceId)
)
const chosenAttempt = computed(() =>
  state.value.playResult?.attempts.find((attempt) => attempt.status === 'selected')
)
watch(
  [() => props.entityId, () => core.state.value?.epoch],
  ([id, epoch]) => void view.setContext(id, String(epoch)),
  { immediate: true, flush: 'sync' }
)
watch(
  () => props.entityId,
  () => {
    reviewingVersionId.value = null
    managing.value = false
  }
)
watch(
  () => [
    core.state.value?.catalogRevision,
    core.state.value?.libraryRevision,
    core.state.value?.entityMetadataRevision,
    core.state.value?.classificationMetadataRevision,
    core.state.value?.versionsRevision,
    core.state.value?.settingsRevision,
    core.state.value?.pluginsRevision
  ],
  (revisions, previous) => {
    if (
      previous &&
      revisions.some((value, index) => previous[index] != null && previous[index] !== value)
    )
      view.invalidate()
  },
  { flush: 'sync' }
)
onBeforeUnmount(view.dispose)
</script>

<template>
  <section
    class="album-versions"
    :class="{ 'is-overview-mode': isOverviewMode }"
    aria-label="专辑发行与播放来源"
    :aria-busy="busy"
  >
    <div :class="{ 'detail-pane-hidden': !showVersionsBody }">
      <header class="versions-heading">
      <div>
        <h3>发行与音源</h3>
        <p>具体发行与人工播放版本分开显示。</p>
      </div>
      <div class="versions-actions">
        <button type="button" :disabled="busy || !!state.playingId" @click="view.refresh()">
          重新读取版本
        </button>
        <button type="button" @click="managing = true">管理播放版本关系</button>
      </div>
    </header>
    <p v-if="state.loading" role="status">正在读取专辑发行…</p>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <template v-if="state.page">
      <div class="album-project">
        <span class="eyebrow">专辑项目</span>
        <template v-if="state.page.project">
          <h4>{{ state.page.project.title }}</h4>
          <p>
            {{ state.page.project.artist }} ·
            {{ state.page.project.identity === 'confirmed' ? '项目身份已确认' : '项目身份待确认' }}
          </p>
        </template>
        <p v-else-if="state.page.projectCount > 1">
          此人工播放关系包含 {{ state.page.projectCount }} 个独立专辑项目，发行分别保留。
        </p>
        <p v-else>尚无已关联的专辑项目</p>
      </div>
      <section aria-label="选择具体发行" class="release-section">
        <div class="section-heading">
          <h4>库内发行</h4>
          <span>{{ state.page.total }} 个</span>
        </div>
        <ul class="release-list">
          <li v-for="release in state.page.items" :key="release.id">
            <button
              type="button"
              :aria-pressed="state.selectedReleaseId === release.id"
              :disabled="!ready || !!state.playingId"
              @click="view.select(release.id)"
            >
              <strong>{{ release.title }}</strong>
              <span>{{ release.artist }}</span>
              <span
                >{{ release.current ? '当前发行 · ' : ''
                }}{{ release.identity === 'confirmed' ? '资料发行已确认' : '发行待识别' }}</span
              >
              <span
                >{{ release.sourceCount }} 个音源 ·
                {{ release.playbackVersionCount }} 个人工播放版本</span
              >
            </button>
          </li>
        </ul>
        <nav
          v-if="state.page.total > ALBUM_RELEASE_PAGE_SIZE"
          class="pagination"
          aria-label="发行分页"
        >
          <button
            type="button"
            :disabled="!ready || !!state.playingId || state.page.offset === 0"
            @click="view.page(state.page.offset - ALBUM_RELEASE_PAGE_SIZE)"
          >
            上一页发行
          </button>
          <span
            >{{ state.page.offset + 1 }}–{{
              Math.min(state.page.total, state.page.offset + state.page.items.length)
            }}
            / {{ state.page.total }}</span
          >
          <button
            type="button"
            :disabled="
              !ready ||
              !!state.playingId ||
              state.page.offset + state.page.items.length >= state.page.total
            "
            @click="view.page(state.page.offset + ALBUM_RELEASE_PAGE_SIZE)"
          >
            下一页发行
          </button>
        </nav>
        <p class="hint">仅列出实际入库的发行；外部发行目录尚未接入。</p>
      </section>
    </template>
    <p v-if="state.loadingSources" role="status">正在读取所选发行的音源…</p>
    <p v-if="state.sourceError" class="error" role="alert">{{ state.sourceError }}</p>
    <section v-if="state.sources" class="source-section" aria-label="所选发行的播放来源">
      <div class="section-heading">
        <h4>{{ selectedRelease?.title ?? '所选发行' }} · 音源</h4>
        <span>{{ state.sources.total }} 个</span>
      </div>
      <p class="hint">统一播放此曲按歌曲版本偏好选源；专辑版本关系不会自动建立歌曲对应关系。明确播放只使用点击的音源。</p>
      <label class="source-order"
        >来源顺序
        <select v-model="sourceOrder" :disabled="!ready || !!state.playingId">
          <option value="default">默认</option>
          <option value="local-first">本地优先</option>
          <option value="streaming-first" :disabled="!providersComplete">流媒体优先</option>
        </select>
      </label>
      <p class="hint">仅用于本页统一播放，人工首选音源仍优先。</p>
      <p v-if="orderNotice" role="status">{{ orderNotice }}</p>
      <p v-if="!providersComplete" class="hint">来源平台超过本页可列数量，暂不可选择流媒体优先。</p>
      <ul class="source-list">
        <li v-for="source in state.sources.items" :key="source.sourceId">
          <div class="source-description">
            <strong>{{ source.title }}</strong>
            <span
              >{{ source.artist }} · {{ albumProviderLabel(source.provider) }} ·
              {{ albumAvailabilityLabel(source.availability)
              }}{{ source.preferred ? ' · 偏好音源' : '' }}</span
            >
            <span v-if="source.playbackVersion">
              人工专辑播放版本：{{ source.playbackVersion.label || '未命名' }}
              <template v-if="source.playbackVersion.familyId">
                · 已关联版本族{{
                  source.playbackVersion.preferredVersionId === source.playbackVersion.id
                    ? ' · 族内首选'
                    : source.playbackVersion.preferredVersionId
                      ? ' · 另有族内首选'
                      : ''
                }}</template
              >
            </span>
            <span v-else>未设置人工专辑播放版本</span>
            <span
              v-if="
                source.playbackVersion?.metadataTargetId ||
                source.playbackVersion?.projectMetadataTargetId
              "
              >人工播放版本自身另有资料关联</span
            >
            <span v-if="source.identityConflict" class="error"
              >人工播放版本的资料身份与此音源发行不同，请复核关联。</span
            >
          </div>
          <div class="source-actions">
            <button
              type="button"
              :disabled="!ready || !!state.playingId"
              @click="view.play(source.sourceId, true, providerOrder)"
            >
              统一播放此曲
            </button>
            <button
              type="button"
              :disabled="!ready || !!state.playingId"
              @click="view.play(source.sourceId)"
            >
              明确播放此音源
            </button>
            <button
              v-if="source.playbackVersion"
              type="button"
              @click="reviewingVersionId = source.playbackVersion.entityId"
            >
              复核播放版本身份
            </button>
          </div>
        </li>
      </ul>
      <p v-if="!state.sources.total" class="hint">此发行暂无可读取的库内音源。</p>
      <nav
        v-if="state.sources.total > ALBUM_SOURCE_PAGE_SIZE"
        class="pagination"
        aria-label="音源分页"
      >
        <button
          type="button"
          :disabled="!ready || !!state.playingId || state.sources.offset === 0"
          @click="view.sourcePage(state.sources.offset - ALBUM_SOURCE_PAGE_SIZE)"
        >
          上一页音源
        </button>
        <span
          >{{ state.sources.offset + 1 }}–{{
            Math.min(state.sources.total, state.sources.offset + state.sources.items.length)
          }}
          / {{ state.sources.total }}</span
        >
        <button
          type="button"
          :disabled="
            !ready ||
            !!state.playingId ||
            state.sources.offset + state.sources.items.length >= state.sources.total
          "
          @click="view.sourcePage(state.sources.offset + ALBUM_SOURCE_PAGE_SIZE)"
        >
          下一页音源
        </button>
      </nav>
    </section>
    </div>
    <div v-if="isOverviewMode && !ratingRelease" class="rating-release-empty" role="status">
      <h3>评分</h3>
      <p v-if="busy">正在读取具体发行…</p>
      <p v-else-if="state.error || state.sourceError">
        无法读取评分条目
        <button type="button" @click="view.refresh()">重试</button>
      </p>
      <p v-else>暂无可评分的具体发行</p>
    </div>
    <section
      v-if="ratingRelease"
      class="rating-release-section"
      aria-label="所选具体发行的评分"
    >
      <p class="rating-target-caption">评分对象：{{ ratingRelease.title }} · {{ ratingRelease.artist }}</p>
      <PersonalRatingsPanel
        :entity-id="ratingRelease.entityId"
        :scope="JSON.stringify([entityId, ratingRelease.groupId])"
        label="具体发行"
        :compact="isOverviewMode"
      />
    </section>
    <div :class="{ 'detail-pane-hidden': !showVersionsBody }">
    <p v-if="state.playingId" role="status">
      正在准备音源… <button type="button" @click="view.cancelPlayback()">取消准备</button>
    </p>
    <p v-if="state.playError" class="error" role="alert">{{ state.playError }}</p>
    <p v-if="state.playNotice" role="status">{{ state.playNotice }}</p>
    <div v-if="state.playResult" class="play-result" role="status">
      <p v-if="state.playResult.status === 'played'">
        实际音源：{{ albumProviderLabel(chosenAttempt?.provider ?? chosenSource?.provider ?? '') }}
        {{
          chosenSource?.title ?? '已选等价音源'
        }}
      </p>
      <p v-else class="error">当前发行内没有可播放的等价音源，请查看原因或明确选择其他音源。</p>
      <ul v-if="state.playResult.attempts.some((attempt) => attempt.status === 'failed')">
        <li
          v-for="attempt in state.playResult.attempts.filter((item) => item.status === 'failed')"
          :key="attempt.sourceId"
        >
          {{ albumProviderLabel(attempt.provider) }}：{{
            attempt.message || attempt.code || '音源准备失败'
          }}
        </li>
      </ul>
      <details>
        <summary>选源明细</summary>
        <ul>
          <li v-for="attempt in state.playResult.attempts" :key="attempt.sourceId">
            {{ albumProviderLabel(attempt.provider) }} · <code>{{ attempt.sourceId }}</code> ·
            {{
              attempt.status === 'selected'
                ? '实际播放'
                : attempt.message || attempt.code || '准备失败'
            }}
          </li>
        </ul>
      </details>
    </div>
    <MusicVersionsHost v-if="managing" initial-scope="albums" @close="managing = false" />
    <section v-if="reviewingVersionId" aria-label="人工播放版本自身资料身份">
      <div class="section-heading">
        <h4>人工播放版本自身的资料关联</h4>
        <button type="button" @click="reviewingVersionId = null">关闭复核</button>
      </div>
      <IdentityReviewPanel
        :entity-id="reviewingVersionId"
        :scope="`${entityId}:${core.state.value?.epoch}`"
        @changed="view.invalidate()"
      />
    </section>
    </div>
  </section>
</template>

<style scoped>
.album-versions {
  margin: 0 0 24px;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid var(--te-card-border, color-mix(in srgb, var(--te-neutral-500) 16%, transparent));
  background: var(--te-card-bg, color-mix(in srgb, var(--te-neutral-500, #888) 4%, transparent));
  font-size: var(--te-font-size-body, 13px);
  color: var(--te-neutral-700);
}
.album-versions.is-overview-mode {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.detail-pane-hidden {
  display: none;
}
.rating-target-caption {
  font-size: 12px;
  color: var(--te-neutral-500);
}
.album-versions.is-overview-mode .rating-target-caption {
  display: none;
}
.rating-release-empty { display: flex; align-items: baseline; gap: 16px; }
.rating-release-empty h3, .rating-release-empty p { margin: 0; color: var(--te-neutral-500); font-size: 12.5px; font-weight: 400; }
.versions-heading,
.section-heading,
.versions-actions,
.source-actions,
.pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.versions-heading,
.section-heading {
  justify-content: space-between;
}
.versions-heading {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--te-card-border, color-mix(in srgb, var(--te-neutral-500) 16%, transparent));
}
h3,
h4,
p {
  margin: 0;
}
h3,
h4,
strong {
  color: var(--te-neutral-900);
}
h3 {
  font-size: 16px;
  font-weight: 700;
}
h4 {
  font-size: 14px;
  font-weight: 650;
}
p {
  line-height: 1.65;
  margin-block: 6px;
}
.hint,
.eyebrow,
.versions-heading p,
.source-description span {
  color: var(--te-neutral-500);
  font-size: 12px;
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500, #3b82f6) 12%, transparent);
  margin-bottom: 6px;
}
.album-project {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--te-card-border, color-mix(in srgb, var(--te-neutral-500) 18%, transparent));
  border-left: 4px solid var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500, #3b82f6) 4%, transparent);
}
.release-section,
.source-section {
  margin-top: 20px;
}
button {
  font: inherit;
  font-weight: 500;
  border: 1px solid var(--te-card-border, color-mix(in srgb, var(--te-neutral-500) 18%, transparent));
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--te-card-bg, transparent);
  color: var(--te-primary-600);
  cursor: pointer;
  transition: background-color 0.14s ease, border-color 0.14s ease;
}
select {
  font: inherit;
  padding: 6px 10px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
}
.source-order {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
button:not(:disabled):hover,
button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 40%, transparent);
}
.release-list,
.source-list {
  list-style: none;
  padding: 0;
  margin-block: 12px;
}
.release-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px;
}
.release-list button {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 14px;
  border-radius: 10px;
  text-align: left;
  color: var(--te-neutral-600);
  border: 1px solid var(--te-card-border, color-mix(in srgb, var(--te-neutral-500) 18%, transparent));
}
.release-list button[aria-pressed='true'] {
  border-color: var(--te-primary-500);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--te-primary-500) 35%, transparent);
}
.source-list > li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 10px;
  border-bottom: 1px solid var(--te-card-border, color-mix(in srgb, var(--te-neutral-500) 14%, transparent));
  border-radius: 8px;
}
.source-list > li:hover {
  background: var(--te-hover-bg, color-mix(in srgb, var(--te-primary-500) 4%, transparent));
}
.source-description {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 240px;
  line-height: 1.55;
}
.source-description strong,
.release-list strong,
.release-list span,
code {
  overflow-wrap: anywhere;
}
.source-actions {
  flex-shrink: 0;
}
.source-actions button:first-child {
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  font-weight: 600;
}
.pagination {
  margin-top: 10px;
}
.error {
  color: var(--te-error-600, #b64545);
}
.play-result {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--te-card-border);
  line-height: 1.65;
}
code {
  font: inherit;
  color: var(--te-neutral-500);
}
@media (max-width: 640px) {
  .release-list {
    grid-template-columns: 1fr;
  }
  .source-actions {
    width: 100%;
  }
}
</style>
