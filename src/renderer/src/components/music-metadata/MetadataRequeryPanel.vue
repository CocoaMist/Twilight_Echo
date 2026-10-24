<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import type { MetadataTaskItem } from '../../../../shared/entityMetadataTasks.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createMetadataRequeryView,
  canRequeryMetadataTask,
  METADATA_REQUERY_SOURCE_PAGE_SIZE
} from './metadataRequeryView.ts'

const props = defineProps<{ tasks: MetadataTaskItem[]; batchId: string | null; scope: string }>()
const emit = defineEmits<{ changed: [] }>()
const core = useCoreConnection()
const view = createMetadataRequeryView({
  sources: (query, signal) => core.query('metadata.entity.sources', query, signal),
  requery: (request) => core.command('metadata.entity.requery', request),
  status: (batchId) => core.query('metadata.entity.tasks', { batchId, limit: 1 }),
  demandId: () => `requery:${globalThis.crypto.randomUUID()}`,
  changed: () => emit('changed')
})
const state = view.state
const tasks = computed(() => props.tasks.filter(canRequeryMetadataTask))
const selectedCount = computed(() => Object.keys(state.value.selected).length)
const selectionInvalid = computed(() =>
  Object.keys(state.value.selected).some((id) => !!state.value.errors[id])
)
watch(
  () => [props.tasks, props.batchId, props.scope] as const,
  () => view.context(props.tasks, props.batchId, props.scope),
  { immediate: true }
)
onBeforeUnmount(view.dispose)
</script>

<template>
  <details v-if="tasks.length" class="metadata-requery">
    <summary>重新查询资料</summary>
    <p>选择当前仍在库、身份已确认的条目作为查询来源；这会联网补资料，不会覆盖手动内容。</p>
    <p v-if="batchId">仅处理此批次当前页中明确选中的任务；已取消的旧需求不会恢复。</p>
    <section v-for="task in tasks" :key="task.id" :aria-label="`重新查询 ${task.title}`">
      <header>
        <strong>{{ task.title }}</strong>
        <button
          type="button"
          :disabled="state.submitting || state.loading[task.id]"
          @click="view.sources(task.id)"
        >
          选择库内条目
        </button>
      </header>
      <p v-if="state.loading[task.id]" role="status">正在读取当前关联…</p>
      <p v-if="state.errors[task.id]" role="alert">{{ state.errors[task.id] }}</p>
      <p v-if="state.sources[task.id] && !state.sources[task.id].total">
        没有有效的库内关联，请从条目资料页重新核对身份。
      </p>
      <ul v-if="state.sources[task.id]">
        <li v-for="source in state.sources[task.id].items" :key="source.entity.id">
          <button
            type="button"
            :disabled="state.submitting || state.loading[task.id]"
            :aria-pressed="state.selected[task.id]?.entity.id === source.entity.id"
            @click="view.select(task.id, source.entity.id)"
          >
            {{ source.entity.title }} · {{ source.providers.join(' / ') }} ·
            {{ source.entity.id.slice(0, 8) }}
          </button>
        </li>
      </ul>
      <p v-if="state.selected[task.id]">
        已选择：{{ state.selected[task.id].entity.title }} ·
        {{ state.selected[task.id].providers.join(' / ') }}
      </p>
      <nav
        v-if="state.sources[task.id]?.total > METADATA_REQUERY_SOURCE_PAGE_SIZE"
        aria-label="重新查询来源分页"
      >
        <button
          type="button"
          :disabled="state.submitting || state.loading[task.id] || !state.sources[task.id].offset"
          @click="
            view.sources(task.id, state.sources[task.id].offset - METADATA_REQUERY_SOURCE_PAGE_SIZE)
          "
        >
          上一页来源
        </button>
        <span
          >{{ state.sources[task.id].offset + 1 }}–{{
            state.sources[task.id].offset + state.sources[task.id].items.length
          }}
          / {{ state.sources[task.id].total }}</span
        >
        <button
          type="button"
          :disabled="
            state.submitting ||
            state.loading[task.id] ||
            state.sources[task.id].offset + state.sources[task.id].items.length >=
              state.sources[task.id].total
          "
          @click="
            view.sources(task.id, state.sources[task.id].offset + METADATA_REQUERY_SOURCE_PAGE_SIZE)
          "
        >
          下一页来源
        </button>
      </nav>
    </section>
    <button
      type="button"
      :disabled="
        !selectedCount ||
        state.submitting ||
        selectionInvalid ||
        Object.values(state.loading).some(Boolean)
      "
      @click="view.submit()"
    >
      {{ state.submitting ? '正在建立查询…' : `联网重新查询所选（${selectedCount}）` }}
    </button>
    <p v-if="state.message" role="status">{{ state.message }}</p>
  </details>
</template>

<style scoped>
.metadata-requery {
  margin: 12px 0;
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
p {
  color: var(--te-text-secondary);
  margin: 8px 0;
}
section {
  padding: 12px 0;
  border-bottom: 1px solid var(--notice-border);
}
header,
nav {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}
ul {
  list-style: none;
  padding: 0;
}
li {
  margin: 6px 0;
}
button {
  font: inherit;
  min-height: 30px;
  padding: 6px 10px;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  color: var(--te-text);
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
}
button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 26%, transparent);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
</style>
