<script setup lang="ts">
import type { CatalogEntity, CatalogPage } from '../../../../shared/musicCatalog.ts'
import { ARTIST_REFERENCE_PAGE_SIZE } from './artistDetailView.ts'
defineProps<{
  page: CatalogPage
  samples: Record<string, string>
  identities?: Record<string, string>
  selected: string | null
  shared: boolean
  loading: boolean
  exact: boolean
}>()
defineEmits<{ select: [entity: CatalogEntity]; page: [offset: number] }>()
</script>
<template>
  <section class="artist-reference-choices" aria-label="选择艺术家资料条目">
    <h3>选择资料条目</h3>
    <p>
      {{
        !exact
          ? '此分组包含多位参与者，请选择要查看的人物。'
          : shared
            ? '这些库内条目指向同一人物。选择条目可编辑它的专属资料。'
            : '此分组的人物身份尚未统一，请选择要查看的库内条目。'
      }}
    </p>
    <ul>
      <li v-for="entity in page.items" :key="entity.id">
        <button
          type="button"
          :disabled="loading"
          :aria-pressed="!shared && entity.id === selected"
          @click="$emit('select', entity)"
        >
          <strong>{{ entity.title }}</strong
          ><span>{{ samples[entity.id] || `${entity.sourceCount} 个库内音源` }}</span>
          <small v-if="identities?.[entity.id]">{{ identities[entity.id] }}</small>
        </button>
      </li>
    </ul>
    <nav v-if="page.total > ARTIST_REFERENCE_PAGE_SIZE" aria-label="艺术家资料条目分页">
      <button
        type="button"
        :disabled="loading || page.offset === 0"
        @click="$emit('page', page.offset - ARTIST_REFERENCE_PAGE_SIZE)"
      >
        上一页条目
      </button>
      <span>{{ page.offset + 1 }}–{{ page.offset + page.items.length }} / {{ page.total }}</span>
      <button
        type="button"
        :disabled="loading || page.offset + page.items.length >= page.total"
        @click="$emit('page', page.offset + ARTIST_REFERENCE_PAGE_SIZE)"
      >
        下一页条目
      </button>
    </nav>
  </section>
</template>
<style scoped>
.artist-reference-choices {
  padding-block: 16px;
}
h3 {
  margin: 0;
  font-size: 17px;
}
p {
  color: var(--te-neutral-500);
  font-size: var(--te-font-size-body, 14px);
  line-height: 1.7;
}
ul {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
  gap: 8px;
}
button {
  font: inherit;
  color: var(--te-neutral-900);
  background: var(--te-hover-bg);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
}
li button {
  display: grid;
  width: 100%;
  gap: 4px;
}
li span {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
  font-size: 13px;
}
button[aria-pressed='true'] {
  border-color: var(--te-primary-500);
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  font-size: 13px;
}
</style>
