<script setup lang="ts">
import { onTabKeydown } from '../../app/tabNavigation'
import SearchScopeSelect from '../hig/SearchScopeSelect.vue'
import type { SearchSource, SearchSourceOption, SearchType } from './useStreamingSearch'
const props = defineProps<{
  searchType: SearchType
  availableSearchTypes: SearchType[]
  searchSources: SearchSourceOption[]
  searchSource: SearchSource
}>()
const emit = defineEmits<{
  'update:searchType': [value: SearchType]
  'select-source': [value: SearchSource]
}>()
const types: Array<{ id: SearchType; label: string }> = [
  { id: 'songs', label: '单曲' },
  { id: 'playlists', label: '歌单' },
  { id: 'artists', label: '艺术家' }
]
function selectSource(id: string): void {
  if (props.searchSources.some((source) => source.id === id && source.available))
    emit('select-source', id)
}
</script>
<template>
  <div class="streaming-search-tabs">
    <div class="search-type-group" role="tablist" aria-label="搜索结果类型" @keydown="onTabKeydown">
      <button
        v-for="type in types"
        :id="`streaming-search-tab-${type.id}`"
        :key="type.id"
        type="button"
        class="search-tab-pill"
        data-te-interactive
        role="tab"
        :tabindex="searchType === type.id ? 0 : -1"
        :aria-selected="searchType === type.id"
        aria-controls="streaming-search-panel"
        :disabled="!availableSearchTypes.includes(type.id)"
        :class="{
          active: searchType === type.id,
          disabled: !availableSearchTypes.includes(type.id)
        }"
        @click="emit('update:searchType', type.id)"
      >
        {{ type.label }}
      </button>
    </div>
    <SearchScopeSelect
      :model-value="searchSource"
      :options="searchSources"
      @update:model-value="selectSource"
    />
  </div>
</template>
<style scoped src="./StreamingSearchControls.css"></style>
