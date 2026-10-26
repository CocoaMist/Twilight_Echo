<script setup lang="ts">
import type { MusicExternalReference } from '../../../../shared/musicIdentification.ts'
import { musicBrainzReferenceUrl } from './musicCreditsView.ts'
defineProps<{ references: MusicExternalReference[] }>()
function open(reference: MusicExternalReference) {
  const url = musicBrainzReferenceUrl(reference)
  if (url) void window.api.shell.openExternal(url)
}
</script>
<template>
  <ul class="identity-references">
    <li v-for="reference in references" :key="JSON.stringify(reference)">
      <span>{{ reference.provider }} · {{ reference.idType }}：</span>
      <a
        v-if="musicBrainzReferenceUrl(reference)"
        :href="musicBrainzReferenceUrl(reference)!"
        @click.prevent="open(reference)"
        >{{ reference.value }}</a
      >
      <span v-else>{{ reference.value }}</span>
    </li>
  </ul>
</template>
<style scoped>
.identity-references {
  list-style: none;
  padding: 0;
  margin: 8px 0;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
a {
  color: var(--te-primary-600);
}
a:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
</style>
