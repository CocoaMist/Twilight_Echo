<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
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

const props = defineProps<{ target: EntityMetadataContext; fallbackIntro?: string }>()
const core = useCoreConnection(),
  settings = useSettingsStore(),
  { locale } = useLocale()
const layer = ref<'release' | 'album_project'>('release')
const expanded = ref(false)
const exploreArtist = ref(false)
const MusicExplorationPanel = defineAsyncComponent(() => import('../music-exploration/MusicExplorationPanel.vue'))
const albumEntityId = ref<string | null>(null)
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
    if (detail) suppressLegacyIntro.value = !!(detail.introduction || detail.override ||
      detail.imports?.some(item => item.descriptionCleared))
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
  view.dispose()
})
const intro = computed(() => state.value.detail?.introduction)
const importedIntroductionClear = computed(() => state.value.detail?.imports?.some(item => item.descriptionCleared))
const importedIntroductionConflict = computed(() => importedIntroductionClear.value && state.value.detail?.imports?.some(item => item.disposition === 'conflict'))
const emptyIntroduction = computed(() => state.value.detail?.override?.mode === 'clear' ? '已隐藏介绍' :
  importedIntroductionConflict.value ? '历史手工介绍存在冲突，请核对后编辑介绍。' :
    importedIntroductionClear.value ? '已隐藏介绍' : state.value.detail?.link?.state === 'confirmed' ? '身份已确认，暂无介绍' : '尚未确认身份，暂无介绍')
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
const visible = computed(
  () =>
    props.target.context.type === 'collection' ||
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
    :aria-label="heading"
    :aria-busy="state.loading || state.detailLoading"
  >
    <div class="metadata-heading">
      <h3>{{ heading }}</h3>
      <span v-if="identityState" class="metadata-hint">{{ identityState }}</span>
      <div
        v-if="target.kind !== 'artist'"
        class="metadata-layers"
        role="group"
        aria-label="资料层次"
      >
        <button type="button" :aria-pressed="layer === 'release'" @click="layer = 'release'">
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
        type="button"
        class="metadata-refresh"
        :disabled="state.loading || state.detailLoading"
        @click="view.refresh()"
      >
        重新读取
      </button>
    </div>
    <p v-if="state.loading" role="status">正在读取曲库资料…</p>
    <p v-else-if="state.error" role="alert">
      资料读取失败：{{ state.error }} <button type="button" @click="view.refresh()">重试</button>
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
            @click="view.page(Math.max(0, state.page.offset - METADATA_REFERENCE_PAGE_SIZE))"
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
      <p v-if="state.detailLoading" role="status">正在读取所选条目…</p>
      <p v-else-if="state.detailError" role="alert">
        {{ state.detailError }} <button type="button" @click="view.refreshDetail()">重试</button>
      </p>
      <template v-else-if="state.detail">
        <p v-if="state.detailNotice" class="metadata-hint" role="status">{{ state.detailNotice }}</p>
        <p v-if="state.page && state.page.total > 1" class="metadata-selected">
          {{ state.selected?.title }}
        </p>
        <EntityArtwork
          v-for="artwork in state.detail.artwork ?? []"
          :key="artwork.handle"
          :artwork="artwork"
          :name="state.detail.name"
          :busy="state.loading || state.detailLoading"
          @refresh="view.refreshDetail()"
        />
        <figure v-if="state.detail.manualArtwork" class="manual-artwork">
          <img :src="state.detail.manualArtwork.dataUrl" :alt="`${state.detail.name} · 手工资料图片`" />
          <figcaption>手工资料图片</figcaption>
        </figure>
        <p v-else-if="state.detail.artworkOverride?.mode === 'clear'" class="metadata-hint">已隐藏资料图片</p>
        <p
          v-if="intro"
          class="metadata-introduction"
          :class="{ collapsed: !expanded && intro.value.length > 280 }"
          :lang="intro.language"
        >
          {{ intro.value }}
        </p>
        <button
          v-if="intro && intro.value.length > 280"
          type="button"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : '展开全文' }}
        </button>
        <p v-if="intro" class="metadata-attribution">
          <MetadataAttribution v-if="intro.attribution" :attribution="intro.attribution" />
          <span v-else>{{ intro.origin === 'manual' ? '手动填写' : '历史导入资料' }}</span>
          <span> · {{ intro.language }}</span>
        </p>
        <p v-else-if="!fallback" class="metadata-hint">
          {{ emptyIntroduction }}
        </p>
        <dl v-if="facts.length" class="metadata-facts">
          <div v-for="(fact, index) in facts" :key="index">
            <dt>{{ fieldLabels[fact.field as keyof typeof fieldLabels] }}</dt>
            <dd>{{ fact.value }} <MetadataAttribution :attribution="fact.attribution" /></dd>
          </div>
        </dl>
      </template>
      <p v-else-if="!state.page?.total && !fallback" class="metadata-hint">
        曲库尚无此条目的资料引用。
      </p>
    </template>
    <template v-if="fallback">
      <p class="metadata-introduction" :class="{ collapsed: !expanded && fallback.length > 280 }">
        {{ fallback }}
      </p>
      <button
        v-if="fallback.length > 280"
        type="button"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全文' }}
      </button>
      <p class="metadata-attribution">平台页面介绍</p>
    </template>
    <IntroductionEditor
      :scope="editorScope"
      :selected="state.selected?.id ?? null"
      :detail="state.detail"
      :available="!state.loading && !state.detailLoading && !state.error && !state.detailError"
      :language="language"
      :refresh="view.refreshDetail"
    />
    <PersonalMetadataEditor
      :scope="editorScope"
      :selected="state.selected?.id ?? null"
      :detail="state.detail"
      :available="!state.loading && !state.detailLoading && !state.error && !state.detailError"
      :language="language"
      :refresh="view.refreshDetail"
    />
    <PersonalPreferencesPanel
      v-if="artistPreferenceEntityId"
      :entity-id="artistPreferenceEntityId"
      :scope="editorScope"
      label="艺人"
    />
    <template v-if="artistPreferenceEntityId && validMusicBrainzArtistId(state.detail?.link?.mbid)">
      <button type="button" :aria-expanded="exploreArtist" @click="exploreArtist = !exploreArtist">
        {{ exploreArtist ? '收起参与内容' : '探索这位人物的参与内容' }}
      </button>
      <MusicExplorationPanel
        v-if="exploreArtist"
        :reference="{ provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: state.detail!.link!.mbid.toLowerCase() }"
        :scope="editorScope"
      />
    </template>
    <IdentityReviewPanel
      :entity-id="state.selected?.id ?? null"
      :scope="editorScope"
      @changed="view.refreshDetail()"
    />
  </section>
  <AlbumVersionsPanel
    v-if="props.target.kind === 'release' && albumEntityId"
    :entity-id="albumEntityId"
  />
