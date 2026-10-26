<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createIdentityHistoryView,
  IDENTITY_HISTORY_PAGE_SIZE,
  identityHistoryStateLabel
} from './identityHistoryView.ts'
import { identityEvidenceLabel } from './identityReviewView.ts'
import type { IdentificationHistoryItem } from '../../../../shared/musicIdentification.ts'
import IdentityReferences from './IdentityReferences.vue'
import IdentityRatingImpact from '../music-ratings/IdentityRatingImpact.vue'
import IdentityPreferenceImpact from '../music-preferences/IdentityPreferenceImpact.vue'

const props = defineProps<{ entityId: string; scope: string; disabled?: boolean }>()
const emit = defineEmits<{ changed: []; busy: [value: boolean] }>()
const core = useCoreConnection()
const view = createIdentityHistoryView({
  history: (query, signal) => core.query('identification.history', query, signal),
  preview: (query, signal) => core.query('identification.restorePreview', query, signal),
  restore: (query) => core.command('identification.restore', query),
  changed: async () => emit('changed')
})
const { state, ready, canRestore } = view
const busy = computed(
  () => !!props.disabled || state.value.loading || state.value.previewLoading || state.value.saving
)
watch([() => props.entityId, () => props.scope], ([id, scope]) => view.setContext(id, scope), {
  immediate: true,
  flush: 'sync'
})
watch(
  [
    () => core.state.value?.entityMetadataRevision,
    () => core.state.value?.ratingsRevision,
    () => core.state.value?.catalogRevision,
    () => core.state.value?.libraryRevision,
    () => core.state.value?.epoch,
    () => core.state.value?.preferencesRevision
  ],
  (value, previous) => {
    if (value.some((item, index) => previous[index] != null && item !== previous[index]))
      view.invalidate(value[4] !== previous[4])
  },
  { flush: 'sync' }
)
watch(
  () => state.value.saving,
  (value) => emit('busy', value),
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  view.dispose()
  emit('busy', false)
})
const previewPanel = ref<HTMLElement | null>(null),
  toggleButton = ref<HTMLButtonElement | null>(null)
async function review(item: IdentificationHistoryItem) {
  if (props.disabled) return
  const id = props.entityId,
    scope = props.scope
  await view.review(item)
  await nextTick()
  if (id === props.entityId && scope === props.scope && state.value.preview)
    previewPanel.value?.focus()
}
async function restore() {
  if (props.disabled) return
  const id = props.entityId,
    scope = props.scope
  await view.restore()
  await nextTick()
  if (id === props.entityId && scope === props.scope) toggleButton.value?.focus()
}
const timestamp = (value: number) => new Date(value).toLocaleString()
</script>

<template>
  <section class="identity-history" aria-label="身份关联历史" :aria-busy="busy">
    <button
      ref="toggleButton"
      type="button"
      :disabled="busy"
      :aria-expanded="state.opened"
      @click="view.toggle()"
    >
      {{ state.opened ? '收起关联历史' : '查看关联历史' }}
    </button>
    <template v-if="state.opened">
      <p v-if="state.loading || state.previewLoading" role="status">正在核对关联历史…</p>
      <p v-if="state.saving" role="status">正在恢复并核对结果…</p>
      <p v-if="state.error" role="alert">{{ state.error }}</p>
      <p v-if="state.notice" role="status">{{ state.notice }}</p>
      <button type="button" :disabled="busy" @click="view.refresh()">重新读取历史</button>
      <p v-if="state.page && !state.page.total">暂无已保存的关联历史。</p>
      <ol v-if="state.page?.items.length" class="history-items">
        <li v-for="item in state.page.items" :key="item.seq">
          <div class="history-heading">
            <strong
              >{{ identityHistoryStateLabel(item.state)
              }}<template v-if="item.name"> · {{ item.name }}</template></strong
            >
            <time>{{ timestamp(item.changedAt) }}</time>
            <button
              v-if="item.hasSnapshot"
              type="button"
              :disabled="!ready || disabled"
              @click="review(item)"
            >
              比较并恢复
            </button>
          </div>
          <p v-if="item.restoredFrom">恢复自历史记录 #{{ item.restoredFrom }}</p>
          <IdentityReferences :references="item.references" />
        </li>
      </ol>
      <nav
        v-if="state.page && state.page.total > IDENTITY_HISTORY_PAGE_SIZE"
        aria-label="关联历史分页"
      >
        <button
          type="button"
          :disabled="!ready || disabled || state.offset === 0"
          @click="view.page(Math.max(0, state.offset - IDENTITY_HISTORY_PAGE_SIZE))"
        >
          上一页历史
        </button>
        <span
          >{{ state.offset + 1 }}–{{ state.offset + state.page.items.length }} /
          {{ state.page.total }}</span
        >
        <button
          type="button"
          :disabled="
            !ready || disabled || state.offset + state.page.items.length >= state.page.total
          "
          @click="view.page(state.offset + IDENTITY_HISTORY_PAGE_SIZE)"
        >
          下一页历史
        </button>
      </nav>
      <div
        v-if="state.preview"
        ref="previewPanel"
        class="history-preview"
        tabindex="-1"
        aria-label="历史与当前关联比较"
      >
        <p>
          历史确认 #{{ state.preview.history.seq }} ·
          {{ timestamp(state.preview.history.changedAt) }}
        </p>
        <h5>当前关联</h5>
        <p v-if="state.preview.current.link?.state !== 'confirmed'">当前未关联外部身份</p>
        <IdentityReferences :references="state.preview.current.references" />
        <h5>恢复后的关联</h5>
        <IdentityReferences :references="state.preview.references" />
        <p v-if="state.preview.stale" role="alert">
          此历史依据或来源已变化，请联网重新识别后复核。
        </p>
        <p v-for="conflict in state.preview.conflicts" :key="conflict" role="alert">
          {{ identityEvidenceLabel(conflict) }}
        </p>
        <p v-if="state.preview.action === 'keep'">当前已使用此身份，无需恢复。</p>
        <p v-else>确认后按此身份重新读取自动资料；手动内容与播放来源保留。</p>
        <IdentityRatingImpact
          v-if="state.preview.ratingImpact"
          :impact="state.preview.ratingImpact"
          :choice="state.ratingChoice"
          :disabled="busy"
          @choose="view.chooseRating"
        />
        <IdentityPreferenceImpact
          v-if="state.preview.preferenceImpact"
          :impact="state.preview.preferenceImpact"
          :choice="state.preferenceChoice"
          :disabled="busy"
          @choose="view.choosePreference"
        />
        <div class="history-heading">
          <button type="button" :disabled="!canRestore || disabled" @click="restore()">
            确认恢复此关联
          </button>
          <button type="button" :disabled="state.saving" @click="view.cancel()">取消恢复</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.identity-history {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--te-card-border);
  overflow-wrap: anywhere;
}
.history-heading,
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
}
button {
  font: inherit;
  color: var(--te-primary-600);
  background: transparent;
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
button:focus-visible,
.history-preview:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.history-items {
  list-style: none;
  margin: 12px 0;
  padding: 0;
}
.history-items > li {
  padding: 10px 0;
  border-bottom: 1px solid var(--te-card-border);
}
time {
  color: var(--te-neutral-500);
}
.history-preview {
  padding: 12px 0;
  border-block: 1px solid var(--te-card-border);
  margin-top: 12px;
}
h5 {
  margin: 12px 0 6px;
  font-size: 1em;
}
</style>
