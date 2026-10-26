<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import type {
  OnboardingChoices,
  OnboardingFinishAction,
  OnboardingStepId
} from '../useOnboardingFlow'
import { resolvePlayerBarPresentation } from '../../../../../shared/playerBar.ts'

const props = defineProps<{ choices: OnboardingChoices; saving: boolean }>()
const emit = defineEmits<{
  edit: [step: OnboardingStepId]
  start: [action: OnboardingFinishAction]
}>()

const { libraryTrackCount, libraryScanProgress } = useMusicStore()
const { settings, updateSettings } = useSettingsStore()
const { audioDevice, audioOutputDeviceOptions } = storeToRefs(useAudioOutputDspStore())
const lyricsBusy = ref(false)
const lyricsError = ref('')
const hasLocal = computed(() => props.choices.usage !== 'streaming')
const hasStreaming = computed(() => props.choices.usage !== 'local')
const deviceLabel = computed(
  () =>
    audioOutputDeviceOptions.value.find((device) => device.id === audioDevice.value)?.label ??
    '系统默认输出'
)
const barLabels = { standard: '标准播放栏', mini: '迷你胶囊', compact: '紧凑模式' }
const homeBar = computed(() =>
  resolvePlayerBarPresentation(props.choices.playerBar, { onPlayingPage: false })
)
const playingBar = computed(() =>
  resolvePlayerBarPresentation(props.choices.playerBar, { onPlayingPage: true })
)
const visibilityLabels = { visible: '常显', autoHide: '靠近时浮现', hidden: '隐藏' }
const closeLabels = { quit: '直接退出', tray: '进入托盘', miniPlayer: '切换迷你播放器' }
const themeLabels = { system: '跟随系统', pureWhite: '浅色', dark: '深色' }
const nextText = computed(() => {
  if (hasStreaming.value && props.choices.wantsStreamingLogin)
    return '保存后打开网易云登录页，连接你的歌单与收藏。'
  if (hasStreaming.value && props.choices.wantsPluginMarket)
    return '保存后打开扩展中心，查找更多音乐来源。'
  if (props.choices.openMiniPlayerOnFinish) return '保存后打开迷你播放器，主窗口收起。'
  if (!hasLocal.value) return '保存后进入在线音乐，随时可以从标题栏登录。'
  return settings.value.libraryFolders.length > 0
    ? '保存后打开本地曲库；扫描与分析会继续在后台进行。'
    : '保存后进入主页，之后可在曲库中添加音乐文件夹。'
})

// Live first-scan feedback: folders picked on the local step start scanning in
// the background, so by the finish scene the library is often already filling.
const scanText = computed(() => {
  const progress = libraryScanProgress.value
  if (progress) {
    if (progress.phase === 'enumerating') return `正在整理曲库…发现 ${progress.total} 个文件`
    return `正在整理曲库…${progress.current} / ${progress.total}`
  }
  const count = libraryTrackCount.value
  if (count > 0) return `曲库已就绪，共 ${count} 首`
  return ''
})

const desktopLyricsOn = computed(() => settings.value.desktopLyrics.enabled)

async function toggleDesktopLyrics(): Promise<void> {
  if (lyricsBusy.value) return
  lyricsBusy.value = true
  lyricsError.value = ''
  try {
    const enabled = await window.api.desktopLyrics.setEnabled(!settings.value.desktopLyrics.enabled)
    await updateSettings({ desktopLyrics: { ...settings.value.desktopLyrics, enabled } })
  } catch (error) {
    lyricsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    lyricsBusy.value = false
  }
}
</script>

