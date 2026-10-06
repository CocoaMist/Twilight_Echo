<script setup lang="ts">
import { useSettingsStore } from '@renderer/stores/useSettingsStore'

const props = defineProps<{
  watchLibrary: boolean
  autoAnalyzeBpm: boolean
  onlineLyricsFallback: boolean
}>()
const emit = defineEmits<{
  'update:watchLibrary': [value: boolean]
  'update:autoAnalyzeBpm': [value: boolean]
  'update:onlineLyricsFallback': [value: boolean]
}>()

const { settings, addLibraryFolder, removeLibraryFolder } = useSettingsStore()

function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}
</script>

<template>
  <section class="onb-stage" data-scene="03">
    <p class="onb-kicker">本地曲库</p>
    <h1 class="onb-title">你的音乐<em>放在哪里</em>？</h1>
    <div class="onb-panel">
      <button type="button" class="onb-folder-add" @click="() => void addLibraryFolder()">
        <i class="ph ph-folder-plus"></i>
        添加音乐文件夹
      </button>
      <div
        v-for="folder in settings.libraryFolders"
        :key="folder"
        class="onb-folder-row"
        :title="folder"
      >
        <i class="ph ph-folder-notch"></i>
        <strong>{{ folderName(folder) }}</strong>
        <span class="onb-folder-path">{{ folder }}</span>
        <button
          type="button"
          class="onb-folder-remove"
          :aria-label="`移除 ${folderName(folder)}`"
          @click="() => void removeLibraryFolder(folder)"
        >
          <i class="ph ph-x"></i>
        </button>
      </div>
    </div>
    <div class="onb-panel">
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>自动同步文件夹变化</strong>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.watchLibrary }"
          role="switch"
          :aria-checked="props.watchLibrary"
          aria-label="自动同步文件夹变化"
          @click="emit('update:watchLibrary', !props.watchLibrary)"
        ></button>
      </div>
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>后台分析 BPM 与响度</strong>
          <span>用于智能歌单和音量匹配。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.autoAnalyzeBpm }"
          role="switch"
          :aria-checked="props.autoAnalyzeBpm"
          aria-label="后台分析 BPM 与响度"
          @click="emit('update:autoAnalyzeBpm', !props.autoAnalyzeBpm)"
        ></button>
      </div>
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>缺歌词时联网补齐</strong>
          <span>本地缺少歌词时联网搜索。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.onlineLyricsFallback }"
          role="switch"
          :aria-checked="props.onlineLyricsFallback"
          aria-label="缺歌词时联网补齐"
          @click="emit('update:onlineLyricsFallback', !props.onlineLyricsFallback)"
        ></button>
      </div>
    </div>
  </section>
</template>
