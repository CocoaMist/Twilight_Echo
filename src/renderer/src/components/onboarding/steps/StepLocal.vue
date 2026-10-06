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
    <p class="onb-subtitle">
      选择存放音乐的文件夹，Twilight Echo 会在后台扫描并整理曲目、封面与元数据。
    </p>
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
          <span>新增或删除音乐时自动更新曲库，无需手动刷新。</span>
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
          <span>在空闲时分析曲目节奏与响度，用于智能歌单与音量匹配。</span>
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
          <span>本地文件没有歌词时，可从在线歌词库搜索；关闭后完全不发起该请求。</span>
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
    <p class="onb-hint">也可以先跳过，之后在 设置 → 通用 中添加。</p>
  </section>
</template>
