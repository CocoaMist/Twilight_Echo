<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import type { MetadataTaskFilter } from '../../../../shared/entityMetadataTasks.ts'
import { METADATA_ACTIVE_STATES } from '../../../../shared/entityMetadataTasks.ts'
import {
  createMetadataTasksView,
  METADATA_TASK_PAGE_SIZE,
  METADATA_DEMAND_PAGE_SIZE,
  metadataTaskStateLabel,
  metadataTaskTypeLabel,
  metadataTaskReasonLabel
} from './metadataTasksView.ts'
import { identityKindLabel } from './identityReviewView.ts'
import IdentityReviewPanel from './IdentityReviewPanel.vue'
import MetadataRequeryPanel from './MetadataRequeryPanel.vue'

const props = defineProps<{ active: boolean; filter: MetadataTaskFilter }>()
const emit = defineEmits<{ counts: [value: { active: number; visible: number }] }>()
const core = useCoreConnection()
const view = createMetadataTasksView({
  tasks: (query, signal) => core.query('metadata.entity.tasks', query, signal),
  demands: (query, signal) => core.query('metadata.entity.demands', query, signal),
  cancel: (jobId, batchId, generation) =>
    core.command('metadata.entity.cancel', { jobId, batchId, generation })
})
const state = view.state
const reviewId = ref<string | null>(null)
const selected = computed(() =>
  state.value.page?.items.find((item) => item.id === state.value.selectedId)
)
const review = computed(
  () => state.value.page?.items.find((item) => item.id === reviewId.value)?.entity
)
const scope = computed(() => JSON.stringify(['metadata-tasks', core.state.value?.epoch]))
const outcomeLabel = { matched: '已取得结果', not_found: '未找到', partial: '部分结果' }
const time = (value: number) => new Date(value).toLocaleString()
watch(
  [
    () => core.state.value?.epoch,
    () => core.state.value?.entityMetadataRevision,
    () => props.filter,
    () => props.active
  ],
  (value, previous) => {
    if (!previous || value[0] !== previous[0]) {
      view.reset()
      reviewId.value = null
    }
    if (!core.state.value?.epoch) return
    if (state.value.filter !== props.filter) {
      reviewId.value = null
      void view.filter(props.filter)
    } else if (!previous || value.slice(0, 3).some((v, i) => v !== previous[i]) || props.active)
      void view.refresh()
  },
  { immediate: true }
)
watch(
  () => state.value.page,
  (page) => {
    if (reviewId.value && !page?.items.some((item) => item.id === reviewId.value))
      reviewId.value = null
  }
)
watch(
  () =>
    [
      state.value.page,
      state.value.counts,
      state.value.loading,
      state.value.error,
      state.value.batchId
    ] as const,
  () => {
    const page = state.value.page
    const counts = state.value.counts
    emit('counts', {
      active: counts ? METADATA_ACTIVE_STATES.reduce((sum, key) => sum + counts[key], 0) : 0,
      visible:
        (page?.items.length ?? 0) ||
        (state.value.loading || state.value.error || state.value.batchId ? 1 : 0)
    })
  },
  { immediate: true }
)
onBeforeUnmount(view.dispose)
</script>