<template>
  <section class="onb-stage" data-scene="08">
    <div class="onb-notes" aria-hidden="true">
      <i class="ph ph-music-note"></i>
      <i class="ph ph-music-notes"></i>
      <i class="ph ph-music-note-simple"></i>
      <i class="ph ph-music-notes-simple"></i>
      <i class="ph ph-music-note"></i>
      <i class="ph ph-music-notes"></i>
    </div>
    <div class="onb-eq" aria-hidden="true">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <p class="onb-kicker">你的聆听设置</p>
    <h1 class="onb-title">准备<em>开始</em></h1>
    <p class="onb-subtitle">确认这些选择，点击卡片右上角可返回修改。</p>
    <p v-if="hasLocal && scanText" class="onb-scan-status" role="status">
      <i class="ph ph-vinyl-record"></i>
      {{ scanText }}
    </p>
    <div class="onb-panel onb-summary">
      <div v-if="hasLocal" class="onb-summary-item" :class="{ 'is-wide': !hasStreaming }">
        <div class="onb-summary-heading">
          <span><i class="ph ph-folder-notch"></i> 本地曲库</span
          ><button type="button" :disabled="saving" @click="emit('edit', 'local')">修改</button>
        </div>
        <strong>{{
          settings.libraryFolders.length
            ? `${settings.libraryFolders.length} 个音乐文件夹`
            : '尚未添加音乐文件夹'
        }}</strong>
        <ul v-if="settings.libraryFolders.length" class="onb-summary-folders">
          <li v-for="folder in settings.libraryFolders.slice(0, 2)" :key="folder" :title="folder">
            {{ folder }}
          </li>
        </ul>
        <small v-if="settings.libraryFolders.length > 2"
          >另有 {{ settings.libraryFolders.length - 2 }} 个文件夹，可返回查看</small
        >
        <small v-if="!settings.libraryFolders.length">可以先进入主页，稍后再添加。</small>
      </div>
      <div v-if="hasStreaming" class="onb-summary-item">
        <div class="onb-summary-heading">
          <span><i class="ph ph-cloud"></i> 在线音乐</span
          ><button type="button" :disabled="saving" @click="emit('edit', 'streaming')">修改</button>
        </div>
        <strong>网易云音乐</strong
        ><small>{{ choices.wantsStreamingLogin ? '完成后登录' : '稍后登录' }}</small>
      </div>
      <div class="onb-summary-item">
        <div class="onb-summary-heading">
          <span><i class="ph ph-palette"></i> 外观</span
          ><button type="button" :disabled="saving" @click="emit('edit', 'welcome')">修改</button>
        </div>
        <strong>{{ themeLabels[settings.theme] }}</strong
        ><small>{{
          settings.appBackground.global.kind === 'image' ? '自定义背景图片' : '纯色背景'
        }}</small>
      </div>
      <div class="onb-summary-item">
        <div class="onb-summary-heading">
          <span><i class="ph ph-sliders-horizontal"></i> 播放控制</span
          ><button type="button" :disabled="saving" @click="emit('edit', 'player')">修改</button>
        </div>
        <strong
          >主页 · {{ barLabels[homeBar.mode] }} ·
          {{
            visibilityLabels[homeBar.hidden ? 'hidden' : homeBar.autoHide ? 'autoHide' : 'visible']
          }}</strong
        ><small
          >播放页 · {{ barLabels[playingBar.mode] }} ·
          {{
            visibilityLabels[
              playingBar.hidden ? 'hidden' : playingBar.autoHide ? 'autoHide' : 'visible'
            ]
          }}</small
        >
      </div>
      <div class="onb-summary-item">
        <div class="onb-summary-heading">
          <span><i class="ph ph-speaker-high"></i> 声音输出</span
          ><button type="button" :disabled="saving" @click="emit('edit', 'audio')">修改</button>
        </div>
        <strong :title="deviceLabel">{{ deviceLabel }}</strong
        ><small>{{ choices.audioExclusiveMode ? 'HiFi 独占' : '兼容模式' }}</small>
      </div>
      <div class="onb-summary-item">
        <div class="onb-summary-heading">
          <span><i class="ph ph-desktop"></i> 关闭窗口</span
          ><button type="button" :disabled="saving" @click="emit('edit', 'system')">修改</button>
        </div>
        <strong>{{ closeLabels[choices.closeWindowBehavior] }}</strong
        ><small>{{
          choices.playbackResumeMode === 'off'
            ? '不恢复播放进度'
            : choices.playbackResumeMode === 'track'
              ? '记住上次曲目'
              : '记住曲目与播放位置'
        }}</small>
      </div>
    </div>
    <p class="onb-next-copy">{{ nextText }}</p>
    <div class="onb-feature-grid">
      <button
        type="button"
        class="onb-feature is-action"
        :class="{ 'is-on': desktopLyricsOn }"
        role="switch"
        :aria-checked="desktopLyricsOn"
        :disabled="saving || lyricsBusy"
        @click="() => void toggleDesktopLyrics()"
      >
        <i class="ph ph-microphone-stage"></i>
        桌面歌词
        <span class="onb-feature-state">{{ desktopLyricsOn ? '已开启' : '点击开启' }}</span>
      </button>
      <button
        v-if="choices.usage === 'both'"
        type="button"
        class="onb-btn-ghost"
        :disabled="saving"
        @click="emit('start', 'streaming')"
      >
        先打开在线音乐 <i class="ph ph-arrow-up-right"></i>
      </button>
    </div>
    <p v-if="lyricsError" class="onb-save-error" role="alert">{{ lyricsError }}</p>
  </section>
</template>
