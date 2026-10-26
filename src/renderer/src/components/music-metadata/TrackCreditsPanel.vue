<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { MusicExplorationReference } from '../../../../shared/musicExploration.ts'
import type { Track } from '../../types/music.ts'
import { getTrackSource } from '../../../../shared/trackSourceIdentity.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useSettingsStore } from '../../stores/useSettingsStore.ts'
import { useLocale } from '../../app/useLocale.ts'
import {
  createEntityMetadataView,
  observeEntityMetadataView,
  METADATA_REFERENCE_PAGE_SIZE,
  type EntityMetadataContext
} from './entityMetadataView.ts'
import {
  createMusicCreditsView,
  MUSIC_CREDITS_PAGE_SIZE,
  creditRoleLabel,
  creditTargetLabel,
  musicBrainzReferenceUrl
} from './musicCreditsView.ts'
import MetadataAttribution from './MetadataAttribution.vue'
import IdentityReviewPanel from './IdentityReviewPanel.vue'
import type { MusicCreditTarget } from '../../../../shared/musicCredits.ts'

const props = defineProps<{ track: Track }>()
const MusicExplorationPanel = defineAsyncComponent(() => import('../music-exploration/MusicExplorationPanel.vue'))
const exploration = shallowRef<MusicExplorationReference | null>(null)
watch(() => props.track, () => { exploration.value = null })
const core = useCoreConnection(),
  settings = useSettingsStore(),
  { locale } = useLocale()
const target = computed<EntityMetadataContext>(() => {
  const provider = getTrackSource(props.track)
  return {
    context: { type: 'track', provider, id: props.track.id },
    kind: 'recording',
    sourceProvider: provider
  }
})
const language = computed(
  () =>
    settings.settings.value.musicIdentification.language ??
    (locale.value === 'en-US' ? 'en' : 'zh-Hans')
)
const references = createEntityMetadataView({
  catalog: (query, signal) => core.query('catalog.query', query, signal),
  sources: (query, signal) => core.query('catalog.sources', query, signal),
  detail: (entityId, language, sourceProvider, signal) =>
    core.query('metadata.entity.detail', { entityId, language, sourceProvider }, signal)
})
const credits = createMusicCreditsView((query, signal) =>
  core.query('metadata.entity.credits', query, signal)
)
const state = references.state,
  rows = credits.state
const stopCredits = watch(
  () => state.value.detail,
  (detail) => void credits.setDetail(detail),
  { immediate: true, flush: 'sync' }
)
const stopObserving = observeEntityMetadataView(references, {
  target: () => target.value,
  language: () => language.value,
  snapshot: () => core.state.value
})
onBeforeUnmount(() => {
  stopObserving()
  stopCredits()
  references.dispose()
  credits.dispose()
})
const busy = computed(() => state.value.loading || state.value.detailLoading || rows.value.loading)
const identityScope = computed(() => JSON.stringify([target.value, core.state.value?.epoch]))
function open(ref: MusicCreditTarget) {
  const url = musicBrainzReferenceUrl(ref)
  if (url) void window.api.shell.openExternal(url)
}
</script>

