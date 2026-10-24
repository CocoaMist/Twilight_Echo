<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createPersonalRatingsView,
  observePersonalRatingsView,
  ratingLabel,
  RATINGS_HISTORY_PAGE_SIZE
} from './personalRatingsView.ts'
import PersonalPreferencesPanel from '../music-preferences/PersonalPreferencesPanel.vue'
import MusicTagsPanel from '../music-tags/MusicTagsPanel.vue'
import { createRatingTargetsView, RATING_TARGET_PAGE_SIZE } from './ratingTargetsView.ts'
const props = defineProps<{
  entityId: string
  scope?: string
  label: string
  trackContext?: { provider: string; id: string }
}>()
const core = useCoreConnection()
const view = createPersonalRatingsView({
  detail: (entityId, signal) => core.query('ratings.detail', { entityId }, signal),
  set: (query) => core.command('ratings.set', query),
  history: (query, signal) => core.query('ratings.history', query, signal)
})
const { state, ready, canSave } = view
const targets = createRatingTargetsView((query, signal) =>
  core.query('ratings.targets', query, signal)
)
const targetState = targets.state
watch(
  [() => props.entityId, () => props.scope, () => JSON.stringify(props.trackContext)],
  ([id, scope]) => void targets.setContext(id, scope ?? '', props.trackContext),
  { immediate: true, flush: 'sync' }
)
watch(
  [
    () => core.state.value?.epoch,
    () => core.state.value?.catalogRevision,
    () => core.state.value?.libraryRevision
  ],
  (value, previous) => {
    if (value.some((item, index) => previous[index] != null && item !== previous[index]))
      targets.invalidate()
  },
  { flush: 'sync' }
)
const stop = observePersonalRatingsView(view, {
  entityId: () => targetState.value.selected?.id ?? null,
  scope: () => JSON.stringify([props.entityId, props.scope, props.trackContext]),
  snapshot: () => core.state.value
})
onBeforeUnmount(() => {
  stop()
  view.dispose()
  targets.dispose()
})
async function refresh() {
  const context = JSON.stringify([
    props.entityId,
    props.scope,
    props.trackContext,
    core.state.value?.epoch
  ])
  view.invalidate()
  await targets.refresh()
  if (
    context ===
      JSON.stringify([props.entityId, props.scope, props.trackContext, core.state.value?.epoch]) &&
    targetState.value.selected &&
    !targetState.value.loading &&
    !targetState.value.blocked &&
    !targetState.value.error
  )
    await view.refresh()
}
async function targetPage(offset: number) {
  view.invalidate()
  await targets.page(offset)
}
const selected = computed(() =>
  state.value.draft === undefined ? state.value.detail?.value?.steps : state.value.draft
)
const reasons = {
  set: '设置评分',
  clear: '清除评分',
  identity_carry: '随身份带入',
  identity_current: '采用当前评分',
  identity_clear: '身份合并时清除'
}
const timestamp = (value: number) => new Date(value).toLocaleString()
</script>

