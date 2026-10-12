<script setup lang="ts">
import { computed, ref } from 'vue'
import { resolvePlayerBarPresentation } from '../../../../../shared/playerBar.ts'
import type {
  MiniPlayerSettings,
  PlayerBarMode,
  PlayerBarSettings,
  PlayerBarVisibility
} from '@renderer/types/settings'

const props = defineProps<{
  playerBar: PlayerBarSettings
  miniPlayer: MiniPlayerSettings
  openOnFinish: boolean
}>()

const editingPage = ref<'home' | 'playing'>('home')
const presentation = computed(() =>
  resolvePlayerBarPresentation(props.playerBar, { onPlayingPage: editingPage.value === 'playing' })
)
const activeMode = computed(() => presentation.value.mode)
const activeVisibility = computed<PlayerBarVisibility>(() =>
  presentation.value.hidden ? 'hidden' : presentation.value.autoHide ? 'autoHide' : 'visible'
)
const emit = defineEmits<{
  'update:playerBar': [value: PlayerBarSettings]
  'update:miniPlayer': [value: MiniPlayerSettings]
  'update:openOnFinish': [value: boolean]
}>()

const modeOptions: { value: PlayerBarMode; title: string; desc: string; icon: string }[] = [
  {
    value: 'standard',
    title: '标准播放栏',
    desc: '封面、进度与全部控制都在主窗口底部',
    icon: 'ph ph-sliders-horizontal'
  },
  {
    value: 'mini',
    title: '迷你胶囊',
    desc: '胶囊形播放控制',
    icon: 'ph ph-minus-square'
  },
  {
    value: 'compact',
    title: '紧凑模式',
    desc: '贴边播放控制',
    icon: 'ph ph-rows'
  }
]

const visibilityOptions: { value: PlayerBarVisibility; label: string; hint: string }[] = [
  { value: 'visible', label: '常显', hint: '播放控制始终可见' },
  { value: 'autoHide', label: '指针靠近时浮现', hint: '适合迷你胶囊与紧凑模式' },
  { value: 'hidden', label: '隐藏播放栏', hint: '之后可从设置中恢复' }
]

function setMode(mode: PlayerBarMode): void {
  if (editingPage.value === 'playing') {
    emit('update:playerBar', {
      ...props.playerBar,
      playingPageMode: mode,
      playingPageVisibility:
        mode === 'standard' && activeVisibility.value === 'autoHide'
          ? 'visible'
          : props.playerBar.playingPageVisibility
    })
    return
  }
  emit('update:playerBar', {
    ...props.playerBar,
    mode,
    modeSource: 'user',
    // The standard bar's inline progress is the only progress readout it has;
    // auto-hide would silently take that information away, so keep it safe.
    visibility:
      mode === 'standard' && props.playerBar.visibility === 'autoHide'
        ? 'visible'
        : props.playerBar.visibility
  })
}

function setVisibility(visibility: PlayerBarVisibility): void {
  emit('update:playerBar', {
    ...props.playerBar,
    [editingPage.value === 'playing' ? 'playingPageVisibility' : 'visibility']: visibility
  })
}

function updateMiniPlayer(patch: Partial<MiniPlayerSettings>): void {
  emit('update:miniPlayer', { ...props.miniPlayer, ...patch })
}
</script>

