<script setup lang="ts">
import { computed } from 'vue'
import type { StreamingSidebarItem } from '../../utils/streamingNavigation'
const props = defineProps<{
  menuOpen: boolean
  items: StreamingSidebarItem[]
  isActive: (item: StreamingSidebarItem) => boolean
}>()
const emit = defineEmits<{ select: [item: StreamingSidebarItem]; selectAggregate: [] }>()
const selectedKey = computed(() => props.items.find(props.isActive)?.key ?? '')
function selectFromMenu(event: Event): void {
  const item = props.items.find((item) => item.key === (event.target as HTMLSelectElement).value)
  if (item) emit('select', item)
}
</script>
<template>
  <nav class="provider-navigation" aria-label="在线音乐浏览">
    <div class="provider-navigation-items">
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="provider-navigation-item"
        :class="{ active: isActive(item) }"
        :aria-current="isActive(item) ? 'page' : undefined"
        @click="emit('select', item)"
      >
        <i class="pi" :class="item.icon" aria-hidden="true"></i><span>{{ item.label }}</span>
      </button>
    </div>
    <label class="provider-navigation-select"
      ><span>浏览</span
      ><select :value="selectedKey" @change="selectFromMenu">
        <option v-for="item in items" :key="item.key" :value="item.key">{{ item.label }}</option>
      </select></label
    >
    <button
      type="button"
      class="hig-button provider-aggregate-link"
      @click="emit('selectAggregate')"
    >
      跨来源歌单
    </button>
  </nav>
</template>
<style scoped>
.provider-navigation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px var(--hig-page-inset, 24px);
  border-bottom: 1px solid var(--hig-stroke);
  background: var(--hig-surface);
  flex: 0 0 auto;
}
.provider-navigation-items {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.provider-navigation-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 0;
  border-radius: 4px;
  min-height: 36px;
  background: transparent;
  color: var(--hig-text);
  font: 14px/20px var(--hig-font);
  cursor: pointer;
  white-space: nowrap;
}
.provider-navigation-item:hover {
  background: var(--te-hover-bg);
}
.provider-navigation-item.active {
  color: var(--hig-brand);
  font-weight: 600;
}
.provider-navigation-item.active::after {
  position: absolute;
  content: '';
  bottom: 0;
  left: 12px;
  right: 12px;
  height: 3px;
  border-radius: 2px;
  background: var(--hig-brand);
}
.provider-navigation-select {
  display: none;
  align-items: center;
  gap: 8px;
}
@media (max-width: 1023px) {
  .provider-navigation-items {
    display: none;
  }
  .provider-navigation-select {
    display: flex;
  }
  .provider-navigation-select select {
    min-height: 32px;
    max-width: 200px;
    background: var(--hig-surface);
    color: var(--hig-text);
    border: 1px solid var(--hig-stroke);
    border-radius: 4px;
    padding: 4px 8px;
    font: 14px/20px var(--hig-font);
  }
}
</style>
