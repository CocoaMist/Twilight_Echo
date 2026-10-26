<script setup lang="ts">
import type { MetadataAttribution as Attribution } from '../../../../shared/entityMetadata.ts'
import MetadataAttribution from './MetadataAttribution.vue'
defineProps<{ attribution: Attribution }>()
</script>
<template>
  <details class="artist-image-credit" @click.stop @keydown.stop>
    <summary aria-label="歌手图片来源与许可" title="图片来源与许可">ⓘ</summary>
    <div class="artist-image-credit-content">
      <MetadataAttribution :attribution="attribution" />
    </div>
  </details>
</template>
<style scoped>
.artist-image-credit {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 2;
}
.artist-image-credit[open] {
  left: 8px;
  right: 8px;
}
summary {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  cursor: pointer;
  color: #fff;
  background: #252332d9;
  list-style: none;
  margin-left: auto;
}
summary::-webkit-details-marker {
  display: none;
}
summary:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.artist-image-credit-content {
  margin-top: 6px;
  max-height: 180px;
  overflow: auto;
  padding: 12px;
  border-radius: 10px;
  background: var(--te-app-bg);
  box-shadow: 0 4px 20px #0003;
  font-size: 12px;
  text-align: left;
}
</style>
