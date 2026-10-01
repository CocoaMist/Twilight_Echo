<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>
<template>
  <header class="hig-page-header">
    <div class="hig-page-heading">
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="hig-page-actions"><slot name="actions" /></div>
  </header>
</template>
