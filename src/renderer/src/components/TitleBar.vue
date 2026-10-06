<script setup lang="ts">
import { defineAsyncComponent, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useBackStack } from '../app/useBackStack'
import { useNcmStore } from '../stores/useNcmStore'
import TitleBarIcon from './icons/TitleBarIcon.vue'
import { useWindowChrome } from '../app/useWindowChrome'

const TaskCenter = defineAsyncComponent(() => import('./TaskCenter.vue'))

const props = withDefaults(
  defineProps<{
    menuOpen: boolean
    glass?: boolean
    liquidMaterial?: boolean
    streaming?: boolean
    hideStart?: boolean
    titleSurface?: 'default' | 'settings' | 'streaming'
    activeTool?: 'settings' | 'plugins' | null
    preview?: boolean
  }>(),
  {
    titleSurface: 'default'
  }
)

defineEmits<{
  toggleMenu: []
  collapseMenu: []
  back: []
  login: [providerId?: string | null]
  settings: []
  plugins: []
  commands: []
  library: []
}>()

const { isLoggedIn, profile } = useNcmStore()
const { canGoBack, backHint } = useBackStack()
const { maximized } = useWindowChrome(() => props.preview === true)
const avatarLoadFailed = ref(false)
watch([() => profile.value?.userId, () => profile.value?.avatarUrl], () => {
  avatarLoadFailed.value = false
})
const titleBar = ref<HTMLElement | null>(null)
let titleObserver: ResizeObserver | undefined
onMounted(() => {
  if (props.preview) return
  const updateInset = (): void => {
    if (titleBar.value)
      titleBar.value.ownerDocument.documentElement.style.setProperty(
        '--te-titlebar-inset',
        `${titleBar.value.getBoundingClientRect().bottom}px`
      )
  }
  titleObserver = new ResizeObserver(updateInset)
  if (titleBar.value) titleObserver.observe(titleBar.value)
  updateInset()
})
onBeforeUnmount(() => titleObserver?.disconnect())

function setPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  button.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
}

function minimize(): void {
  if (props.preview) return
  window.api.window.minimize()
}

function toggleMaximize(): void {
  if (props.preview) return
  window.api.window.toggleMaximize()
}

function close(): void {
  if (props.preview) return
  window.api.window.close()
}
</script>

<template>
  <div
    class="title-bar"
    ref="titleBar"
    :class="{
      'drag-region': !preview,
      'no-drag': preview,
      'title-bar-glass': glass,
      'title-bar-liquid': liquidMaterial,
      'title-bar-settings': titleSurface === 'settings',
      'title-bar-streaming': titleSurface === 'streaming',
      'title-bar-menu-open': menuOpen
    }"
  >
    <div class="title-bar-background" aria-hidden="true"></div>
    <!-- Keep the existing back affordance at the left edge, visible only while
         the active surface has a return handler. -->
    <div
      class="title-bar-back"
      :class="{
        'title-bar-back-visible': canGoBack && !preview,
        'no-drag': canGoBack && !preview
      }"
      :inert="!canGoBack || preview"
      @pointerdown="setPressOrigin"
    >
      <Transition name="title-back-fade">
        <button
          type="button"
          v-if="canGoBack && !preview"
          class="back-btn"
          :title="backHint ?? '返回'"
          aria-label="返回"
          @click="canGoBack && $emit('back')"
        >
          <TitleBarIcon name="arrow_left" />
        </button>
      </Transition>
    </div>
    <div v-if="!glass && !hideStart" class="title-bar-start no-drag" @pointerdown="setPressOrigin">
      <button
        type="button"
        aria-label="菜单"
        class="menu-btn"
        :title="menuOpen ? '收起导航' : '展开导航'"
        :aria-expanded="menuOpen"
        @click="$emit('toggleMenu')"
      >
        <TitleBarIcon name="navigation" />
      </button>
      <button
        type="button"
        class="settings-btn command-palette-trigger"
        title="命令面板 (Ctrl+K / ⌘K)"
        aria-label="打开命令面板"
        aria-keyshortcuts="Control+K Meta+K"
        @click="$emit('commands')"
      >
        <TitleBarIcon name="search" />
      </button>
      <button
        type="button"
        aria-label="设置"
        :aria-pressed="activeTool === 'settings'"
        class="settings-btn"
        title="设置"
        @click="$emit('settings')"
      >
        <TitleBarIcon name="settings" />
      </button>
      <button
        type="button"
        aria-label="扩展中心"
        :aria-pressed="activeTool === 'plugins'"
        class="plugins-btn"
        title="扩展中心"
        @click="$emit('plugins')"
      >
        <TitleBarIcon name="puzzle_piece" />
      </button>
      <button
        type="button"
        :aria-label="isLoggedIn ? profile?.nickname || '个人详情' : '网易云登录'"
        v-if="streaming"
        class="login-btn"
        :title="isLoggedIn ? profile?.nickname || '个人详情' : '网易云登录'"
        @click="$emit('login', 'ncm')"
      >
        <img
          v-if="isLoggedIn && profile?.avatarUrl && !avatarLoadFailed"
          :src="profile.avatarUrl"
          class="user-avatar"
          alt=""
          @error="avatarLoadFailed = true"
        />
        <TitleBarIcon v-else name="person" />
      </button>
    </div>
    <div class="title-bar-controls no-drag" @pointerdown="setPressOrigin">
      <TaskCenter v-if="!preview" @library="$emit('library')" />
      <button
        type="button"
        :disabled="preview"
        aria-label="最小化"
        class="control-btn minimize"
        title="最小化"
        @click="minimize"
      >
        <svg class="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 6.5h10" />
        </svg>
      </button>
      <button
        type="button"
        :aria-label="maximized ? '还原窗口' : '最大化窗口'"
        class="control-btn maximize"
        :title="maximized ? '还原窗口' : '最大化窗口'"
        :disabled="preview"
        @click="toggleMaximize"
      >
        <svg class="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path v-if="maximized" d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7Z" />
          <rect v-else x="1.5" y="1.5" width="9" height="9" />
        </svg>
      </button>
      <button
        type="button"
        :disabled="preview"
        class="control-btn close"
        title="关闭窗口"
        aria-label="关闭窗口"
        @click="close"
      >
        <svg class="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m1.5 1.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.settings-btn[aria-pressed='true'],
