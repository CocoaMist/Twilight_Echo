<script setup lang="ts">
defineProps<{ error: string }>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <section class="theme-dashboard-status" role="status" aria-live="polite">
    <span>{{ error || '正在读取音乐库…' }}</span>
    <button v-if="error" type="button" @click="emit('retry')">重试</button>
  </section>
</template>

<style scoped>
.theme-dashboard-status {
  padding: calc(var(--te-titlebar-inset, 35px) + 24px) 24px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--te-text-primary);
}
.theme-dashboard-status button {
  padding: 8px 16px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-bg-secondary);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
:global(html[data-te-shell-layout='custom']) .theme-dashboard-status {
  padding-top: 24px;
}
</style>
