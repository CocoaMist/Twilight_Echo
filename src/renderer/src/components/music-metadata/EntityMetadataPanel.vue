<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import AlbumMetadataDialog from './AlbumMetadataDialog.vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useSettingsStore } from '../../stores/useSettingsStore.ts'
import { useLocale } from '../../app/useLocale.ts'
import {
  createEntityMetadataView,
  observeEntityMetadataView,
  METADATA_REFERENCE_PAGE_SIZE,
  type EntityMetadataContext
} from './entityMetadataView.ts'
import MetadataAttribution from './MetadataAttribution.vue'
import IntroductionEditor from './IntroductionEditor.vue'
import PersonalMetadataEditor from './PersonalMetadataEditor.vue'
import EntityArtwork from './EntityArtwork.vue'
import IdentityReviewPanel from './IdentityReviewPanel.vue'
import PersonalPreferencesPanel from '../music-preferences/PersonalPreferencesPanel.vue'
import type { EntityMetadataLanguage } from '../../../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId } from '../../../../shared/entityMetadata.ts'
import MetadataUpdateControls from './MetadataUpdateControls.vue'
import { formatReleaseDate } from '../../../../shared/releaseDate.ts'

export interface AlbumOverviewSummary {
  name: string
  artist?: string
  releaseDate?: string
  trackCount?: number
  durationText?: string
  formatText?: string
  typeText?: string
  genres?: string[]
}

const props = withDefaults(
  defineProps<{
    target: EntityMetadataContext
    fallbackIntro?: string
    albumSummary?: AlbumOverviewSummary | null
    showArtwork?: boolean
    favorited?: boolean | null
    favoritePending?: boolean
    presentation?: 'default' | 'album-overview'
  }>(),
  { showArtwork: true, presentation: 'default' }
)
defineEmits<{
  toggleFavorite: []
  addToPlaylist: []
}>()
const core = useCoreConnection(),
  settings = useSettingsStore(),
  { locale } = useLocale()
