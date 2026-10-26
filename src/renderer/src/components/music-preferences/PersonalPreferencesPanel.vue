<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createPersonalPreferencesView,
  observePersonalPreferencesView,
  preferenceLabel
} from './personalPreferencesView.ts'

const props = defineProps<{ entityId: string; scope?: string; label: string; compact?: boolean }>()
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
watch(
  [() => props.compact, () => state.value.blocked, () => state.value.loading],
  ([compact, blocked, loading]) => {
    if (compact && blocked && !loading && !state.value.saving && state.value.draft === undefined) {
      void view.refresh()
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  stop()
  view.dispose()
})
</script>
<template>
  <section
    class="personal-preferences"
    :class="{ 'is-compact': compact }"
    :aria-label="`${label}偏好`"
    :aria-busy="state.loading || state.saving"
  >
    <header class="pref-header">
      <h4><span class="compact-hide">{{ label }}</span>偏好</h4>
      <button
        v-if="!compact"
        type="button"
        class="ghost-btn"
        :disabled="state.loading || state.saving"
        @click="view.refresh()"
      >
        重新读取偏好
      </button>
    </header>
    <p v-if="state.loading && !compact" role="status" class="status-note">正在读取偏好…</p>
    <p v-if="state.saving && !compact" role="status" class="status-note">正在保存并核对偏好…</p>
    <p v-if="state.blocked && !compact" role="status" class="status-note">
      偏好、身份或曲库已变化，请重新读取偏好。
    </p>
    <p v-if="state.error" role="alert" class="alert-note">{{ state.error }}</p>
    <p v-if="state.notice && !compact" role="status" class="status-note">{{ state.notice }}</p>
    <template v-if="state.detail || compact">
      <div v-if="state.detail && !compact" class="pref-status-row">
        <p class="saved-preference" :data-state="state.detail.value?.state ?? 'none'">
          已保存：{{ preferenceLabel(state.detail.value, organizationOnly) }}
        </p>
        <p class="hint">
          {{
            state.detail.scope === 'identity'
              ? '同一已确认身份共享此偏好。'
              : '仅此曲库条目的偏好。'
          }}
        </p>
      </div>
      <div
        class="preference-actions"
        role="group"
        :aria-label="`${label}喜欢与${organizationOnly ? '不推荐' : '禁播'}`"
      >
        <button
          type="button"
          class="pref-btn favorite-btn"
          :disabled="!ready"
          :aria-pressed="state.detail?.value?.state === 'favorite'"
          @click="
            state.detail?.value?.state === 'favorite' ? view.cancelFavorite() : view.favorite()
          "
        >
          {{ state.detail?.value?.state === 'favorite' ? '取消喜欢' : '喜欢' }}
        </button>
        <button
          type="button"
          class="pref-btn ban-btn"
          :disabled="!ready"
          :aria-pressed="state.detail?.value?.state === 'ban'"
          @click="state.detail?.value?.state === 'ban' ? view.unban() : view.ban()"
        >
          {{
            organizationOnly
              ? state.detail?.value?.state === 'ban'
                ? '取消不推荐'
                : '不推荐'
              : state.detail?.value?.state === 'ban'
                ? '取消禁播'
                : '禁播'
          }}
        </button>
      </div>
    </template>
    <div v-if="state.draft !== undefined" class="pref-draft-box">
      <p>
        保留的操作：{{
          preferenceLabel({ state: state.draft, revision: 0, updatedAt: 0 }, organizationOnly)
        }}
      </p>
      <div class="preference-actions">
        <button type="button" class="primary-btn" :disabled="!canSave" @click="view.save()">
          保存保留的偏好
        </button>
        <button type="button" :disabled="state.saving" @click="view.discardDraft()">
          放弃保留的操作
        </button>
      </div>
    </div>
    <p v-if="!compact" class="hint">
      {{
        organizationOnly
          ? '喜欢与不推荐互斥；此整理状态不影响参与歌曲的自动选曲。'
          : '喜欢与禁播互斥。禁播只影响自动选曲，手动播放仍可用。'
      }}
    </p>
  </section>
</template>
<style scoped>
.personal-preferences {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--te-card-border);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.pref-header,
.pref-status-row,
.preference-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.pref-header,
.pref-status-row {
  justify-content: space-between;
}
h4 {
  margin: 0;
  font-size: 0.98em;
  font-weight: 600;
  color: var(--te-neutral-900);
}
p {
  margin: 6px 0;
}
button {
  padding: 5px 12px;
  font: inherit;
  font-size: 12.5px;
  color: var(--te-neutral-800, var(--te-neutral-900));
  border: 1px solid var(--te-card-border);
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.ghost-btn {
  border-color: transparent;
  border-radius: 6px;
  color: var(--te-primary-600);
}
.primary-btn {
  border-radius: 6px;
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 40%, var(--te-card-border));
  font-weight: 600;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
.favorite-btn[aria-pressed='true'] {
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 16%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 50%, var(--te-card-border));
  font-weight: 600;
}
.ban-btn[aria-pressed='true'] {
  color: var(--te-danger, #d9534f);
  background: color-mix(in srgb, var(--te-danger, #d9534f) 14%, transparent);
  border-color: color-mix(in srgb, var(--te-danger, #d9534f) 45%, var(--te-card-border));
  font-weight: 600;
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.saved-preference {
  font-weight: 600;
  color: var(--te-neutral-900);
  margin: 0;
}
.saved-preference[data-state='favorite'] {
  color: var(--te-primary-600);
}
.saved-preference[data-state='ban'] {
  color: var(--te-danger, #d9534f);
}
.pref-draft-box {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
}
.status-note {
  font-size: 12.5px;
  color: var(--te-primary-600);
}
.alert-note {
  font-size: 12.5px;
  color: var(--te-danger, #d9534f);
}
.hint {
  color: var(--te-neutral-500);
  font-size: 12.5px;
}
.personal-preferences.is-compact {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 28px;
}
.personal-preferences.is-compact .compact-hide {
  display: none;
}
.personal-preferences.is-compact h4 {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--te-neutral-500);
}
.personal-preferences.is-compact .pref-btn {
  padding: 2px 11px;
  font-size: 12px;
}
</style>
