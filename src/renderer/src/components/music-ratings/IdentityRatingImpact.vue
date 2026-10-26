<script setup lang="ts">
import type { MusicRatingImpact, MusicRatingResolution } from '../../../../shared/musicRatings.ts'
import { ratingLabel } from './personalRatingsView.ts'
defineProps<{
  impact: MusicRatingImpact
  choice: MusicRatingResolution['choice'] | null
  disabled?: boolean
}>()
const emit = defineEmits<{ choose: [choice: MusicRatingResolution['choice']] }>()
</script>
<template>
  <section class="identity-rating-impact" aria-label="身份变更的评分影响">
    <h5>个人评分影响</h5>
    <p>当前条目：{{ ratingLabel(impact.current) }} · 目标身份：{{ ratingLabel(impact.target) }}</p>
    <template v-if="impact.conflict">
      <p>两边评分不同，确认关联前请选择。所选结果将用于目标身份及其关联条目。</p>
      <div role="group" aria-label="解决个人评分冲突">
        <button
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === 'current'"
          @click="emit('choose', 'current')"
        >
          采用当前评分（{{ ratingLabel(impact.current) }}）
        </button>
        <button
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === 'target'"
          @click="emit('choose', 'target')"
        >
          采用目标评分（{{ ratingLabel(impact.target) }}）
        </button>
        <button
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === 'clear'"
          @click="emit('choose', 'clear')"
        >
          清除目标评分
        </button>
      </div>
    </template>
    <p v-else-if="impact.action === 'carry'">确认后把当前评分带入目标身份，并与同身份条目共享。</p>
    <p v-else-if="impact.action === 'share'">确认后使用目标身份已有的共享评分。</p>
    <p v-else>此次关联不改变个人评分。</p>
  </section>
</template>
<style scoped>
.identity-rating-impact {
  margin: 12px 0;
  padding: 12px 0;
  border-block: 1px solid var(--te-card-border);
  line-height: 1.65;
}
h5 {
  margin: 0;
  font-size: 1em;
  color: var(--te-neutral-900);
}
p {
  margin: 8px 0;
}
div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
button[aria-pressed='true'],
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
</style>