</template>

<style scoped>
.entity-metadata {
  margin: 0 0 28px;
  padding: 20px 0;
  border-block: 1px solid color-mix(in srgb, var(--te-neutral-500) 16%, transparent);
  font-size: var(--te-font-size-body, 14px);
  color: var(--te-neutral-700);
}
.metadata-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.manual-artwork { margin: 16px 0; display: flex; align-items: flex-start; gap: 16px; }
.manual-artwork img { width: 144px; max-height: 180px; object-fit: contain; border-radius: 8px; }
h3 {
  margin: 0;
  font-size: 1.1em;
  color: var(--te-neutral-900);
}
button,
a {
  font: inherit;
  color: var(--te-primary-600);
}
button {
  border: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
button:not(:disabled):hover {
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
}
.metadata-refresh {
  margin-left: auto;
}
.metadata-layers {
  display: flex;
  gap: 4px;
}
button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
}
.metadata-hint,
.metadata-attribution {
  color: var(--te-neutral-500);
  line-height: 1.6;
}
.metadata-choices {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  padding: 0;
  gap: 8px;
}
.metadata-choices button {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  text-align: left;
  padding: 12px;
  color: var(--te-neutral-900);
}
.metadata-choices span {
  color: var(--te-neutral-600);
  line-height: 1.5;
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
  margin: 12px 0;
}
.collapsed {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 8;
  overflow: hidden;
}
.metadata-attribution {
  font-size: 1em;
  overflow-wrap: anywhere;
}
.metadata-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 32px;
  margin: 16px 0 0;
}
.metadata-facts dt {
  color: var(--te-neutral-500);
  margin-bottom: 5px;
}
.metadata-facts dd {
  margin: 0;
  color: var(--te-neutral-900);
}
.metadata-facts dd span {
  color: var(--te-neutral-500);
  margin-left: 6px;
}
@media (max-width: 640px) {
  .metadata-choices {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
