<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePluginFlyout } from '../stores/usePluginFlyout'
import { useExtensionRegistry } from '../extensions/registry.ts'
import { createExperienceBridge } from '../extensions/experienceBridge'

/**
 * Right-side flyout hosting a plugin panel experience. Deliberately does NOT
 * reuse ExperienceView: that component is built for the full-interface mode —
 * it teleports a fixed full-window surface and marks the app shell inert.
 * A flyout must keep the main interface live, so this mounts its own sandboxed
 * iframe and speaks the same bridge-v2 handshake directly.
 */
const flyout = usePluginFlyout()
const { experiences } = useExtensionRegistry({ listen: false })
const target = computed(() => flyout.target.value)
const experience = computed(
  () =>
    (experiences.value ?? []).find(
      (entry) => entry.pluginId === target.value?.pluginId && entry.launch === 'panel'
    ) ?? null
)

const frame = ref<HTMLIFrameElement>()
const ready = ref(false)
const error = ref('')
let dispose: (() => void) | undefined
let deadline: ReturnType<typeof setTimeout> | undefined

function handshake(event: MessageEvent): void {
  if (
    event.source !== frame.value?.contentWindow ||
    event.origin !== `plugin-ui://${experience.value?.pluginId}`
  )
    return
  if (event.data?.type !== 'twilight-experience-ready') return
  if ((event.data.bridgeVersion ?? 1) !== experience.value?.bridgeVersion) {
    error.value = '界面桥接版本不匹配，请更新插件或宿主。'
    return
  }
  const channel = new MessageChannel()
  dispose?.()
  dispose = createExperienceBridge(experience.value!, channel.port1, () => flyout.close(), () => {})
  event.source?.postMessage(
    { type: 'twilight-experience-connect', bridgeVersion: experience.value!.bridgeVersion },
    { targetOrigin: event.origin, transfer: [channel.port2] }
  )
  ready.value = true
  error.value = ''
  clearTimeout(deadline)
}

function frameLoaded(): void {
  clearTimeout(deadline)
  if (ready.value) return
  deadline = setTimeout(() => {
    if (!ready.value) error.value = '面板未能连接，请关闭后重试。'
  }, 20000)
}

// Closing or switching panels remounts the iframe; drop the stale session.
watch([target, experience], () => {
  clearTimeout(deadline)
  dispose?.()
  dispose = undefined
  ready.value = false
  error.value = ''
})

onMounted(() => window.addEventListener('message', handshake))
onBeforeUnmount(() => {
  clearTimeout(deadline)
  dispose?.()
  window.removeEventListener('message', handshake)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="target && experience" class="experience-flyout" role="dialog" aria-label="插件面板">
      <div class="experience-flyout-backdrop" @click="flyout.close()"></div>
      <section class="experience-flyout-panel">
        <header class="experience-flyout-header">
          <span class="experience-flyout-title">{{ target.title }}</span>
          <button
            type="button"
            class="experience-flyout-close"
            aria-label="关闭面板"
            title="关闭面板"
            @click="flyout.close()"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3.5 3.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </header>
        <div class="experience-flyout-body">
          <iframe
            ref="frame"
            :src="experience.url"
            :title="target.title"
            sandbox="allow-scripts allow-same-origin"
            @load="frameLoaded"
          ></iframe>
          <div v-if="error" class="experience-flyout-error" role="alert">{{ error }}</div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.experience-flyout {
  position: fixed;
  inset: 0;
  z-index: 9500;
  pointer-events: none;
}

.experience-flyout-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  background: rgb(0 0 0 / 28%);
}

.experience-flyout-panel {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(420px, 94vw);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  background: var(--te-app-bg, #141418);
  border-left: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  box-shadow: -18px 0 48px rgb(0 0 0 / 38%);
  animation: experience-flyout-in 0.22s var(--te-ease-soft, ease-out);
}

@keyframes experience-flyout-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.experience-flyout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 40px;
  min-height: 40px;
  padding: 0 4px 0 16px;
  font-family: var(--te-font-sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--te-shell-control-text, #e8e8ee);
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}

.experience-flyout-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.experience-flyout-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.experience-flyout-close:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.experience-flyout-close svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

.experience-flyout-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

.experience-flyout-body iframe {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
}

.experience-flyout-error {
  position: absolute;
  inset: auto 16px 16px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgb(0 0 0 / 55%);
  color: #f0b34c;
  font-size: 12.5px;
  font-family: var(--te-font-sans);
}

@media (prefers-reduced-motion: reduce) {
  .experience-flyout-panel {
    animation: none;
  }
}
</style>
