<script setup lang="ts">
defineProps<{
  modelValue: string
  options: Array<{ id: string; label: string; available?: boolean }>
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
<template>
  <label class="hig-search-scope">
    <span>搜索范围</span>
    <select
      :value="modelValue"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="option in options"
        :key="option.id"
        :value="option.id"
        :disabled="option.available === false"
      >
        {{ option.id === 'all' ? '全部来源' : option.id === 'local' ? '当前音乐库' : option.label }}
      </option>
    </select>
  </label>
</template>
<style scoped>
.hig-search-scope {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 auto;
  min-width: 0;
  color: var(--hig-muted);
  font: 14px/20px var(--hig-font);
}
select {
  min-width: 0;
  max-width: 240px;
  min-height: 32px;
  padding: 4px 12px;
  border: 1px solid var(--hig-stroke);
  border-radius: 4px;
  background: var(--hig-surface);
  color: var(--hig-text);
  font: inherit;
}
</style>