.plugins-btn[aria-pressed='true'] {
  background: var(--te-shell-control-hover);
  color: var(--te-primary-500);
}
.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--te-titlebar-height, 35px);
  flex-shrink: 0;
  background: transparent !important;
  user-select: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  overflow: hidden;
  border-bottom: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  isolation: isolate;
}

.title-bar-background {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  background: color-mix(in srgb, var(--te-app-bg) 92%, transparent) !important;
  box-shadow: inset 0 -1px 0 var(--te-navigation-border);
  backdrop-filter: blur(12px) saturate(115%);
  -webkit-backdrop-filter: blur(12px) saturate(115%);
}

.title-bar::before {
  display: none;
}

.title-bar-start {
  display: flex;
  flex-shrink: 0;
  height: 100%;
  position: relative;
  z-index: 1;
}

.title-bar-back {
  display: flex;
  align-items: center;
  width: 0;
  height: 100%;
  overflow: hidden;
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  transition: width 0.2s var(--te-ease-soft, ease);
}

.title-bar-back-visible {
  width: 36px;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  min-width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.back-btn:hover {
  background: var(--te-shell-control-hover);
}

.title-back-fade-enter-active,
.title-back-fade-leave-active {
  transition: opacity 0.18s ease;
}

.title-back-fade-enter-from,
.title-back-fade-leave-to {
  opacity: 0;
}

.title-bar-glass .back-btn {
  color: var(--te-shell-control-text);
}

.title-bar-glass .back-btn:hover {
  background: var(--te-shell-control-hover);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
}

.menu-btn:hover {
  background: var(--te-shell-control-hover);
}

.settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.settings-btn:hover {
  background: var(--te-shell-control-hover);
}

.plugins-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}

.plugins-btn:hover {
  background: var(--te-shell-control-hover);
}

.login-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.login-btn:hover {
  background: var(--te-shell-control-hover);
}

.user-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
}

.title-bar-glass .settings-btn {
  color: var(--te-shell-control-text);
}

.title-bar-glass .settings-btn:hover {
  background: var(--te-shell-control-hover);
}

.title-bar-glass .login-btn {
  color: var(--te-shell-control-text);
}

.title-bar-glass .login-btn:hover {
  background: var(--te-shell-control-hover);
}

.title-bar-controls {
  display: flex;
  flex-shrink: 0;
  height: 100%;
  margin-left: auto;
  position: relative;
  z-index: 1;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  min-width: 46px;
  height: 100%;
  flex-shrink: 0;
  border: none;
  border-radius: 0;
  padding: 0;
  background: transparent;
  color: var(--te-shell-control-text);
  font-size: calc(var(--te-font-size-body, 14px) * 16 / 14);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.3s,
    transform 0.24s var(--te-ease-soft);
}

.control-btn:active {
  transition-duration: 0.1s;
}

.control-btn:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: -2px;
}

.window-control-icon {
  display: block;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  stroke-linecap: butt;
  stroke-linejoin: miter;
}

.title-bar-glass .control-btn {
  color: var(--te-shell-control-text);
}

.title-bar-glass .control-btn:hover {
  background: var(--te-shell-control-hover);
}

.control-btn:hover {
  background: var(--te-shell-control-hover);
}

.control-btn.close:hover,
html[data-theme='pureWhite'] .title-bar .control-btn.close:hover,
.title-bar-liquid .control-btn.close:hover {
  background: #e81123;
  color: #fff;
}

.title-bar-liquid {
  color: var(--te-shell-control-text);
}

.title-bar-liquid :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn) {
  position: relative;
  overflow: hidden;
  color: inherit;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn)::after {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at var(--te-lg-press-x, 50%) var(--te-lg-press-y, 50%),
    color-mix(in srgb, var(--te-lg-context-rim) 56%, transparent),
    transparent 58%
  );
  content: '';
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease-out;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active {
  transform: scale(0.94);
  transition-duration: 90ms;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active::after {
  opacity: 1;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .title-bar-background {
    background: var(--te-app-bg) !important;
    border-bottom: 1px solid var(--te-shell-control-text);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .title-bar-background {
    background: Canvas !important;
    border-bottom: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

:global(body.te-no-blur .title-bar-background) {
  background: var(--te-app-bg) !important;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

@supports not (backdrop-filter: blur(12px)) {
  .title-bar-background {
    background: var(--te-app-bg) !important;
  }
}
</style>