<template>
  <section
    v-if="active && (state.page?.total || state.loading || state.error || state.batchId)"
    class="metadata-tasks"
    aria-label="音乐资料持久任务"
  >
    <header>
      <h4>音乐资料</h4>
      <button type="button" :disabled="state.loading || state.cancelling" @click="view.refresh()">
        重新读取资料任务
      </button>
    </header>
    <p v-if="state.loading" role="status">正在读取资料任务…</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.page?.total">共 {{ state.page.total }} 项 · 清空通知不删除这些持久记录</p>
    <p v-if="state.batchId" class="batch-filter">
      当前需求批次：{{ state.batchId }}
      <button type="button" :disabled="state.cancelling" @click="view.filter(filter, null)">
        查看全部批次
      </button>
    </p>
    <article v-for="task in state.page?.items ?? []" :key="task.id" class="metadata-task-record">
      <header>
        <strong>{{ task.title }}</strong>
        <span>{{ metadataTaskStateLabel[task.state] }}</span>
      </header>
      <p>
        {{ task.kind ? identityKindLabel(task.kind) + ' · ' : ''
        }}{{ metadataTaskTypeLabel[task.type] }} · {{ task.provider }} · {{ task.language }}
      </p>
      <p v-if="task.outcome">{{ outcomeLabel[task.outcome] }}</p>
      <p v-if="task.reason">{{ metadataTaskReasonLabel(task.reason) }}</p>
      <p v-if="task.state === 'retry_wait'">
        下次重试：<time :datetime="new Date(task.nextAttemptAt).toISOString()">{{
          time(task.nextAttemptAt)
        }}</time>
        · 已尝试 {{ task.attempts }} 次
      </p>
      <p v-if="task.state === 'blocked'">
        请先恢复资料源的登录、权限或可用性，再从对应条目重新查询。
      </p>
      <p v-if="task.type === 'legacy'">在原专辑资料入口查看结果、取消批次或重新查询。</p>
      <div class="actions">
        <button
          v-if="task.entity"
          type="button"
          :disabled="state.loading || state.cancelling"
          @click="reviewId = reviewId === task.id ? null : task.id"
        >
          {{ reviewId === task.id ? '关闭身份复核' : '核对身份' }}
        </button>
        <button
          type="button"
          :disabled="state.loading || state.cancelling"
          @click="view.select(state.selectedId === task.id ? null : task.id)"
        >
          {{ state.selectedId === task.id ? '收起当前需求' : `当前需求（${task.demandCount}）` }}
        </button>
      </div>
      <section v-if="state.selectedId === task.id" aria-label="任务当前需求">
        <p v-if="state.demandsLoading" role="status">正在读取当前需求…</p>
        <p v-if="state.actionError" role="alert">{{ state.actionError }}</p>
        <p v-if="state.demands && !state.demands.total">没有当前需求。任务记录仍保留。</p>
        <p v-else-if="selected?.type !== 'legacy'">
          取消仅移除此任务的一项需求；其他需求仍会继续，已保存资料保留。
        </p>
        <ul>
          <li v-for="demand in state.demands?.items ?? []" :key="demand.batchId">
            <span
              >{{
                demand.automatic
                  ? demand.origin === 'new'
                    ? '新入库自动需求'
                    : '历史自动需求'
                  : '显式需求'
              }}
              · {{ demand.batchId }}</span
            >
            <div class="actions">
              <button
                type="button"
                :disabled="state.cancelling"
                @click="view.filter(filter, demand.batchId)"
              >
                查看此批次任务
              </button>
              <button
                v-if="demand.canCancel"
                type="button"
                :disabled="state.cancelling || state.loading || state.demandsLoading"
                @click="view.cancel(demand.batchId)"
              >
                取消此项需求
              </button>
            </div>
          </li>
        </ul>
        <nav
          v-if="state.demands && state.demands.total > METADATA_DEMAND_PAGE_SIZE"
          aria-label="任务需求分页"
        >
          <button
            type="button"
            :disabled="state.demandsLoading || state.cancelling || !state.demands.offset"
            @click="view.demandsPage(Math.max(0, state.demands.offset - METADATA_DEMAND_PAGE_SIZE))"
          >
            上一页需求
          </button>
          <span
            >{{ state.demands.offset + 1 }}–{{
              state.demands.offset + state.demands.items.length
            }}
            / {{ state.demands.total }}</span
          >
          <button
            type="button"
            :disabled="
              state.demandsLoading ||
              state.cancelling ||
              state.demands.offset + state.demands.items.length >= state.demands.total
            "
            @click="view.demandsPage(state.demands.offset + METADATA_DEMAND_PAGE_SIZE)"
          >
            下一页需求
          </button>
        </nav>
      </section>
      <IdentityReviewPanel
        v-if="reviewId === task.id && review"
        :entity-id="review.id"
        :scope="scope"
        @changed="view.refresh()"
      />
    </article>
    <MetadataRequeryPanel
      :tasks="state.page?.items ?? []"
      :batch-id="state.batchId"
      :scope="scope"
      @changed="view.refresh()"
    />
    <nav
      v-if="state.page && state.page.total > METADATA_TASK_PAGE_SIZE"
      aria-label="音乐资料任务分页"
    >
      <button
        type="button"
        :disabled="state.loading || state.cancelling || !state.page.offset"
        @click="view.page(Math.max(0, state.page.offset - METADATA_TASK_PAGE_SIZE))"
      >
        上一页任务
      </button>
      <span
        >{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} /
        {{ state.page.total }}</span
      >
      <button
        type="button"
        :disabled="
          state.loading ||
          state.cancelling ||
          state.page.offset + state.page.items.length >= state.page.total
        "
        @click="view.page(state.page.offset + METADATA_TASK_PAGE_SIZE)"
      >
        下一页任务
      </button>
    </nav>
  </section>
</template>

<style scoped>
.metadata-tasks {
  margin-top: 16px;
  min-width: 0;
  overflow-wrap: anywhere;
}
header,
.actions,
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 12px;
}
h4 {
  margin: 0;
  font-size: 13px;
}
.metadata-task-record {
  padding: 16px 0;
  border-bottom: 1px solid var(--notice-border);
}
strong {
  min-width: 0;
  font-size: 13px;
}
header > span,
p,
li {
  color: var(--te-text-secondary);
  font-size: 12px;
  line-height: 1.65;
}
p {
  margin: 6px 0;
}
ul {
  padding-left: 16px;
}
li {
  margin: 10px 0;
}
.actions {
  justify-content: flex-end;
}
button {
  font: inherit;
  font-size: 12px;
  color: var(--te-text);
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  border: 0;
  border-radius: 7px;
  min-height: 28px;
  padding: 6px 10px;
  cursor: pointer;
}
button:hover:enabled {
  background: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
</style>
