<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import type { CatalogKind } from '../../../../shared/musicCatalog.ts'
import type {
  EntityMetadataJob,
  EntityMetadataLanguage
} from '../../../../shared/entityMetadata.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  artistUpdateProviders,
  createArtistMetadataUpdate
} from '../song-list/artistMetadataUpdate.ts'
import { metadataProviderLabel } from '../../../../shared/metadataProviders.ts'
import { metadataTaskStateLabel, metadataTaskReasonLabel } from './metadataTasksView.ts'
const props = defineProps<{
  entityId: string
  kind: CatalogKind
  language: EntityMetadataLanguage
  scope: string
}>()
const core = useCoreConnection()
// The selected metadata layer owns this instance; switching release/project
// remounts it, aborting reads and preserving already accepted durable demands.
const model = createArtistMetadataUpdate(
  {
    policy: (signal) => core.query('metadata.entity.policy', {}, signal),
    identity: (entityId, signal) => core.query('identification.detail', { entityId }, signal),
    jobs: (entityId, signal) => core.query('metadata.entity.jobs', { entityId, limit: 16 }, signal),
    enrich: async (request) =>
      (await core.command('metadata.entity.enrich', request)) as EntityMetadataJob,
    sources: (query) => core.query('metadata.entity.sources', query),
    requery: (request) => core.command('metadata.entity.requery', request),
    newId: () => `metadata-page:${crypto.randomUUID()}`
  },
  props.kind
)
const state = model.state
const available = computed(
  () =>
    !!state.value.policy &&
    artistUpdateProviders(state.value.policy, props.kind, state.value.references).length > 0
)
watch(
  () => [props.entityId, props.language, props.scope],
  () => void model.setContext({ entityId: props.entityId, language: props.language }),
  { immediate: true }
)
watch(
  () => core.state.value?.entityMetadataRevision,
  () => void model.refresh()
)
onBeforeUnmount(model.dispose)
</script>
<template>
  <div class="metadata-update-controls">
    <button
      type="button"
      :disabled="!available || state.loading || state.submitting"
      @click="model.submit()"
    >
      {{ state.submitting ? '正在提交…' : '更新资料' }}
    </button>
    <span v-if="state.notice" role="status">{{ state.notice }}</span>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-else-if="state.policy && !state.loading && !available">
      {{
        state.references?.length
          ? '当前资料源不可用，请在音乐库资料设置中查看原因。'
          : '当前身份尚无可用的资料源 ID，请先在身份复核中关联资料源。'
      }}
    </p>
    <ul v-if="state.jobs.length" aria-label="资料更新任务">
      <li v-for="job in state.jobs" :key="job.id">
        {{ metadataProviderLabel(job.provider) }} · {{ metadataTaskStateLabel[job.state]
        }}<span v-if="job.outcome === 'not_found'"> · 未找到资料</span>
        <span v-else-if="job.outcome === 'partial'"> · 仅有部分资料</span>
        <span v-if="job.reason"> · {{ metadataTaskReasonLabel(job.reason) }}</span>
      </li>
    </ul>
  </div>
</template>
<style scoped>
.metadata-update-controls {
  margin: 16px 0;
  color: var(--text-secondary);
  line-height: 1.65;
}
button {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--te-card-border);
  background: var(--te-card-bg);
  color: var(--text-primary);
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
ul {
  padding-left: 20px;
}
</style>