<template>
  <section class="track-credits" aria-label="歌曲参与人员" :aria-busy="busy">
    <header>
      <h3>参与人员</h3>
      <button type="button" :disabled="busy" @click="references.refresh()">重新读取</button>
    </header>
    <p v-if="state.loading || state.detailLoading" role="status">正在读取录音资料…</p>
    <p v-else-if="state.error || state.detailError" role="alert">
      {{ state.error || state.detailError }}
      <button type="button" @click="references.refresh()">重试</button>
    </p>
    <template v-else>
      <template v-if="state.page && state.page.total > 1">
        <p>此歌曲关联 {{ state.page.total }} 个录音条目，请先选择。</p>
        <ul class="credit-choices" aria-label="选择录音条目">
          <li v-for="entity in state.page.items" :key="entity.id">
            <button
              type="button"
              :aria-pressed="state.selected?.id === entity.id"
              @click="references.select(entity)"
            >
              <strong>{{ entity.title }}</strong>
              <span>{{ state.samples[entity.id] || entity.artist }}</span>
            </button>
          </li>
        </ul>
        <nav aria-label="录音条目分页">
          <button
            type="button"
            :disabled="state.page.offset === 0"
            @click="references.page(Math.max(0, state.page.offset - METADATA_REFERENCE_PAGE_SIZE))"
          >
            上一组
          </button>
          <span
            >{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} /
            {{ state.page.total }}</span
          >
          <button
            type="button"
            :disabled="state.page.offset + state.page.items.length >= state.page.total"
            @click="references.page(state.page.offset + METADATA_REFERENCE_PAGE_SIZE)"
          >
            下一组
          </button>
        </nav>
      </template>
      <p v-if="!state.page?.total" class="credit-hint">曲库暂无此歌曲的录音资料引用。</p>
      <template v-else-if="state.detail">
        <p v-if="state.detail.link?.state !== 'confirmed'" class="credit-hint">
          尚未确认录音身份，暂不展示外部人员名单。
        </p>
        <p v-else-if="rows.loading" role="status">正在读取参与人员…</p>
        <p v-else-if="rows.error" role="alert">
          {{ rows.error }}
          <button type="button" @click="references.refreshDetail()">重新读取录音资料</button>
        </p>
        <template v-else-if="rows.page">
          <p class="credit-hint">按已确认录音读取；作品级关系单独标明。</p>
          <p v-if="rows.page.truncated" role="status">来源名单不完整，以下为已取得的人员信息。</p>
          <p v-if="!rows.page.total" class="credit-hint">录音身份已确认，暂无已保存的人员信息。</p>
          <ol
            v-else
            class="credit-list"
            :start="rows.page.offset + 1"
            aria-label="已保存的参与人员"
          >
            <li v-for="(credit, index) in rows.page.items" :key="`${rows.page.revision}:${index}`">
              <div class="credit-person">
                <button type="button" @click="exploration = credit.personRef">{{ credit.name }}</button>
                <a
                  v-if="musicBrainzReferenceUrl(credit.personRef)"
                  :href="musicBrainzReferenceUrl(credit.personRef)!"
                  @click.prevent="open(credit.personRef)"
                  >来源</a
                >
                <span>{{ creditRoleLabel(credit) }}</span>
              </div>
              <p class="credit-detail">
                <button v-if="credit.targetRef.kind === 'work'" type="button" @click="exploration = credit.targetRef">探索作品</button>
                <a
                  v-if="musicBrainzReferenceUrl(credit.targetRef)"
                  :href="musicBrainzReferenceUrl(credit.targetRef)!"
                  @click.prevent="open(credit.targetRef)"
                  >{{ creditTargetLabel(credit.targetRef.kind) }}级关系</a
                >
                <span v-else
                  >{{ creditTargetLabel(credit.targetRef.kind) }}级关系 ·
                  {{ credit.targetRef.value }}</span
                >
                <span v-if="credit.rawRole"> · {{ credit.rawRole }}</span>
                <span v-if="credit.direction">
                  · {{ credit.direction === 'forward' ? '正向关系' : '反向关系' }}</span
                >
                <span v-for="(attribute, i) in credit.attributes" :key="i">
                  · {{ attribute.name }}{{ attribute.value ? `：${attribute.value}` : '' }}
                </span>
                <span v-if="credit.begin || credit.end">
                  · {{ credit.begin || '起始未知' }} — {{ credit.end || '结束未知' }}</span
                >
                <span v-if="credit.joinphrase" class="credit-join">
                  · 署名连接符：“{{ credit.joinphrase }}”</span
                >
              </p>
              <MetadataAttribution :attribution="credit.attribution" />
            </li>
          </ol>
          <nav v-if="rows.page.total > MUSIC_CREDITS_PAGE_SIZE" aria-label="参与人员分页">
            <button
              type="button"
              :disabled="rows.page.offset === 0"
              @click="credits.page(Math.max(0, rows.page.offset - MUSIC_CREDITS_PAGE_SIZE))"
            >
              上一页
            </button>
            <span
              >{{ rows.page.offset + 1 }}–{{ rows.page.offset + rows.page.items.length }} /
              {{ rows.page.total }}</span
            >
            <button
              type="button"
              :disabled="rows.page.offset + rows.page.items.length >= rows.page.total"
              @click="credits.page(rows.page.offset + MUSIC_CREDITS_PAGE_SIZE)"
            >
              下一页
            </button>
          </nav>
        </template>
      </template>
    </template>
    <IdentityReviewPanel :entity-id="state.selected?.id ?? null" :scope="identityScope" @changed="references.refreshDetail()" />
    <section v-if="exploration" aria-label="参与人物与作品探索">
      <button type="button" @click="exploration = null">收起探索</button>
      <MusicExplorationPanel :reference="exploration" :scope="identityScope" />
    </section>
  </section>
</template>

<style scoped>
.track-credits {
  border-top: 1px solid var(--te-card-border);
  margin-top: 20px;
  padding-top: 16px;
  font-size: var(--te-font-size-body, 14px);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
header,
nav,
.credit-person {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
header {
  justify-content: space-between;
}
h3 {
  margin: 0;
  font-size: 1.1em;
}
p {
  margin: 8px 0;
}
button,
a {
  color: var(--te-primary-600);
  font: inherit;
}
button {
  border: 0;
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:not(:disabled):hover,
button[aria-pressed='true'] {
  background: var(--te-hover-bg);
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.credit-hint,
.credit-detail {
  color: var(--te-neutral-500);
}
.credit-list {
  margin: 12px 0;
  padding: 0;
  list-style: none;
}
.credit-list > li {
  margin: 0 0 16px;
}
.credit-person > a,
.credit-person > strong {
  font-weight: 600;
  color: var(--te-neutral-900);
}
.credit-choices {
  list-style: none;
  padding: 0;
}
.credit-choices button {
  width: 100%;
  text-align: left;
}
.credit-choices strong,
.credit-choices span {
  display: block;
}
.credit-join {
  white-space: pre-wrap;
}
</style>