<template>
  <section
    class="personal-ratings"
    :aria-label="`${label}评分`"
    :aria-busy="state.loading || state.saving"
  >
    <header>
      <h3>{{ label }}评分</h3>
      <button
        type="button"
        :disabled="state.loading || state.saving || targetState.loading"
        @click="refresh()"
      >
        重新读取评分
      </button>
    </header>
    <p v-if="targetState.loading" role="status">正在核对具体评分条目…</p>
    <p v-if="targetState.error" role="alert">{{ targetState.error }}</p>
    <p v-if="targetState.blocked" role="status">曲库已变化，请重新读取具体评分条目。</p>
    <p v-if="targetState.page && !targetState.page.total">暂无可评分的具体录音或发行条目。</p>
    <template v-if="targetState.page && targetState.page.total > 1">
      <p>
        此播放版本包含 {{ targetState.page.total }} 个独立{{
          label
        }}条目，请选择；评分不会合并不同录音或发行，喜欢与禁播也分别保留。
      </p>
      <ul class="rating-targets">
        <li v-for="target in targetState.page.items" :key="target.id">
          <button
            type="button"
            :aria-pressed="targetState.selected?.id === target.id"
            :disabled="state.saving"
            @click="targets.select(target)"
          >
            {{ target.title }} · {{ target.artist }} · {{ target.id }}
          </button>
        </li>
      </ul>
      <nav aria-label="具体评分条目分页">
        <button
          type="button"
          :disabled="state.saving || targetState.page.offset === 0"
          @click="targetPage(Math.max(0, targetState.page.offset - RATING_TARGET_PAGE_SIZE))"
        >
          上一组评分条目</button
        ><button
          type="button"
          :disabled="
            state.saving ||
            targetState.page.offset + targetState.page.items.length >= targetState.page.total
          "
          @click="targetPage(targetState.page.offset + RATING_TARGET_PAGE_SIZE)"
        >
          下一组评分条目
        </button>
      </nav>
    </template>
    <p v-if="state.loading" role="status">正在读取评分…</p>
    <p v-if="state.saving" role="status">正在保存并核对评分…</p>
    <p v-if="state.blocked" role="status">评分、身份或曲库已变化，请重新读取评分。</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <template
      v-if="state.detail && !targetState.loading && !targetState.blocked && !targetState.error"
    >
      <p class="saved-rating">已保存：{{ ratingLabel(state.detail.value) }}</p>
      <p class="rating-hint">
        {{
          state.detail.scope === 'identity'
            ? '同一已确认身份共享个人评分。'
            : '仅此曲库条目的个人评分。'
        }}
      </p>
      <div class="rating-choices" role="group" aria-label="个人评分，半星递增">
        <button
          v-for="steps in 10"
          :key="steps"
          type="button"
          :aria-pressed="selected === steps"
          :disabled="!ready"
          @click="view.choose(steps)"
        >
          {{ steps / 2 }} 星
        </button>
      </div>
      <p v-if="state.draft !== undefined" class="rating-draft">
        未保存草稿：{{ state.draft === null ? '清除评分' : `${state.draft / 2} 星` }}
      </p>
      <div class="rating-actions">
        <button type="button" :disabled="!canSave" @click="view.save()">保存评分</button>
        <button
          type="button"
          :disabled="!ready || state.detail.value?.steps == null"
          @click="view.clear()"
        >
          清除评分
        </button>
        <button
          v-if="state.draft !== undefined"
          type="button"
          :disabled="state.saving"
          @click="view.discardDraft()"
        >
          放弃草稿
        </button>
      </div>
    </template>
    <p v-else-if="state.draft !== undefined" class="rating-draft">
      保留的草稿：{{ state.draft === null ? '清除评分' : `${state.draft / 2} 星` }}
    </p>
    <PersonalPreferencesPanel
      v-if="
        targetState.selected && !targetState.loading && !targetState.blocked && !targetState.error
      "
      :entity-id="targetState.selected.id"
      :scope="JSON.stringify([entityId, scope, trackContext])"
      :label="label"
    />
    <MusicTagsPanel
      v-if="
        targetState.selected && !targetState.loading && !targetState.blocked && !targetState.error
      "
      :entity-id="targetState.selected.id"
      :scope="JSON.stringify([entityId, scope, trackContext])"
      :label="label"
    />
    <p class="rating-hint">资料评分：暂无资料评分</p>
    <button
      type="button"
      :disabled="!ready || targetState.blocked || targetState.loading"
      :aria-expanded="state.historyOpened"
      @click="view.toggleHistory()"
    >
      {{ state.historyOpened ? '收起评分历史' : '查看评分历史' }}
    </button>
    <template v-if="state.historyOpened">
      <p v-if="state.historyLoading" role="status">正在读取评分历史…</p>
      <p v-if="state.historyError" role="alert">
        {{ state.historyError }}
        <button type="button" :disabled="!ready" @click="view.history()">重试评分历史</button>
      </p>
      <p v-if="state.history && !state.history.total">暂无评分历史。</p>
      <ol v-if="state.history?.items.length" class="rating-history">
        <li v-for="item in state.history.items" :key="item.seq">
          {{ ratingLabel(item) }} · {{ reasons[item.reason] }}
          <time>{{ timestamp(item.updatedAt) }}</time>
        </li>
      </ol>
      <nav
        v-if="state.history && state.history.total > RATINGS_HISTORY_PAGE_SIZE"
        aria-label="评分历史分页"
      >
        <button
          type="button"
          :disabled="!ready || state.historyLoading || state.history.offset === 0"
          @click="view.history(Math.max(0, state.history.offset - RATINGS_HISTORY_PAGE_SIZE))"
        >
          上一页评分
        </button>
        <span
          >{{ state.history.offset + 1 }}–{{ state.history.offset + state.history.items.length }} /
          {{ state.history.total }}</span
        >
        <button
          type="button"
          :disabled="
            !ready ||
            state.historyLoading ||
            state.history.offset + state.history.items.length >= state.history.total
          "
          @click="view.history(state.history.offset + RATINGS_HISTORY_PAGE_SIZE)"
        >
          下一页评分
        </button>
      </nav>
    </template>
  </section>
</template>

<style scoped>
.personal-ratings {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--te-card-border);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
header,
.rating-choices,
.rating-actions,
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
header {
  justify-content: space-between;
}
h3 {
  margin: 0;
  font-size: 1.1em;
  color: var(--te-neutral-900);
}
p {
  margin: 8px 0;
}
button {
  padding: 6px 10px;
  font: inherit;
  color: var(--te-primary-600);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
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
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.saved-rating {
  font-weight: 600;
  color: var(--te-neutral-900);
}
.rating-hint,
time {
  color: var(--te-neutral-500);
}
.rating-draft {
  color: var(--te-neutral-700);
}
.rating-history {
  padding-left: 20px;
}
.rating-targets {
  padding: 0;
  list-style: none;
}
time {
  display: block;
}
</style>