const layer = ref<'release' | 'album_project'>('release')
type MetadataSection = 'overview' | 'versions' | 'curation' | 'all'
const activeSection = ref<MetadataSection>('overview')
const isAlbumOverview = computed(
  () => props.presentation === 'album-overview' && props.target.kind === 'release'
)
const detailsOpen = ref(false)
const overviewBody = ref<HTMLElement | null>(null)
const previewHeight = ref(0)
const presentationId = `album-metadata-${useId()}`
const overviewId = `${presentationId}-overview`
const detailsId = `${presentationId}-details`
const isAlbumPreview = computed(() => isAlbumOverview.value && !detailsOpen.value)
let restoreIntroductionFocus = false
function openDetails(
  section: 'overview' | 'versions' | 'curation',
  fromIntroduction = false
): void {
  if (!detailsOpen.value)
    previewHeight.value = overviewBody.value?.getBoundingClientRect().height ?? 0
  restoreIntroductionFocus = fromIntroduction
  activeSection.value = section
  detailsOpen.value = true
}
function closeDetails(): void {
  activeSection.value = 'overview'
  detailsOpen.value = false
  if (restoreIntroductionFocus) {
    restoreIntroductionFocus = false
    // The preview-only opener is recreated when the shared tree returns from the dialog.
    void nextTick(() =>
      overviewBody.value
        ?.querySelector<HTMLButtonElement>('.album-intro-more')
        ?.focus({ preventScroll: true })
    )
  }
}
function expandIntroduction(): void {
  if (isAlbumPreview.value) {
    openDetails('overview', true)
    expanded.value = true
  } else expanded.value = !expanded.value
}
function onTabsKeydown(event: KeyboardEvent): void {
  const tabs = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')
  )
  const index = tabs.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  const next =
    event.key === 'ArrowRight'
      ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft'
        ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : -1
  if (next < 0) return
  event.preventDefault()
  tabs[next].focus()
  tabs[next].click()
}
const expanded = ref(false)
const exploreArtist = ref(false)
const MusicExplorationPanel = defineAsyncComponent(
  () => import('../music-exploration/MusicExplorationPanel.vue')
)
const albumEntityId = ref<string | null>(null)
const sections = computed<{ id: MetadataSection; label: string }[]>(() => [
  { id: 'overview', label: isAlbumOverview.value ? '专辑资料' : '概览与介绍' },
  ...(props.target.kind === 'release' && albumEntityId.value
    ? [{ id: 'versions' as const, label: '发行与音源' }]
    : []),
  { id: 'curation', label: isAlbumOverview.value ? '身份与整理' : '身份复核与整理' },
  ...(!isAlbumOverview.value ? [{ id: 'all' as const, label: '展开全部' }] : [])
])
const AlbumVersionsPanel = defineAsyncComponent(
  () => import('../music-versions/AlbumVersionsPanel.vue')
)
const suppressLegacyIntro = ref(false)
const target = computed(() => ({
  ...props.target,
  kind: props.target.kind === 'release' ? layer.value : props.target.kind
}))
const language = computed<EntityMetadataLanguage>(
  () =>
    settings.settings.value.musicIdentification.language ??
    (locale.value === 'en-US' ? 'en' : 'zh-Hans')
)
const view = createEntityMetadataView({
  catalog: (query, signal) => core.query('catalog.query', query, signal),
  sources: (query, signal) => core.query('catalog.sources', query, signal),
  detail: (entityId, language, sourceProvider, signal) =>
    core.query('metadata.entity.detail', { entityId, language, sourceProvider }, signal)
})
// The overview may show the work's introduction while the concrete pressing
// remains unresolved. Its identity, facts and editing scope stay separate.
const projectView = createEntityMetadataView({
  catalog: (query, signal) => core.query('catalog.query', query, signal),
  sources: (query, signal) => core.query('catalog.sources', query, signal),
  detail: (entityId, language, sourceProvider, signal) =>
    core.query('metadata.entity.detail', { entityId, language, sourceProvider }, signal)
})
const stopProjectObserving = observeEntityMetadataView(projectView, {
  target: () =>
    props.target.kind === 'release' &&
    target.value.kind === 'release' &&
    props.target.context.type === 'collection'
      ? { ...props.target, kind: 'album_project' }
      : null,
  language: () => language.value,
  snapshot: () => core.state.value
})
const state = view.state
watch(
  () => [state.value.selected, state.value.loading] as const,
  ([selected, loading]) => {
    if (selected?.kind === 'release') albumEntityId.value = selected.id
    else if (target.value.kind === 'release' && !loading) albumEntityId.value = null
  }
)
watch(
  () => JSON.stringify(props.target.context),
  () => {
    albumEntityId.value = null
  },
  { flush: 'sync' }
)
const editorScope = computed(() =>
  JSON.stringify([target.value, language.value, core.state.value?.epoch])
)
watch(
  () => JSON.stringify(target.value),
  () => {
    suppressLegacyIntro.value = false
  }
)
watch(
  () => state.value.detail,
  (detail) => {
    if (detail)
      suppressLegacyIntro.value = !!(
        detail.introduction ||
        detail.override ||
        detail.imports?.some((item) => item.descriptionCleared)
      )
  }
)
const stopObserving = observeEntityMetadataView(view, {
  target: () => target.value,
  language: () => language.value,
  snapshot: () => core.state.value
})
watch(
  () => props.target.context,
  () => {
    layer.value = 'release'
    activeSection.value = 'overview'
    detailsOpen.value = false
  }
)
watch(
  () => state.value.selected?.id,
  () => {
    expanded.value = false
    exploreArtist.value = false
  }
)
onBeforeUnmount(() => {
  stopObserving()
  stopProjectObserving()
  view.dispose()
  projectView.dispose()
})
const projectIntroduction = computed(() =>
  !state.value.detail?.introduction &&
  !state.value.detail?.override &&
  !state.value.detail?.imports?.some((item) => item.descriptionCleared || item.description) &&
  !projectView.state.value.loading &&
  !projectView.state.value.detailLoading
    ? projectView.state.value.detail?.introduction
    : null
)
const intro = computed(() => state.value.detail?.introduction ?? projectIntroduction.value)
const importedIntroductionClear = computed(() =>
  state.value.detail?.imports?.some((item) => item.descriptionCleared)
)
const importedIntroductionConflict = computed(
  () =>
    importedIntroductionClear.value &&
    state.value.detail?.imports?.some((item) => item.disposition === 'conflict')
)
const emptyIntroduction = computed(() =>
  state.value.detail?.override?.mode === 'clear'
    ? '已隐藏介绍'
    : importedIntroductionConflict.value
      ? '历史手工介绍存在冲突，请核对后编辑介绍。'
      : importedIntroductionClear.value
        ? '已隐藏介绍'
        : state.value.detail?.link?.state === 'confirmed'
          ? '身份已确认，暂无介绍'
          : '尚未确认身份，暂无介绍'
)
const fallback = computed(() =>
  !state.value.loading &&
  !state.value.detailLoading &&
  !suppressLegacyIntro.value &&
  !intro.value &&
  !state.value.detail?.override &&
  !importedIntroductionClear.value &&
  props.target.context.type === 'native'
    ? props.fallbackIntro
    : ''
)
const conciseAlbumIntro = computed(() => {
  const summary = props.albumSummary
  if (
    !summary ||
    intro.value ||
    fallback.value ||
    state.value.detail?.override ||
    importedIntroductionClear.value
  )
    return ''
  const artist = summary.artist || '未知歌手'
  const release = formatReleaseDate(summary.releaseDate)
  const releaseClause = release && release !== '发行时间未知' ? `，发行于 ${release}` : ''
  const typeLabel = summary.typeText || '专辑'
  const trackClause =
    typeof summary.trackCount === 'number' && summary.trackCount > 0
      ? `共收录 ${summary.trackCount} 首曲目`
      : ''
  const durationClause = summary.durationText ? `，总时长 ${summary.durationText}` : ''
  const genreClause =
    summary.genres && summary.genres.length > 0
      ? `，流派涵盖 ${summary.genres.slice(0, 3).join(' / ')}`
      : ''
  return `《${summary.name}》由 ${artist} 演绎${releaseClause}。本${typeLabel}${trackClause}${durationClause}${genreClause}。`
})
const fieldLabels = {
  firstReleaseDate: '首次发行',
  releaseDate: '发行日期',
  primaryType: '类型',
  country: '地区',
  barcode: '条形码'
}
const facts = computed(
  () => state.value.detail?.facts.filter((fact) => fact.field in fieldLabels) ?? []
)
const hasPrimaryTypeFact = computed(() => facts.value.some((fact) => fact.field === 'primaryType'))
const visible = computed(
  () =>
    props.target.context.type === 'collection' ||
    !!props.albumSummary ||
    state.value.loading ||
    state.value.error ||
    state.value.page?.total ||
    fallback.value
)
const heading = computed(() =>
  target.value.kind === 'artist'
    ? '艺人资料'
    : target.value.kind === 'album_project'
      ? '专辑作品'
      : '发行资料'
)
const identityState = computed(() => {
  if (!state.value.detail) return ''
  if (state.value.detail.link?.state === 'detached') return '身份已解除'
  if (state.value.detail.link?.state === 'rejected') return '已拒绝此身份'
  const confirmed = state.value.detail.link?.state === 'confirmed'
  return target.value.kind === 'artist'
    ? confirmed
      ? '身份已确认'
      : '身份待确认'
    : target.value.kind === 'release'
      ? confirmed
        ? '发行身份已确认'
        : '具体发行待确认'
      : confirmed
        ? '项目身份已确认'
        : '专辑作品待确认'
})
const artistPreferenceEntityId = computed(() =>
  target.value.kind === 'artist' &&
  state.value.selected?.kind === 'artist' &&
  state.value.detail?.entityId === state.value.selected.id &&
  state.value.detail?.targetId &&
  state.value.detail?.link?.state === 'confirmed' &&
  !state.value.loading &&
  !state.value.detailLoading &&
  !state.value.error &&
  !state.value.detailError
    ? state.value.selected.id
    : null
)
</script>

