<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import type { Track } from '../../types/music.ts'
import { getTrackSource } from '../../../../shared/trackSourceIdentity.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createTrackRatingsView, TRACK_RATING_CHOICES_PAGE_SIZE } from './trackRatingsView.ts'
import PersonalRatingsPanel from './PersonalRatingsPanel.vue'
const props = defineProps<{ track: Track }>()
const core = useCoreConnection()
const view = createTrackRatingsView((query, signal) => core.query('catalog.query', query, signal))
const { state } = view
watch(
  () => [getTrackSource(props.track), props.track.id] as const,
  ([provider, id]) => void view.setContext({ provider, id }, ''),
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
      view.invalidate()
  },
  { flush: 'sync' }
)
onBeforeUnmount(view.dispose)
</script>
<template>
  <section class="track-rating-target" aria-label="选择歌曲评分与偏好条目">
    <p v-if="state.loading" role="status">正在核对录音评分条目…</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.blocked" role="status">曲库已变化，请重新核对录音条目。</p>
    <button v-if="state.error || state.blocked" type="button" @click="view.refresh()">
      重新核对录音条目
    </button>
    <p v-if="state.page && !state.page.total">曲库暂无此歌曲的录音条目，暂不能评分或设置偏好。</p>
    <template v-if="state.page && state.page.total > 1">
      <p>此歌曲对应 {{ state.page.total }} 个独立录音条目，请选择要评分或设置偏好的条目。</p>
      <ul>
        <li v-for="entity in state.page.items" :key="entity.id">
          <button
            type="button"
            :aria-pressed="state.selected?.id === entity.id"
            @click="view.select(entity)"
          >
            {{ entity.title }} · {{ entity.artist }} · {{ entity.sourceCount }} 个音源 ·
            {{ entity.id }}
          </button>
        </li>
      </ul>
      <nav aria-label="评分录音条目分页">
        <button
          type="button"
          :disabled="state.page.offset === 0"
          @click="view.page(Math.max(0, state.page.offset - TRACK_RATING_CHOICES_PAGE_SIZE))"
        >
          上一组录音</button
        ><button
          type="button"
          :disabled="state.page.offset + state.page.items.length >= state.page.total"
          @click="view.page(state.page.offset + TRACK_RATING_CHOICES_PAGE_SIZE)"
        >
          下一组录音
        </button>
      </nav>
    </template>
    <PersonalRatingsPanel
      v-if="state.selected"
      :entity-id="state.selected.id"
      :scope="JSON.stringify([getTrackSource(track), track.id])"
      :track-context="{ provider: getTrackSource(track), id: track.id }"
      label="录音"
    />
  </section>
</template>
<style scoped>
.track-rating-target {
  line-height: 1.65;
  overflow-wrap: anywhere;
}
ul {
  padding: 0;
  list-style: none;
}
button {
  font: inherit;
  color: var(--te-primary-600);
  padding: 6px 10px;
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button[aria-pressed='true'],
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
nav {
  display: flex;
  gap: 8px;
}
</style>