<template>
  <section class="onb-stage" data-scene="05">
    <p class="onb-kicker">播放器形态</p>
    <h1 class="onb-title">选择<em>播放控制</em>的位置</h1>
    <p class="onb-subtitle">主页和播放页可以分别设置，选择会在完成引导时保存。</p>

    <div class="onb-segmented is-small" role="radiogroup" aria-label="设置页面">
      <button
        type="button"
        role="radio"
        :aria-checked="editingPage === 'home'"
        :class="{ 'is-selected': editingPage === 'home' }"
        @click="editingPage = 'home'"
      >
        主页
      </button>
      <button
        type="button"
        role="radio"
        :aria-checked="editingPage === 'playing'"
        :class="{ 'is-selected': editingPage === 'playing' }"
        @click="editingPage = 'playing'"
      >
        播放页
      </button>
    </div>
    <div
      class="onb-cards onb-player-shape-cards has-selection"
      role="radiogroup"
      aria-label="播放栏形态"
    >
      <button
        v-for="option in modeOptions"
        :key="option.value"
        type="button"
        class="onb-card"
        :class="{ 'is-selected': activeMode === option.value }"
        role="radio"
        :aria-checked="activeMode === option.value"
        @click="setMode(option.value)"
      >
        <span v-if="activeMode === option.value" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon" :class="option.icon"></i>
        <span class="onb-card-title">{{ option.title }}</span>
        <span class="onb-card-desc">{{ option.desc }}</span>
      </button>
    </div>

    <div class="onb-panel onb-visibility-panel">
      <div class="onb-toggle-copy">
        <strong>播放栏可见性</strong>
        <span>{{ editingPage === 'home' ? '主页' : '播放页' }}的播放控制什么时候出现。</span>
      </div>
      <div class="onb-segmented is-small" role="radiogroup" aria-label="播放栏可见性">
        <button
          v-for="option in visibilityOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-selected': activeVisibility === option.value }"
          role="radio"
          :aria-checked="activeVisibility === option.value"
          :disabled="option.value === 'autoHide' && activeMode === 'standard'"
          :title="
            option.value === 'autoHide' && activeMode === 'standard'
              ? '标准播放栏保持常显，请选择迷你或紧凑模式体验浮现'
              : option.hint
          "
          @click="setVisibility(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <details class="onb-panel onb-player-extras">
      <summary>
        <span><strong>独立迷你播放器选项</strong><small>任务栏、置顶与完成后打开</small></span>
        <i class="ph ph-caret-down" aria-hidden="true"></i>
      </summary>
      <div class="onb-player-extras-content">
        <div class="onb-toggle-row">
          <div class="onb-toggle-copy">
            <strong>迷你播放器显示在任务栏</strong>
            <span>开启时像独立小应用一样可从任务栏切换；关闭后仅作为悬浮窗口存在。</span>
          </div>
          <button
            type="button"
            class="onb-toggle"
            :class="{ 'is-on': props.miniPlayer.showInTaskbar }"
            role="switch"
            :aria-checked="props.miniPlayer.showInTaskbar"
            aria-label="迷你播放器显示在任务栏"
            @click="updateMiniPlayer({ showInTaskbar: !props.miniPlayer.showInTaskbar })"
          ></button>
        </div>
        <div class="onb-toggle-row">
          <div class="onb-toggle-copy">
            <strong>迷你播放器置顶</strong>
            <span>让控制按钮浮在其他窗口之上，切工作时也能快速暂停。</span>
          </div>
          <button
            type="button"
            class="onb-toggle"
            :class="{ 'is-on': props.miniPlayer.alwaysOnTop }"
            role="switch"
            :aria-checked="props.miniPlayer.alwaysOnTop"
            aria-label="迷你播放器置顶"
            @click="updateMiniPlayer({ alwaysOnTop: !props.miniPlayer.alwaysOnTop })"
          ></button>
        </div>
        <div class="onb-toggle-row">
          <div class="onb-toggle-copy">
            <strong>完成后打开迷你播放器</strong>
            <span>向导结束后直接进入轻量控制模式，主窗口暂时收起。</span>
          </div>
          <button
            type="button"
            class="onb-toggle"
            :class="{ 'is-on': props.openOnFinish }"
            role="switch"
            :aria-checked="props.openOnFinish"
            aria-label="完成后打开迷你播放器"
            @click="emit('update:openOnFinish', !props.openOnFinish)"
          ></button>
        </div>
      </div>
    </details>

    <p class="onb-hint">这些选择都可以在 设置 → 外观 / 播放栏 中随时修改。</p>
  </section>
</template>
