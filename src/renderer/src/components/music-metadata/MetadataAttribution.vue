<script setup lang="ts">
import type { MetadataAttribution } from '../../../../shared/entityMetadata.ts'
import { metadataExternalUrl } from './entityMetadataView.ts'
defineProps<{ attribution: MetadataAttribution }>()
function open(url: string) {
  const safe = metadataExternalUrl(url)
  if (safe) void window.api.shell.openExternal(safe)
}
</script>
<template>
  <span class="metadata-source">
    <a
      v-if="metadataExternalUrl(attribution.url)"
      :href="metadataExternalUrl(attribution.url)!"
      @click.prevent="open(attribution.url)"
      >{{ attribution.provider }}</a
    >
    <span v-else>{{ attribution.provider }}</span>
    <span> · {{ attribution.attribution }} · </span>
    <a
      v-if="metadataExternalUrl(attribution.licenseUrl)"
      :href="metadataExternalUrl(attribution.licenseUrl)!"
      @click.prevent="open(attribution.licenseUrl)"
      >{{ attribution.license }}</a
    >
    <span v-else>{{ attribution.license }}</span>
    <span v-if="attribution.revision"> · 版本 {{ attribution.revision }}</span>
  </span>
</template>
<style scoped>
.metadata-source {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
  line-height: 1.6;
}
a {
  color: var(--te-primary-600);
}
a:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
</style>