<template>
  <section
    v-if="visible"
    class="entity-metadata"
    :class="{
      'is-roon-album-panel': props.target.kind === 'release',
      'album-metadata-overview': isAlbumOverview
    }"
    :aria-label="heading"
    :aria-busy="state.loading || state.detailLoading"
  >
    <template v-if="isAlbumOverview">
      <div
        :id="overviewId"
        ref="overviewBody"
        class="album-overview-body"
        :style="detailsOpen ? { minHeight: `${previewHeight}px` } : undefined"
      ></div>
      <nav class="album-overview-links" aria-label="专辑资料入口">
        <button type="button" class="album-details-trigger" @click="openDetails('overview')">
          专辑资料<i class="pi pi-arrow-up-right" aria-hidden="true"></i>
        </button>
        <button
          v-if="albumEntityId"
          type="button"
          class="album-sources-trigger"
          @click="openDetails('versions')"
        >
          发行与音源<i class="pi pi-angle-right" aria-hidden="true"></i>
        </button>
        <button v-else type="button" @click="openDetails('curation')">
          身份与整理<i class="pi pi-angle-right" aria-hidden="true"></i>
        </button>
      </nav>
      <Teleport to="body">
        <AlbumMetadataDialog
          v-if="detailsOpen"
          :title="albumSummary?.name || state.detail?.name || '专辑'"
          @close="closeDetails"
        >
          <div :id="detailsId"></div>
        </AlbumMetadataDialog>
      </Teleport>
    </template>
    <!-- Move the same view and editors into the dialog, retaining drafts and pending commands. -->
    <Teleport
      defer
      :disabled="!isAlbumOverview"
      :to="isAlbumOverview ? `#${detailsOpen ? detailsId : overviewId}` : null"
    >
      <div
        class="metadata-presentation"
        :data-section="activeSection"
        :class="{
          'is-album-preview': isAlbumPreview,
          'is-album-details': isAlbumOverview && detailsOpen
        }"
      >
        <nav
          v-if="!isAlbumPreview"
          class="metadata-section-tabs"
          role="tablist"
          aria-label="详情分区切换"
          @keydown="onTabsKeydown"
        >
          <button
            v-for="section in sections"
            :id="`${presentationId}-tab-${section.id}`"
            :key="section.id"
            type="button"
            role="tab"
            class="section-tab"
            :aria-selected="activeSection === section.id"
            :tabindex="activeSection === section.id ? 0 : -1"
            :aria-controls="`${presentationId}-panel`"
            @click="activeSection = section.id"
          >
            {{ section.label }}
          </button>
        </nav>
        <div
          :id="`${presentationId}-panel`"
          class="roon-overview-grid"
          :role="isAlbumPreview ? undefined : 'tabpanel'"
          :aria-labelledby="isAlbumPreview ? undefined : `${presentationId}-tab-${activeSection}`"
        >
          <div class="overview-left-column">
            <h3 v-if="isAlbumPreview" class="album-intro-heading">简介</h3>
            <div class="metadata-heading">
              <div class="metadata-title-cluster">
                <h3>{{ heading }}</h3>
                <span
                  v-if="identityState"
                  class="identity-badge"
                  :class="{ 'is-confirmed': state.detail?.link?.state === 'confirmed' }"
                >
                  {{ identityState }}
                </span>
              </div>

              <div
                v-if="target.kind !== 'artist'"
                class="metadata-layers"
                role="group"
                aria-label="资料层次"
              >
                <button
                  type="button"
                  :aria-pressed="layer === 'release'"
                  @click="layer = 'release'"
                >
                  具体发行
                </button>
                <button
                  type="button"
                  :aria-pressed="layer === 'album_project'"
                  @click="layer = 'album_project'"
                >
                  专辑作品
                </button>
              </div>

              <button
                v-if="props.target.kind !== 'release' || activeSection !== 'overview'"
                type="button"
                class="metadata-refresh"
                :disabled="state.loading || state.detailLoading"
                @click="view.refresh()"
              >
                重新读取
              </button>
            </div>

            <p v-if="state.loading && !state.page" role="status">正在读取曲库资料…</p>
            <p v-else-if="state.error" role="alert">
              资料读取失败：{{ state.error }}
              <button type="button" @click="view.refresh()">重试</button>
            </p>
            <template v-else>
              <template v-if="state.page && state.page.total > 1">
                <p class="metadata-hint">
                  此分组包含 {{ state.page.total }} 个独立条目，选择要查看的资料。
                </p>
                <ul class="metadata-choices" aria-label="选择资料条目">
                  <li v-for="entity in state.page.items" :key="entity.id">
                    <button
                      type="button"
                      :aria-pressed="state.selected?.id === entity.id"
                      @click="view.select(entity)"
                    >
                      <strong>{{ entity.title }}</strong>
                      <span
                        >{{ state.samples[entity.id] || entity.artist }} ·
                        {{ entity.sourceCount }} 个音源</span
                      >
                    </button>
                  </li>
                </ul>
                <nav class="metadata-pagination" aria-label="资料条目分页">
                  <button
                    type="button"
                    :disabled="state.page.offset === 0"
                    @click="
                      view.page(Math.max(0, state.page.offset - METADATA_REFERENCE_PAGE_SIZE))
                    "
                  >
                    上一页
                  </button>
                  <span
                    >{{ state.page.offset + 1 }}–{{
                      Math.min(state.page.total, state.page.offset + state.page.items.length)
                    }}
                    / {{ state.page.total }}</span
                  >
                  <button
                    type="button"
                    :disabled="state.page.offset + state.page.items.length >= state.page.total"
                    @click="view.page(state.page.offset + METADATA_REFERENCE_PAGE_SIZE)"
                  >
                    下一页
                  </button>
                </nav>
              </template>

              <div
                class="metadata-overview-pane"
                :class="{
                  'detail-pane-hidden': activeSection !== 'overview' && activeSection !== 'all'
                }"
              >
                <p v-if="state.detailLoading && !state.detail" role="status">正在读取所选条目…</p>
                <p v-else-if="state.detailError" role="alert">
                  {{ state.detailError }}
                  <button type="button" @click="view.refreshDetail()">重试</button>
                </p>
                <template v-else-if="state.detail">
                  <p v-if="state.detailNotice" class="metadata-hint" role="status">
                    {{ state.detailNotice }}
                  </p>
                  <p v-if="state.page && state.page.total > 1" class="metadata-selected">
                    {{ state.selected?.title }}
                  </p>
                  <div class="overview-content-grid">
                    <div
                      v-if="
                        props.showArtwork &&
                        ((state.detail.artwork && state.detail.artwork.length) ||
                          state.detail.manualArtwork ||
                          state.detail.artworkOverride?.mode === 'clear')
                      "
                      class="overview-artwork-col"
                    >
                      <EntityArtwork
                        v-for="artwork in state.detail.artwork ?? []"
                        :key="artwork.handle"
                        :artwork="artwork"
                        :name="state.detail.name"
                        :busy="state.loading || state.detailLoading"
                        @refresh="view.refreshDetail()"
                      />
                      <figure v-if="state.detail.manualArtwork" class="manual-artwork">
                        <img
                          :src="state.detail.manualArtwork.dataUrl"
                          :alt="`${state.detail.name} · 手工资料图片`"
                        />
                        <figcaption>手工资料图片</figcaption>
                      </figure>
                      <p
                        v-else-if="state.detail.artworkOverride?.mode === 'clear'"
                        class="metadata-hint"
                      >
                        已隐藏资料图片
                      </p>
                    </div>

                    <div class="overview-prose-col">
                      <p v-if="projectIntroduction" class="metadata-hint">
                        专辑作品简介
                        <button type="button" @click="layer = 'album_project'">查看作品资料</button>
                      </p>
                      <p
                        v-if="intro"
                        class="metadata-introduction"
                        :class="{ collapsed: !expanded && intro.value.length > 280 }"
                        :lang="intro.language"
                      >
                        {{ intro.value }}
                      </p>
                      <div
                        v-if="intro && !isAlbumPreview && intro.value.length > 280"
                        class="expand-chevron-row"
                      >
                        <button
                          type="button"
                          class="expand-chevron-btn"
                          :aria-expanded="!isAlbumPreview && expanded"
                          @click="expandIntroduction"
                        >
                          {{ !isAlbumPreview && expanded ? '收起' : '展开全文' }}
                        </button>
                      </div>
                      <p v-if="intro" class="metadata-attribution">
                        <MetadataAttribution
                          v-if="intro.attribution"
                          :attribution="intro.attribution"
                        />
                        <span v-else>{{
                          intro.origin === 'manual' ? '手动填写' : '历史导入资料'
                        }}</span>
                        <span v-if="!isAlbumPreview"> · {{ intro.language }}</span>
                        <button
                          v-if="isAlbumPreview"
                          type="button"
                          class="album-intro-more"
                          @click="expandIntroduction"
                        >
                          展开全文
                        </button>
                      </p>
                      <template v-else-if="!fallback">
                        <p
                          v-if="conciseAlbumIntro"
                          class="metadata-introduction concise-album-summary"
                        >
                          {{ conciseAlbumIntro }}
                        </p>
                        <p class="metadata-hint">
                          {{ isAlbumPreview ? '暂无专辑简介' : emptyIntroduction }}
                        </p>
                      </template>
                    </div>
                  </div>
                </template>
                <template v-else-if="!state.page?.total && !fallback">
                  <p v-if="conciseAlbumIntro" class="metadata-introduction concise-album-summary">
                    {{ conciseAlbumIntro }}
                  </p>
                  <p class="metadata-hint">
                    {{ isAlbumPreview ? '暂无专辑简介' : '曲库尚无此条目的资料引用。' }}
                  </p>
                </template>

                <template v-if="fallback">
                  <p
                    class="metadata-introduction"
                    :class="{ collapsed: !expanded && fallback.length > 280 }"
                  >
                    {{ fallback }}
                  </p>
                  <div v-if="!isAlbumPreview && fallback.length > 280" class="expand-chevron-row">
                    <button
                      type="button"
                      class="expand-chevron-btn"
                      :aria-expanded="!isAlbumPreview && expanded"
                      @click="expandIntroduction"
                    >
                      {{ !isAlbumPreview && expanded ? '收起' : '展开全文' }}
                    </button>
                  </div>
                  <p class="metadata-attribution">
                    平台页面介绍
                    <button
                      v-if="isAlbumPreview"
                      type="button"
                      class="album-intro-more"
                      @click="expandIntroduction"
                    >
                      展开全文
                    </button>
                  </p>
                </template>

                <IntroductionEditor
                  :scope="editorScope"
                  :selected="state.selected?.id ?? null"
                  :detail="state.detail"
                  :available="
                    !state.loading && !state.detailLoading && !state.error && !state.detailError
                  "
                  :language="language"
                  :refresh="view.refreshDetail"
                />

                <PersonalPreferencesPanel
                  v-if="artistPreferenceEntityId"
                  :entity-id="artistPreferenceEntityId"
                  :scope="editorScope"
                  label="艺人"
                />

                <template
                  v-if="
                    artistPreferenceEntityId && validMusicBrainzArtistId(state.detail?.link?.mbid)
                  "
                >
                  <div class="artist-explore-trigger">
                    <button
                      type="button"
                      class="explore-toggle-btn"
                      :aria-expanded="exploreArtist"
                      @click="exploreArtist = !exploreArtist"
                    >
                      {{ exploreArtist ? '收起参与内容' : '探索这位人物的参与内容' }}
                    </button>
                  </div>
                  <MusicExplorationPanel
                    v-if="exploreArtist"
                    :reference="{
                      provider: 'musicbrainz',
                      kind: 'artist',
                      idType: 'mbid',
                      value: state.detail!.link!.mbid.toLowerCase()
                    }"
                    :scope="editorScope"
                  />
                </template>
              </div>
            </template>

            <div
              class="metadata-curation-pane"
              :class="{
                'detail-pane-hidden': activeSection !== 'curation' && activeSection !== 'all'
              }"
            >
              <MetadataUpdateControls
                v-if="
                  target.sourceProvider === 'local' &&
                  state.detail?.link?.state === 'confirmed' &&
                  state.selected
                "
                :key="state.selected.id + ':' + target.kind"
                :entity-id="state.selected.id"
                :kind="target.kind"
                :language="language"
                :scope="editorScope"
              />
              <PersonalMetadataEditor
                :scope="editorScope"
                :selected="state.selected?.id ?? null"
                :detail="state.detail"
                :available="
                  !state.loading && !state.detailLoading && !state.error && !state.detailError
                "
                :language="language"
                :refresh="view.refreshDetail"
              />
              <IdentityReviewPanel
                :entity-id="state.selected?.id ?? null"
                :scope="editorScope"
                @changed="view.refreshDetail()"
              />
            </div>
          </div>

          <aside
            v-if="props.target.kind === 'release' || facts.length > 0"
            class="overview-specs-col"
            aria-label="发行规格与个人交互"
          >
            <p v-if="isAlbumPreview && !albumEntityId" class="album-rating-unavailable">
              评分 · 暂无可评分的具体发行
            </p>
            <dl
              v-if="
                (albumSummary || facts.length > 0) &&
                (activeSection === 'overview' || activeSection === 'all')
              "
              class="metadata-facts roon-specs-table"
            >
              <div v-if="albumSummary?.durationText || albumSummary?.trackCount" class="fact-card">
                <dt>时长</dt>
                <dd>
                  {{ albumSummary?.durationText || `${albumSummary?.trackCount ?? 0} 首` }}
                  <span v-if="albumSummary?.durationText && albumSummary?.trackCount">
                    · {{ albumSummary.trackCount }} 首
                  </span>
                </dd>
              </div>
              <div v-if="albumSummary?.typeText && !hasPrimaryTypeFact" class="fact-card">
                <dt>类型</dt>
                <dd>{{ albumSummary.typeText }}</dd>
              </div>
              <div v-if="albumSummary?.formatText" class="fact-card">
                <dt>格式</dt>
                <dd class="spec-format-value">
                  <span class="format-spark" aria-hidden="true">✦</span
                  >{{ albumSummary.formatText }}
                </dd>
              </div>
              <div v-for="(fact, index) in facts" :key="index" class="fact-card">
                <dt>{{ fieldLabels[fact.field as keyof typeof fieldLabels] }}</dt>
                <dd>{{ fact.value }} <MetadataAttribution :attribution="fact.attribution" /></dd>
              </div>
            </dl>

            <div
              v-if="props.target.kind === 'release' && albumEntityId"
              :class="{
                'detail-pane-hidden': activeSection === 'curation'
              }"
            >
              <AlbumVersionsPanel :entity-id="albumEntityId" :active-section="activeSection" />
            </div>
          </aside>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.entity-metadata {
  margin: 0 0 18px;
  padding: 20px 32px 0;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--te-neutral-500) 14%, transparent);
  background: color-mix(in srgb, var(--te-card-bg, transparent) 45%, transparent);
  font-size: var(--te-font-size-body, 14px);
  color: var(--te-neutral-700);
}
.entity-metadata.is-roon-album-panel {
  border-inline: 0;
  border-top: 1px solid color-mix(in srgb, var(--te-neutral-500) 14%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--te-neutral-500) 16%, transparent);
  border-radius: 0;
  background: transparent;
}
.metadata-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 12px;
}
.metadata-title-cluster {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.identity-badge {
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--te-neutral-600, var(--te-neutral-500));
  background: color-mix(in srgb, var(--te-neutral-500) 12%, transparent);
}
.identity-badge.is-confirmed {
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  font-weight: 500;
}
.roon-overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr);
  gap: 36px;
  align-items: start;
}
.entity-metadata:not(.is-roon-album-panel) .roon-overview-grid {
  grid-template-columns: minmax(0, 1fr);
}
.overview-left-column,
.overview-specs-col {
  min-width: 0;
}
.entity-metadata.is-roon-album-panel .overview-specs-col {
  padding-left: 28px;
  border-left: 1px solid color-mix(in srgb, var(--te-neutral-500) 14%, transparent);
}
.metadata-section-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 28px;
  margin-top: 18px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--te-neutral-500) 12%, transparent);
}
.section-tab {
  position: relative;
  padding: 8px 4px 10px;
  border-radius: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--te-neutral-500);
}
.section-tab[aria-selected='true'] {
  color: var(--te-neutral-900);
  font-weight: 700;
}
.section-tab[aria-selected='true']::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2.5px;
  border-radius: 999px;
  background: var(--te-primary-500);
}
.detail-pane-hidden {
  display: none;
}
.overview-content-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: flex-start;
}
.overview-artwork-col {
  flex: 0 0 auto;
}
.overview-prose-col {
  flex: 1 1 320px;
  min-width: 0;
}
.manual-artwork {
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.manual-artwork img {
  width: 144px;
  max-height: 180px;
  object-fit: contain;
  border-radius: 8px;
}
h3 {
  margin: 0;
  font-size: 0.98em;
  font-weight: 650;
  color: var(--te-neutral-900);
}
button,
a {
  font: inherit;
  color: var(--te-primary-600);
}
button {
  border: 0;
  padding: 5px 10px;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
button:not(:disabled):hover {
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
}
.metadata-refresh {
  margin-left: auto;
  font-size: 12.5px;
}
.metadata-layers {
  display: inline-flex;
  gap: 3px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--te-neutral-500) 18%, transparent);
}
.metadata-layers button {
  padding: 3px 9px;
  font-size: 12px;
}
button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  font-weight: 600;
}
.metadata-hint,
.metadata-attribution {
  color: var(--te-neutral-500);
  line-height: 1.6;
  font-size: 12.5px;
}
.metadata-choices {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  padding: 0;
  gap: 8px;
  margin: 10px 0;
}
.metadata-choices button {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  height: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--te-neutral-500) 18%, transparent);
  border-radius: 8px;
  color: var(--te-neutral-900);
}
.metadata-choices span {
  color: var(--te-neutral-600);
  font-size: 12.5px;
  line-height: 1.45;
}
.metadata-choices strong,
.metadata-choices span {
  overflow-wrap: anywhere;
}
.metadata-pagination {
  display: flex;
  align-items: center;
  gap: 12px;
}
.metadata-selected {
  font-weight: 600;
  color: var(--te-neutral-900);
}
.metadata-introduction {
  white-space: pre-line;
  line-height: 1.85;
  overflow-wrap: anywhere;
  margin: 0 0 8px;
  color: var(--te-neutral-800, var(--te-neutral-900));
}
.collapsed {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
  overflow: hidden;
}
.expand-chevron-row {
  display: flex;
  justify-content: center;
  margin: 4px 0 8px;
}
.expand-chevron-btn {
  font-size: 12.5px;
  font-weight: 600;
  padding: 3px 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--te-neutral-500) 8%, transparent);
}
.metadata-attribution {
  font-size: 12.5px;
  overflow-wrap: anywhere;
  margin: 4px 0 10px;
}
.roon-specs-table {
  display: grid;
  gap: 10px;
  margin: 0 0 10px;
}
.fact-card {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  min-height: 26px;
  gap: 12px;
  font-size: 13px;
}
.fact-card dt {
  color: var(--te-neutral-500);
  font-size: 12.5px;
  font-weight: 500;
}
.fact-card dd {
  margin: 0;
  font-weight: 600;
  color: var(--te-neutral-900);
  overflow-wrap: anywhere;
}
.fact-card dd span {
  color: var(--te-neutral-500);
  font-weight: 500;
  margin-left: 4px;
}
.spec-format-value {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.format-spark {
  color: var(--te-primary-500) !important;
  margin-left: 0 !important;
}
.artist-explore-trigger {
  margin-top: 12px;
}
.explore-toggle-btn {
  border: 1px solid color-mix(in srgb, var(--te-primary-500) 35%, var(--te-card-border));
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
  padding: 6px 12px;
  border-radius: 8px;
  font-weight: 500;
}
@media (max-width: 900px) {
  .entity-metadata {
    padding-inline: 16px;
  }
  .roon-overview-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
  .entity-metadata.is-roon-album-panel .overview-specs-col {
    padding-left: 0;
    padding-top: 16px;
    border-left: 0;
    border-top: 1px solid color-mix(in srgb, var(--te-neutral-500) 14%, transparent);
  }
}
@media (max-width: 640px) {
  .entity-metadata {
    padding-inline: 8px;
  }
  .metadata-choices {
    grid-template-columns: minmax(0, 1fr);
  }
  .metadata-section-tabs {
    gap: 12px;
  }
}

/* The album summary and details dialog share one metadata/editor tree. */
.metadata-presentation {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.metadata-section-tabs {
  order: 1;
}
.entity-metadata.album-metadata-overview {
  margin: 0 0 22px;
  padding: 0 0 16px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--te-neutral-500) 16%, transparent);
  border-radius: 0;
  background: transparent;
}
.album-overview-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin-top: 12px;
}
.album-overview-links button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 0;
  border-radius: 2px;
  font-size: 12px;
  color: var(--te-neutral-600);
}
.album-overview-links button:hover {
  color: var(--te-primary-600);
  background: transparent;
}
.album-overview-links i {
  font-size: 11px;
  color: var(--te-neutral-500);
}
.is-album-preview .roon-overview-grid {
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 36px;
}
.is-album-preview .metadata-heading,
.is-album-preview .introduction-editor,
.is-album-preview .metadata-facts,
.is-album-preview .concise-album-summary {
  display: none;
}
.is-album-preview .overview-prose-col {
  flex-basis: 0;
}
.is-album-preview .album-intro-heading {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
.is-album-preview .metadata-introduction {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  font-size: var(--te-font-size-body, 14px);
  line-height: 1.75;
  color: var(--te-neutral-700);
}
.is-album-preview .metadata-attribution {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  font-size: 12px;
  margin: 8px 0 0;
}
.is-album-preview .album-intro-more {
  padding: 0;
  font-size: 12px;
  color: var(--te-neutral-600);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.is-album-preview .album-intro-more:hover {
  background: transparent;
  color: var(--te-primary-600);
}
.entity-metadata.album-metadata-overview .is-album-preview .overview-specs-col {
  padding: 0 0 0 28px;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--te-neutral-500) 12%, transparent);
}
.is-album-preview .metadata-choices {
  grid-template-columns: minmax(0, 1fr);
}
.album-rating-unavailable {
  margin: 0;
  color: var(--te-neutral-500);
  font-size: 12.5px;
}
.is-album-details {
  padding: 0 32px 32px;
  font-size: var(--te-font-size-body, 14px);
  color: var(--te-neutral-700);
}
.is-album-details .metadata-section-tabs {
  order: 0;
  position: sticky;
  top: 0;
  z-index: 3;
  justify-content: flex-start;
  gap: 26px;
  margin: 0 0 24px;
  padding-top: 4px;
  border-top: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--te-neutral-500) 16%, transparent);
  background: var(--te-card-bg);
}
.is-album-details .roon-overview-grid {
  grid-template-columns: minmax(0, 1.45fr) minmax(250px, 1fr);
  gap: 28px;
}
.is-album-details[data-section='versions'] .roon-overview-grid,
.is-album-details[data-section='curation'] .roon-overview-grid {
  grid-template-columns: minmax(0, 1fr);
}
.is-album-details[data-section='curation'] .overview-specs-col {
  display: none;
}
@container te-song-list (max-width: 800px) {
  .is-album-preview .roon-overview-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }
  .entity-metadata.album-metadata-overview .is-album-preview .overview-specs-col {
    padding: 0;
    border: 0;
  }
}
@media (max-width: 760px) {
  .is-album-details .roon-overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 640px) {
  .is-album-details {
    padding: 0 20px 24px;
  }
  .is-album-details .metadata-section-tabs {
    gap: 18px;
  }
  .is-album-details .section-tab {
    font-size: 12px;
    letter-spacing: 0;
  }
}
</style>
