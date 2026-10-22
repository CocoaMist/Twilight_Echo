<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase'
const props = withDefaults(
  defineProps<{
    page: number
    total: number | null
    loading: boolean
    label: string
    size?: number
  }>(),
  { size: LIBRARY_PAGE_SIZE }
)
const emit = defineEmits<{ page: [page: number] }>()
const selected = ref(props.page + 1)
const pageCount = computed(() => Math.max(1, Math.ceil((props.total ?? 0) / props.size)))
watch(
  () => props.page,
  (page) => {
    selected.value = page + 1
  }
)
function navigate(value: number): void {
  if (!Number.isSafeInteger(value)) {
    selected.value = props.page + 1
    return
  }
  const page = Math.max(0, Math.min(pageCount.value - 1, value - 1))
  selected.value = page + 1
  if (page !== props.page) emit('page', page)
}
</script>
<template>
  <nav class="library-pager" :aria-label="label">
    <span>{{ total === null ? '正在读取总数' : `共 ${total} 项` }}</span>
    <button type="button" :disabled="loading || page === 0" @click="navigate(page)">上一页</button>
    <label
      >第
      <input
        v-model.number="selected"
        type="number"
        min="1"
        :max="pageCount"
        :disabled="loading"
        :aria-label="`${label}页码`"
        @change="navigate(selected)"
        @keydown.enter.prevent="navigate(selected)"
      />
      / {{ pageCount }} 页</label
    >
    <button type="button" :disabled="loading || page >= pageCount - 1" @click="navigate(page + 2)">
      下一页
    </button>
  </nav>
</template>
<style scoped>
.library-pager {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  flex-shrink: 0;
  margin: 8px 0;
  font-size: var(--te-font-size-body, 14px);
  color: var(--te-neutral-700);
}
.library-pager button,
.library-pager input {
  font: inherit;
  color: inherit;
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-radius-global);
  padding: 6px 10px;
  min-height: 32px;
}
.library-pager button {
  cursor: pointer;
}
.library-pager button:disabled {
  cursor: default;
  opacity: 0.5;
}
.library-pager input {
  width: 5em;
}
.library-pager label {
  white-space: nowrap;
}
</style>
