<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createIdentityInboxView, IDENTITY_INBOX_PAGE_SIZE } from './identityInboxView.ts'
import { identityKindLabel, type IdentityCandidateState } from './identityReviewView.ts'
import type { CatalogKind } from '../../../../shared/musicCatalog.ts'
import IdentityReviewPanel from './IdentityReviewPanel.vue'
const core = useCoreConnection()
const view = createIdentityInboxView((query, signal) =>
  core.query('identification.inbox', query, signal)
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
  <div class="identity-inbox" aria-label="音乐资料复核">
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
      <button type="button" :disabled="state.loading" @click="view.refresh()">刷新复核列表</button>
    </div>
    <p v-if="state.loading" role="status">正在读取资料复核列表…</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-else-if="state.page && !state.page.total">此筛选下暂无已保存候选。</p>
    <div class="identity-inbox-body">
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
            <span v-if="item.sample">{{ [item.sample.provider, item.sample.title, item.sample.album].filter(Boolean).join(' · ') }}</span>
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
    </div>
  </div>
</template>
<style scoped>
.identity-inbox {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin-top: 12px;
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
}
.identity-inbox-body {
  overflow: auto;
  min-height: 0;
  padding: 4px;
}
.identity-entities {
  list-style: none;
  padding: 0;
}
.identity-entities > li {
  border-bottom: 1px solid var(--te-card-border);
}
.identity-entities button {
  width: 100%;
  text-align: left;
  border: 0;
}
.identity-entities strong,
.identity-entities span {
  display: block;
}
.identity-entities span {
  color: var(--te-neutral-500);
}
button,
select {
  font: inherit;
  color: inherit;
  background: var(--te-card-bg, Canvas);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  padding: 7px 10px;
}
button {
  cursor: pointer;
}
select {
  margin-left: 8px;
}
button[aria-pressed='true'],
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
button:disabled,
select:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.identity-inbox-selected {
  margin-top: 24px;
}
header {
  justify-content: space-between;
}
h3 {
  font-size: 1em;
  margin: 0;
}
</style>
