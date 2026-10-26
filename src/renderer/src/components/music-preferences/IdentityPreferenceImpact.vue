<script setup lang="ts">
import type {
  MusicPreferenceImpact,
  MusicPreferenceResolution
} from '../../../../shared/musicPreferences.ts'
import { preferenceLabel } from './personalPreferencesView.ts'

defineProps<{
  impact: MusicPreferenceImpact
  choice: MusicPreferenceResolution['choice'] | null
  disabled?: boolean
}>()
const emit = defineEmits<{ choose: [choice: MusicPreferenceResolution['choice']] }>()
</script>
<template>
  <section class="identity-preference-impact" aria-label="身份变更的偏好影响">
    <h5>喜欢与禁播影响</h5>
    <p>
      {{ impact.related?.length ? '当前／关联条目偏好' : '当前偏好' }}：{{ preferenceLabel(impact.current) }} · 目标偏好：{{
        preferenceLabel(impact.target)
      }}
    </p>
    <template v-if="impact.conflict">
      <p>明确同一身份的条目有不同偏好，确认关联前请选择。所选结果用于目标身份及其关联条目。</p>
      <div role="group" aria-label="解决喜欢与禁播冲突">
        <button
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === 'current'"
          @click="emit('choose', 'current')"
        >
          采用当前偏好（{{ preferenceLabel(impact.current) }}）
        </button>
        <button
          v-for="related in impact.related ?? []"
          :key="related.entityId"
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === `related:${related.entityId}`"
          @click="emit('choose', `related:${related.entityId}`)"
        >
          采用“{{ related.title }}”偏好（{{ preferenceLabel(related.value) }}）
        </button>
        <button
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === 'target'"
          @click="emit('choose', 'target')"
        >
          采用目标偏好（{{ preferenceLabel(impact.target) }}）
        </button>
        <button
          type="button"
          :disabled="disabled"
          :aria-pressed="choice === 'clear'"
          @click="emit('choose', 'clear')"
        >
          清除目标偏好
        </button>
      </div>
    </template>
    <p v-else-if="impact.action === 'carry'">确认后把当前／关联条目偏好带入目标身份，并与同身份条目共享。</p>
    <p v-else-if="impact.action === 'share'">确认后使用目标身份已有的偏好。</p>
    <p v-else>此次关联不改变喜欢与禁播。</p>
    <p>禁播只影响自动选曲，手动播放仍可用。</p>
  </section>
</template>
<style scoped>
.identity-preference-impact {
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
