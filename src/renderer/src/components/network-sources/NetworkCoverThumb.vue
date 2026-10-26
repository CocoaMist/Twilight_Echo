<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'

const props = defineProps<{
  profileId: string
  entryId: string
}>()

const src = ref('')
const core = useCoreConnection()

onMounted(async () => {
  const result = await core.query('network.cover', {
    profileId: props.profileId,
    entryId: props.entryId
  })
  if (result) src.value = result
})
</script>

<template>
  <img v-if="src" :src="src" class="network-cover-thumb" alt="" loading="lazy" />
  <span v-else class="network-cover-placeholder"><i class="pi pi-music"></i></span>
</template>

<style scoped>
.network-cover-thumb {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  object-fit: cover;
}

.network-cover-placeholder {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
</style>
