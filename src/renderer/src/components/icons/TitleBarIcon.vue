<script setup lang="ts">
const icons = {
  navigation: 'list',
  search: 'magnifying-glass',
  settings: 'gear',
  puzzle_piece: 'puzzle-piece',
  arrow_left: 'arrow-left',
  person: 'user'
} as const

defineProps<{ name: keyof typeof icons }>()
</script>

<template>
  <i class="title-bar-icon ph" :class="`ph-${icons[name]}`" aria-hidden="true"></i>
</template>

<style scoped>
.title-bar-icon {
  display: block;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  font-size: 16px;
}
</style>
