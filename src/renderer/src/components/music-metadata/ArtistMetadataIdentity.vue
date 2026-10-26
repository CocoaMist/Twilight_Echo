<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useSettingsStore } from '../../stores/useSettingsStore.ts'
import {
  createArtistIdentityView,
  artistIdentityPresentation,
  artistIdentityCache
} from './artistIdentityView.ts'
import type { EntityMetadataLanguage } from '../../../../shared/entityMetadata.ts'
import { artistProfileChoice, artistProfileChoices } from './artistProfileChoice.ts'

const props = defineProps<{ name: string; cover?: string | null; enabled: boolean }>()
const core = useCoreConnection(),
  settings = useSettingsStore()
const language = computed<EntityMetadataLanguage>(
  () => settings.settings.value.musicIdentification.language ?? 'zh-Hans'
)
const view = createArtistIdentityView({
  cache: artistIdentityCache(core),
  cacheScope: () =>
    JSON.stringify([
      core.state.value?.epoch,
      core.state.value?.phase,
      core.state.value?.settingsRevision,
      core.state.value?.entityMetadataRevision,
      core.state.value?.catalogRevision,
      core.state.value?.libraryRevision
    ]),
  choice: artistProfileChoice,
  identity: (entityId, signal) => core.query('identification.detail', { entityId }, signal),
  catalog: (query, signal) => core.query('catalog.query', query, signal),
  detail: (entityId, language, signal, shared) =>
    core.query(
      'metadata.entity.detail',
      { entityId, language, sourceProvider: 'local', includeAutomaticArtwork: shared },
      signal
    )
})
const now = ref(Date.now())
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () =>
    JSON.stringify([
      props.enabled,
      props.name,
      artistProfileChoices.value[props.name],
      language.value,
      core.state.value?.epoch,
      core.state.value?.phase,
      core.state.value?.settingsRevision
    ]),
  () => {
    void view.setContext(
      props.enabled && core.state.value?.phase === 'ready' ? props.name : null,
      language.value
    )
  },
  { immediate: true }
)
watch(
  () => [
    core.state.value?.entityMetadataRevision,
    core.state.value?.catalogRevision,
    core.state.value?.libraryRevision
  ],
  () => {
    void view.refresh()
  }
)
watch(
  view.detail,
  (detail) => {
    clearTimeout(timer)
    const expire = () => {
      now.value = Date.now()
      const future = [...(detail?.artwork ?? []), ...(detail?.facts ?? [])].flatMap((v) =>
        v.usage?.expiresAt !== undefined && v.usage.expiresAt > now.value ? [v.usage.expiresAt] : []
      )
      if (future.length)
        timer = setTimeout(
          expire,
          Math.min(2147483647, Math.max(1, Math.min(...future) - now.value))
        )
    }
    expire()
  },
  { immediate: true }
)
const presentation = computed(() =>
  props.enabled
    ? artistIdentityPresentation(view.detail.value, props, now.value)
    : { name: props.name, cover: props.cover ?? null, attribution: null }
)
onBeforeUnmount(() => {
  clearTimeout(timer)
  view.dispose()
})
</script>
<template>
  <slot v-bind="presentation" />
</template>
