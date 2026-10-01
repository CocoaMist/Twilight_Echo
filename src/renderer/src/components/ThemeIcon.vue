<script setup lang="ts">
import type { ThemeIconSlot } from '../../../shared/theme.ts'
import FluentIcon from './hig/FluentIcon.vue'
const props = defineProps<{ iconSlot: ThemeIconSlot }>()
const slots = {
  'navigation.home': 'home',
  'navigation.songs': 'music_note_2',
  'navigation.artists': 'mic',
  'navigation.albums': 'record',
  'navigation.genres': 'tag',
  'navigation.playlists': 'apps_list',
  'navigation.folders': 'folder_open',
  'navigation.recent': 'history',
  'navigation.streaming': 'globe',
  'navigation.radio': 'channel',
  'navigation.import': 'add',
  'navigation.plugin': 'puzzle_piece',
  'library.search': 'search',
  'library.clear': 'dismiss',
  'library.artist': 'mic',
  'library.album': 'record',
  'library.genre': 'tag',
  'library.playlist': 'apps_list',
  'library.folder': 'folder_open',
  'library.add': 'add',
  'library.play': 'play',
  'library.empty': 'music_note_2',
  'library.selected': 'checkmark',
  'library.playing': 'speaker_2',
  'library.filter': 'filter'
} as const
</script>
<template>
  <span class="theme-icon" :data-theme-icon-slot="props.iconSlot" aria-hidden="true"
    ><FluentIcon :name="slots[props.iconSlot]"
  /></span>
</template>
<style scoped>
.theme-icon {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  color: currentColor;
}
</style>
