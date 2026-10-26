<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createIdentityInboxView, IDENTITY_INBOX_PAGE_SIZE } from './identityInboxView.ts'
import { identityKindLabel, type IdentityCandidateState } from './identityReviewView.ts'
import type { CatalogKind } from '../../../../shared/musicCatalog.ts'
import IdentityReviewPanel from './IdentityReviewPanel.vue'
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const core = useCoreConnection()
const view = createIdentityInboxView(
  (query, signal) => core.query('identification.inbox', query, signal),
  { unresolvedOnly: props.compact }
)
const state = view.state
const scope = computed(() => JSON.stringify(['identity-inbox', core.state.value?.epoch]))
watch(
  [
    () => core.state.value?.epoch,
    () => core.state.value?.catalogRevision,
    () => core.state.value?.libraryRevision,
    () => core.state.value?.entityMetadataRevision
  ],
  (value, previous) => {
    void view.refresh(!previous || value.slice(0, 3).some((v, i) => v !== previous[i]))
  },
  { immediate: true }
)
onBeforeUnmount(view.dispose)
</script>
<template>
  <div class="identity-inbox" :class="{ compact }" aria-label="音乐资料复核">
    <template v-if="props.compact">
      <p v-if="state.loading && !state.page" role="status" class="status-note">
        正在读取待确认条目…
      </p>
      <div v-if="state.error" role="alert" class="alert-note">
        {{ state.error }}
        <button type="button" :disabled="state.loading" @click="view.refresh()">重新读取</button>
      </div>
      <div v-else-if="state.page && !state.page.total" class="compact-empty">
        <i class="pi pi-check" aria-hidden="true" />
        <h3>暂时没有需要你决定的事</h3>
        <p>没有头像或简介，不影响听歌。</p>
      </div>
      <p v-if="state.page?.total" class="status-note">{{ state.page.total }} 个条目待确认</p>
      <ul class="compact-entities" aria-label="需要确认的资料条目">
        <li v-for="item in state.page?.items ?? []" :key="item.entity.id">
          <div class="compact-row">
            <span class="entity-initial" aria-hidden="true">{{
              item.entity.title.trim().slice(0, 1) || '♪'
            }}</span>
            <div class="entity-summary">
              <strong>{{ item.entity.title }}</strong>
              <p>
                {{ identityKindLabel(item.entity.kind)
                }}<template v-if="item.entity.artist"> · {{ item.entity.artist }}</template> ·
                {{ item.candidateCount }} 个候选
              </p>
            </div>
            <button
              type="button"
              :aria-expanded="state.selected?.id === item.entity.id"
              @click="view.select(state.selected?.id === item.entity.id ? null : item.entity)"
            >
              {{ state.selected?.id === item.entity.id ? '收起候选' : '查看候选' }}
            </button>
          </div>
          <IdentityReviewPanel
            v-if="state.selected?.id === item.entity.id"
            :entity-id="item.entity.id"
            :scope="scope"
            @changed="view.refresh()"
          />
        </li>
      </ul>
      <nav
        v-if="state.page && state.page.total > IDENTITY_INBOX_PAGE_SIZE"
        aria-label="资料复核条目分页"
      >
        <button
          type="button"
          :disabled="state.loading || !state.page.offset"
          @click="view.page(Math.max(0, state.page.offset - IDENTITY_INBOX_PAGE_SIZE))"
        >
          上一页条目
        </button>
        <span
          >{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} /
          {{ state.page.total }}</span
        >
        <button
          type="button"
          :disabled="
            state.loading || state.page.offset + state.page.items.length >= state.page.total
          "
          @click="view.page(state.page.offset + IDENTITY_INBOX_PAGE_SIZE)"
        >
          下一页条目
        </button>
      </nav>
    </template>
    <template v-else>
      <div class="identity-inbox-controls">
        <label
          >条目类型
          <select
            :value="state.kind"
            :disabled="state.loading"
            @change="
              view.filter(
                ($event.target as HTMLSelectElement).value as CatalogKind | '',
                state.filter
              )
            "
          >
            <option value="">全部</option>
            <option value="artist">人物</option>
            <option value="recording">录音</option>
            <option value="album_project">专辑作品</option>
            <option value="release">具体发行</option>
          </select>
        </label>
        <label
          >候选状态
          <select
            :value="state.filter"
            :disabled="state.loading"
            @change="
              view.filter(
                state.kind,
                ($event.target as HTMLSelectElement).value as IdentityCandidateState
              )
            "
          >
            <option value="candidate">待复核</option>
            <option value="rejected">已拒绝</option>
            <option value="confirmed">已确认</option>
          </select>
        </label>
        <button type="button" :disabled="state.loading" @click="view.refresh()">
          刷新复核列表
        </button>
      </div>
      <p v-if="state.loading" role="status" class="status-note">正在读取资料复核列表…</p>
      <p v-if="state.error" role="alert" class="alert-note">{{ state.error }}</p>
      <p v-else-if="state.page && !state.page.total" class="empty-note">此筛选下暂无已保存候选。</p>
      <div class="identity-inbox-body">
        <div class="identity-list-pane">
          <ul class="identity-entities" aria-label="待查看的资料条目">
            <li v-for="item in state.page?.items ?? []" :key="item.entity.id">
              <button
                type="button"
                :aria-pressed="state.selected?.id === item.entity.id"
                @click="view.select(item.entity)"
              >
                <strong>{{ item.entity.title }}</strong>
                <span
                  >{{ identityKindLabel(item.entity.kind) }} · {{ item.entity.artist }} ·
                  {{ item.candidateCount }} 个候选</span
                >
                <span v-if="item.sample">{{
                  [item.sample.provider, item.sample.title, item.sample.album]
                    .filter(Boolean)
                    .join(' · ')
                }}</span>
              </button>
            </li>
          </ul>
          <nav
            v-if="state.page && state.page.total > IDENTITY_INBOX_PAGE_SIZE"
            aria-label="资料复核条目分页"
          >
            <button
              type="button"
              :disabled="state.loading || !state.page.offset"
              @click="view.page(Math.max(0, state.page.offset - IDENTITY_INBOX_PAGE_SIZE))"
            >
              上一页条目
            </button>
            <span
              >{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} /
              {{ state.page.total }}</span
            >
            <button
              type="button"
              :disabled="
                state.loading || state.page.offset + state.page.items.length >= state.page.total
              "
              @click="view.page(state.page.offset + IDENTITY_INBOX_PAGE_SIZE)"
            >
              下一页条目
            </button>
          </nav>
        </div>

        <div class="identity-detail-pane">
          <section
            v-if="state.selected"
            class="identity-inbox-selected"
            :aria-label="state.selected.title"
          >
            <header>
              <h3>{{ state.selected.title }} · {{ identityKindLabel(state.selected.kind) }}</h3>
              <button type="button" @click="view.select(null)">关闭此条目</button>
            </header>
            <IdentityReviewPanel
              :entity-id="state.selected.id"
              :scope="scope"
              @changed="view.refresh()"
            />
          </section>
          <div v-else class="identity-empty-detail">
            <p>
              请从左侧列表选择待复核的人物、录音、专辑作品或具体发行，查看匹配依据、缺失项、冲突项与评分／偏好影响。
            </p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.identity-inbox {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.identity-inbox.compact {
  flex: none;
}
.compact-entities {
  list-style: none;
  margin: 0;
  padding: 0;
}
.compact-entities > li {
  padding: 18px 0;
  border-bottom: 1px solid var(--te-card-border);
}
.compact-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.entity-initial {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  color: var(--te-neutral-500);
  background: color-mix(in srgb, var(--te-neutral-500) 10%, transparent);
  font-size: 18px;
}
.entity-summary {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.entity-summary strong {
  font-size: 14px;
  font-weight: 600;
}
.entity-summary p,
.compact-empty p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--te-neutral-500);
}
.compact-row > button {
  flex-shrink: 0;
}
.compact-empty {
  padding: 40px 16px;
  text-align: center;
}
.compact-empty i {
  display: block;
  margin-bottom: 14px;
  font-size: 22px;
  color: var(--te-neutral-500);
}
.compact-empty h3 {
  font-size: 15px;
  font-weight: 500;
}
.compact nav {
  justify-content: center;
  padding: 16px 0;
  font-size: 13px;
}
@media (max-width: 480px) {
  .compact-row {
    flex-wrap: wrap;
    gap: 10px;
  }
  .entity-summary {
    flex-basis: calc(100% - 54px);
  }
  .compact-row > button {
    margin-left: 52px;
  }
}
.identity-inbox-controls,
header,
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.identity-inbox-controls {
  flex-shrink: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--te-card-border);
}
.identity-inbox-body {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 18px;
  flex: 1;
  min-height: 0;
  margin-top: 10px;
  overflow: hidden;
}
.identity-list-pane,
.identity-detail-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.identity-list-pane {
  padding-right: 12px;
  border-right: 1px solid var(--te-card-border);
}
.identity-entities {
  list-style: none;
  padding: 0;
  margin: 0;
}
.identity-entities > li {
  border-bottom: 1px solid var(--te-card-border);
}
.identity-entities button {
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 8px;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.identity-entities strong,
.identity-entities span {
  display: block;
}
.identity-entities span {
  color: var(--te-neutral-500);
  font-size: 12px;
}
button,
select {
  font: inherit;
  font-size: 12.5px;
  color: inherit;
  background: var(--te-card-bg, Canvas);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  padding: 6px 10px;
}
button {
  cursor: pointer;
}
select {
  margin-left: 6px;
}
button[aria-pressed='true'],
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
button[aria-pressed='true'] {
  color: var(--te-primary-600);
  font-weight: 600;
}
button:disabled,
select:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.identity-inbox-selected {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--te-card-border);
  background: color-mix(in srgb, var(--te-neutral-500) 4%, transparent);
}
.identity-empty-detail {
  padding: 28px 20px;
  border-radius: 10px;
  border: 1px dashed var(--te-card-border);
  color: var(--te-neutral-500);
  font-size: 13px;
  line-height: 1.6;
}
.status-note,
.empty-note {
  color: var(--te-neutral-500);
  font-size: 12.5px;
}
.alert-note {
  color: var(--te-danger, #d9534f);
  font-size: 12.5px;
}
header {
  justify-content: space-between;
}
h3 {
  font-size: 1.02em;
  margin: 0;
}
@media (max-width: 820px) {
  .identity-inbox-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .identity-list-pane {
    border-right: 0;
    border-bottom: 1px solid var(--te-card-border);
    padding-right: 0;
    padding-bottom: 12px;
  }
}
</style>
