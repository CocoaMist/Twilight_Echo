<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createPersonalPreferencesView,
  observePersonalPreferencesView,
  preferenceLabel
} from './personalPreferencesView.ts'

const props = defineProps<{ entityId: string; scope?: string; label: string }>()
const core = useCoreConnection()
const view = createPersonalPreferencesView({
  detail: (entityId, signal) => core.query('preferences.detail', { entityId }, signal),
  set: (query) => core.command('preferences.set', query)
})
const { state, ready, canSave } = view
const organizationOnly = computed(() => state.value.organizationOnly)
const stop = observePersonalPreferencesView(view, {
  entityId: () => props.entityId,
  scope: () => props.scope ?? '',
  snapshot: () => core.state.value
})
onBeforeUnmount(() => {
  stop()
  view.dispose()
})
</script>
<template>
  <section
    class="personal-preferences"
    :aria-label="`${label}偏好`"
    :aria-busy="state.loading || state.saving"
  >
    <header>
      <h4>{{ label }}偏好</h4>
      <button type="button" :disabled="state.loading || state.saving" @click="view.refresh()">
        重新读取偏好
      </button>
    </header>
    <p v-if="state.loading" role="status">正在读取偏好…</p>
    <p v-if="state.saving" role="status">正在保存并核对偏好…</p>
    <p v-if="state.blocked" role="status">偏好、身份或曲库已变化，请重新读取偏好。</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <template v-if="state.detail">
      <p class="saved-preference">已保存：{{ preferenceLabel(state.detail.value, organizationOnly) }}</p>
      <p class="hint">
        {{
          state.detail.scope === 'identity' ? '同一已确认身份共享此偏好。' : '仅此曲库条目的偏好。'
        }}
      </p>
      <div class="preference-actions" role="group" :aria-label="`${label}喜欢与${organizationOnly ? '不推荐' : '禁播'}`">
        <button
          type="button"
          :disabled="!ready"
          :aria-pressed="state.detail.value?.state === 'favorite'"
          @click="
            state.detail.value?.state === 'favorite' ? view.cancelFavorite() : view.favorite()
          "
        >
          {{ state.detail.value?.state === 'favorite' ? '取消喜欢' : '喜欢' }}
        </button>
        <button
          type="button"
          :disabled="!ready"
          :aria-pressed="state.detail.value?.state === 'ban'"
          @click="state.detail.value?.state === 'ban' ? view.unban() : view.ban()"
        >
          {{ organizationOnly ? (state.detail.value?.state === 'ban' ? '取消不推荐' : '不推荐') : (state.detail.value?.state === 'ban' ? '取消禁播' : '禁播') }}
        </button>
      </div>
    </template>
    <div v-if="state.draft !== undefined">
      <p>保留的操作：{{ preferenceLabel({ state: state.draft, revision: 0, updatedAt: 0 }, organizationOnly) }}</p>
      <div class="preference-actions">
        <button type="button" :disabled="!canSave" @click="view.save()">保存保留的偏好</button>
        <button type="button" :disabled="state.saving" @click="view.discardDraft()">
          放弃保留的操作
        </button>
      </div>
    </div>
    <p class="hint">{{ organizationOnly ? '喜欢与不推荐互斥；此整理状态不影响参与歌曲的自动选曲。' : '喜欢与禁播互斥。禁播只影响自动选曲，手动播放仍可用。' }}</p>
  </section>
</template>
<style scoped>
.personal-preferences {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--te-card-border);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
header,
.preference-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
header {
  justify-content: space-between;
}
h4 {
  margin: 0;
  font-size: 1em;
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
.saved-preference {
  font-weight: 600;
  color: var(--te-neutral-900);
}
.hint {
  color: var(--te-neutral-500);
}
</style>
