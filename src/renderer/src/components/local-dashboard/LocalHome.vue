<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted } from 'vue'
import { useThemeStore } from '@renderer/stores/useThemeStore'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import type { StreamingPageTab } from '@renderer/app/navigationPages'
import { createLibraryHomeStatus } from '@renderer/stores/library/libraryHomeStatus.ts'

const OnlineDashboard = defineAsyncComponent(() => import('./OnlineDashboard.vue'))
const props = defineProps<{ preview?: boolean }>()
const { tracks } = useMusicStore()
const home = createLibraryHomeStatus({
  getStorageMode: () => window.api.library.getStorageMode(),
  api: { getMetadata: () => window.api.library.database.getMetadata() }
})
const homeState = home.state
const emptyLibrary = computed(() =>
  homeState.value.mode === 'json'
    ? tracks.value.length === 0
    : homeState.value.mode === 'sqlite' && homeState.value.total === 0
)
const homePending = computed(
  () =>
    !props.preview &&
    !homeState.value.error &&
    (homeState.value.mode === null ||
      (homeState.value.mode === 'sqlite' && homeState.value.total === null))
)
let unsubscribe: (() => void) | undefined
onMounted(() => {
  if (props.preview) return
  unsubscribe = window.api.library.onChanged((change) => {
    home.refresh(change?.kind === 'scan' ? change.update.libraryRevision : change?.revision)
  })
  home.refresh()
})
onBeforeUnmount(() => {
  unsubscribe?.()
  home.dispose()
})

const LocalDashboard = defineAsyncComponent(() => import('@renderer/components/LocalDashboard.vue'))
const ArchiveDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/ArchiveDashboard.vue')
)
const NightHarborDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/NightHarborDashboard.vue')
)
const SoundFieldDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/SoundFieldDashboard.vue')
)
const { presetLayout } = useThemeStore()

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
  'open-streaming': [tab: StreamingPageTab]
  'open-plugins': []
  'open-radio': []
  login: [providerId: string]
}>()
</script>

<template>
  <div class="local-home-layout">
    <section
      v-if="!preview && (homePending || homeState.error)"
      class="home-status"
      role="status"
      aria-live="polite"
    >
      <span>{{ homeState.error || '正在读取音乐库…' }}</span>
      <button v-if="homeState.error" type="button" @click="home.refresh()">重试</button>
    </section>
    <OnlineDashboard
      v-else-if="!preview && emptyLibrary"
      @select-view="(category, filter) => emit('select-view', category, filter)"
      @open-library-settings="emit('open-library-settings')"
      @open-streaming="emit('open-streaming', $event)"
      @open-plugins="emit('open-plugins')"
      @open-radio="emit('open-radio')"
      @login="emit('login', $event)"
    />
    <component
      v-else
      :is="
        presetLayout === 'aurora-reference'
          ? ArchiveDashboard
          : presetLayout === 'obsidian-glass'
            ? NightHarborDashboard
            : presetLayout === 'paper-light'
              ? SoundFieldDashboard
              : LocalDashboard
      "
      @select-view="
        (category: string, filter: string | null) => emit('select-view', category, filter)
      "
      @open-library-settings="emit('open-library-settings')"
    />
  </div>
</template>

<style scoped>
.local-home-layout {
  --te-home-titlebar-clearance: var(--te-titlebar-inset, 35px);
  width: 100%;
  height: 100%;
  min-width: 0;
}
.home-status {
  padding: calc(var(--te-home-titlebar-clearance) + 24px) 24px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--te-text-primary);
}
.home-status button {
  padding: 8px 16px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-bg-secondary);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
/* Custom shells already place content below their titlebar grid row. */
:global(html[data-te-shell-layout='custom']) .local-home-layout {
  --te-home-titlebar-clearance: 0px;
}
</style>
