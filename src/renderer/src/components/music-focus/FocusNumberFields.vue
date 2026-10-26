<script setup lang="ts">
import type { FocusDraftNode } from './musicFocusDraft.ts'
defineProps<{
  fields: FocusDraftNode['fields']
  prefix?: string
  label: string
  disabled: boolean
  rating?: boolean
}>()
defineEmits<{ field: [key: string, value: string] }>()
</script>

<template>
  <div class="number-fields">
    <label
      >{{ label }}记录
      <select
        :value="fields[`${prefix ?? ''}exists`] ?? 'any'"
        :disabled="disabled"
        @change="
          $emit('field', `${prefix ?? ''}exists`, ($event.target as HTMLSelectElement).value)
        "
      >
        <option value="any">按数值比较</option>
        <option value="present">有{{ label }}记录</option>
        <option value="missing">无{{ label }}记录</option>
      </select>
    </label>
    <template v-if="fields[`${prefix ?? ''}exists`] !== 'missing'">
      <label v-for="key in rating ? ['gte', 'lte'] : ['eq', 'gte', 'lte']" :key="key">
        {{ label }}{{ key === 'eq' ? '等于' : key === 'gte' ? '至少' : '至多' }}
        <input
          type="number"
          min="0"
          :max="rating ? 5 : undefined"
          :step="rating ? 0.5 : 'any'"
          :value="fields[`${prefix ?? ''}${key}`] ?? ''"
          :disabled="disabled"
          placeholder="不限"
          @input="
            $emit('field', `${prefix ?? ''}${key}`, ($event.target as HTMLInputElement).value)
          "
        />
      </label>
    </template>
  </div>
</template>

<style scoped>
.number-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}
label {
  display: grid;
  gap: 4px;
  min-width: 100px;
  flex: 1;
}
input,
select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  font: inherit;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
}
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
:disabled {
  opacity: 0.5;
}
</style>
