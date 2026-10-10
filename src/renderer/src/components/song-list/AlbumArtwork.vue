<script setup lang="ts">
import CoverImg from '../CoverImg.vue'
import ThemeIcon from '../ThemeIcon.vue'

defineProps<{
  cover?: string | null
  coverSource?: string | null
  identity?: string
  name: string
  eager?: boolean
}>()
</script>

<template>
  <div class="album-artwork">
    <CoverImg
      :cover="cover"
      :cover-source="coverSource"
      :identity="identity"
      :alt="`${name}专辑封面`"
      :loading="eager ? 'eager' : 'lazy'"
      class="album-artwork-image"
    >
      <template #placeholder>
        <div class="album-artwork-placeholder" role="img" :aria-label="`${name}暂无封面`">
          <span class="album-artwork-disc" aria-hidden="true"
            ><ThemeIcon icon-slot="library.album"
          /></span>
        </div>
      </template>
    </CoverImg>
  </div>
</template>

<style scoped>
.album-artwork {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 14px;
  background: var(--te-card-bg);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
}
.album-artwork-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.album-artwork-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--te-primary-500) 9%, var(--te-card-bg)),
    var(--te-card-bg)
  );
}
.album-artwork-disc {
  width: 58%;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--te-neutral-500) 22%, transparent);
  background: repeating-radial-gradient(
    circle,
    transparent 0 5px,
    color-mix(in srgb, var(--te-neutral-500) 5%, transparent) 6px 7px
  );
  color: var(--te-neutral-500);
  font-size: 28px;
}
.album-artwork-disc :deep(svg) {
  width: 28px;
  height: 28px;
}
</style>
