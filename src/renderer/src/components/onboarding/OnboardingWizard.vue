<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useResolvedMotionMode } from '../../app/useResolvedMotionMode'
import { useFocusTrap } from '../../app/useDismissLayer.ts'
import OnboardingBackdrop from './OnboardingBackdrop.vue'
import StepWelcome from './steps/StepWelcome.vue'
import StepUsage from './steps/StepUsage.vue'
import StepLocal from './steps/StepLocal.vue'
import StepStreaming from './steps/StepStreaming.vue'
import StepPlayer from './steps/StepPlayer.vue'
import StepAudio from './steps/StepAudio.vue'
import StepSystem from './steps/StepSystem.vue'
import StepFinish from './steps/StepFinish.vue'
import {
  buildSettingsPatch,
  resolveFinishAction,
  useOnboardingFlow,
  type OnboardingFinishAction,
  type OnboardingStepId,
  type OnboardingUsage
} from './useOnboardingFlow'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import type { AppSettings } from '@renderer/types/settings'

export interface OnboardingFinishResult {
  patch: Partial<AppSettings>
  action: OnboardingFinishAction
  /** StepStreaming CTA: open the plugin market after the wizard closes. */
  openPluginMarket: boolean
  /** StepPlayer CTA: switch straight into the mini player when it is safe. */
  openMiniPlayer: boolean
}

const emit = defineEmits<{ finish: [result: OnboardingFinishResult] }>()
const props = withDefaults(defineProps<{ saving?: boolean; saveError?: string }>(), {
  saving: false,
  saveError: ''
})

const { settings } = useSettingsStore()
const flow = useOnboardingFlow(settings.value)
const {
  choices,
  visibleSteps,
  currentIndex,
  currentStep,
  direction,
  visitedSteps,
  isFirstStep,
  isLastStep,
  canAdvance,
  next,
  back,
  goTo
} = flow

const STEP_TITLES: Record<OnboardingStepId, string> = {
  welcome: '欢迎',
  usage: '听歌习惯',
  local: '本地曲库',
  streaming: '流媒体',
  player: '播放器形态',
  audio: '声音输出',
  system: '任务栏与后台',
  finish: '完成'
}

const hasCustomBackdrop = computed(() => settings.value.appBackground.global.kind === 'image')

const transitionName = computed(() => (direction.value === 'forward' ? 'onb-fwd' : 'onb-back'))
const streamingVisited = computed(
  () => visitedSteps.value.has('streaming') && choices.value.usage !== 'local'
)
const finishAction = computed(() =>
  resolveFinishAction({
    ...choices.value,
    wantsStreamingLogin: streamingVisited.value && choices.value.wantsStreamingLogin
  })
)
const primaryLabel = computed(() => {
  if (props.saving) return '正在保存…'
  if (!isLastStep.value) return '继续'
  if (finishAction.value === 'streaming-login') return '保存并登录'
  if (streamingVisited.value && choices.value.wantsPluginMarket) return '打开扩展中心'
  if (choices.value.openMiniPlayerOnFinish) return '打开迷你播放器'
  return finishAction.value === 'streaming' ? '打开在线音乐' : '打开本地曲库'
})
const primaryIcon = computed(() => (isLastStep.value ? 'ph ph-play' : 'ph ph-arrow-right'))
const sceneNumber = computed(() => String(currentIndex.value + 1).padStart(2, '0'))
const sceneTotal = computed(() => String(visibleSteps.value.length).padStart(2, '0'))

// Only the two decorative layers receive pointer transforms.
const rootRef = ref<HTMLElement | null>(null)
useFocusTrap(rootRef, () => true)
const motionMode = useResolvedMotionMode(computed(() => settings.value.motionPreference))
let parallaxFrame = 0

function resetParallax(): void {
  if (parallaxFrame) cancelAnimationFrame(parallaxFrame)
  parallaxFrame = 0
  rootRef.value?.querySelectorAll<HTMLElement>('.onb-backdrop, .onb-scene-no').forEach((layer) => {
    layer.style.removeProperty('transform')
  })
}

watch(
  motionMode,
  (mode) => {
    if (mode !== 'full') resetParallax()
  },
  { flush: 'sync' }
)

function onPointerMove(event: PointerEvent): void {
  if (motionMode.value !== 'full' || parallaxFrame) return
  parallaxFrame = requestAnimationFrame(() => {
    parallaxFrame = 0
    const root = rootRef.value
    if (!root || motionMode.value !== 'full') return
    const x = event.clientX / window.innerWidth - 0.5
    const y = event.clientY / window.innerHeight - 0.5
    const backdrop = root.querySelector<HTMLElement>('.onb-backdrop')
    const scene = root.querySelector<HTMLElement>('.onb-scene-no')
    if (backdrop) backdrop.style.transform = `translate3d(${x * -28}px, ${y * -20}px, 0)`
    if (scene) scene.style.transform = `translate3d(${x * 14}px, ${y * 10}px, 0)`
  })
}

function selectUsage(usage: OnboardingUsage): void {
  choices.value.usage = usage
}

function finish(actionOverride?: OnboardingFinishAction): void {
  if (props.saving) return
  const streamingVisited = visitedSteps.value.has('streaming') && choices.value.usage !== 'local'
  const playerVisited = visitedSteps.value.has('player')
  emit('finish', {
    patch: buildSettingsPatch(choices.value, visitedSteps.value),
    action:
      actionOverride ??
      (choices.value.usage === null ? settings.value.startupHomePage : finishAction.value),
    openPluginMarket: !actionOverride && streamingVisited && choices.value.wantsPluginMarket,
    // A login page or plugin-market handoff needs the main window; mini mode
    // only wins when no other finish-time destination asks for it.
    openMiniPlayer:
      !actionOverride &&
      playerVisited &&
      choices.value.openMiniPlayerOnFinish &&
      !(streamingVisited && choices.value.wantsStreamingLogin) &&
      !(streamingVisited && choices.value.wantsPluginMarket)
  })
}

function handlePrimary(): void {
  if (props.saving) return
  if (isLastStep.value) {
    finish()
    return
  }
  next()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || props.saving) return
  const target = event.target as HTMLElement | null
  // Radio groups own arrow keys and Enter activates the focused control —
  // only steer the flow when focus is not inside an interactive element.
  const interactive = target?.closest('button, input, select, textarea, [role="radio"]')
  if (event.key === 'Enter' && !interactive) {
    event.preventDefault()
    handlePrimary()
  } else if (event.key === 'ArrowRight' && !interactive && canAdvance.value && !isLastStep.value) {
    event.preventDefault()
    next()
  } else if (event.key === 'ArrowLeft' && !interactive && !isFirstStep.value) {
    event.preventDefault()
    back()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  resetParallax()
})
</script>

<template>
  <div
    ref="rootRef"
    class="onboarding-wizard"
    :data-motion="motionMode"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label="首次使用引导"
    @pointermove="onPointerMove"
  >
    <div v-if="hasCustomBackdrop" class="onb-scrim" aria-hidden="true"></div>
    <OnboardingBackdrop v-else />
    <div class="onb-scene-no" aria-hidden="true">
      <Transition name="onb-scene-no" mode="out-in">
        <span :key="sceneNumber">{{ sceneNumber }}</span>
      </Transition>
      <small>/ {{ sceneTotal }}</small>
    </div>
    <nav class="onb-progress" aria-label="引导进度">
      <button
        v-for="(step, index) in visibleSteps"
        :key="step"
        type="button"
        class="onb-dot"
        :class="{ 'is-current': index === currentIndex, 'is-done': index < currentIndex }"
        :title="STEP_TITLES[step]"
        :aria-label="`第 ${index + 1} 步：${STEP_TITLES[step]}`"
        :aria-current="index === currentIndex ? 'step' : undefined"
        :disabled="saving || index === currentIndex || !visitedSteps.has(step)"
        @click="goTo(index)"
      ></button>
    </nav>
    <div class="onb-viewport">
      <Transition :name="transitionName" mode="out-in">
        <StepWelcome v-if="currentStep === 'welcome'" key="welcome" />
        <StepUsage
          v-else-if="currentStep === 'usage'"
          key="usage"
          :usage="choices.usage"
          @select="selectUsage"
        />
        <StepLocal
          v-else-if="currentStep === 'local'"
          key="local"
          v-model:watch-library="choices.watchLibrary"
          v-model:auto-analyze-bpm="choices.autoAnalyzeBpm"
          v-model:online-lyrics-fallback="choices.onlineLyricsFallback"
        />
        <StepStreaming
          v-else-if="currentStep === 'streaming'"
          key="streaming"
          v-model:wants-login="choices.wantsStreamingLogin"
          v-model:quality="choices.ncmPlaybackQuality"
          v-model:cache-policy="choices.cachePolicy"
          v-model:wants-plugin-market="choices.wantsPluginMarket"
        />
        <StepPlayer
          v-else-if="currentStep === 'player'"
          key="player"
          v-model:player-bar="choices.playerBar"
          v-model:mini-player="choices.miniPlayer"
          v-model:open-on-finish="choices.openMiniPlayerOnFinish"
        />
        <StepAudio
          v-else-if="currentStep === 'audio'"
          key="audio"
          v-model:audio-exclusive-mode="choices.audioExclusiveMode"
        />
        <StepSystem
          v-else-if="currentStep === 'system'"
          key="system"
          v-model:close-window-behavior="choices.closeWindowBehavior"
          v-model:taskbar-thumbar-buttons-enabled="choices.taskbarThumbarButtonsEnabled"
          v-model:launch-at-login="choices.launchAtLogin"
          v-model:resume-mode="choices.playbackResumeMode"
          v-model:global-shortcuts="choices.globalShortcuts"
          v-model:smtc-enabled="choices.smtcEnabled"
          v-model:discord-rpc-enabled="choices.discordRpcEnabled"
        />
        <StepFinish
          v-else
          key="finish"
          :choices="choices"
          :saving="saving"
          @edit="(step) => goTo(visibleSteps.indexOf(step))"
          @start="finish"
        />
      </Transition>
    </div>
    <footer class="onb-footer">
      <div class="onb-footer-side">
        <button
          v-if="!isLastStep"
          type="button"
          class="onb-btn-ghost"
          :disabled="saving"
          @click="() => finish()"
        >
          {{ choices.usage === null ? '跳过引导' : '保存并开始使用' }}
        </button>
      </div>
      <p v-if="saveError" class="onb-save-error" role="alert">{{ saveError }}</p>
      <p v-else class="onb-key-hint" aria-hidden="true">回车键继续 · 方向键切换</p>
      <div class="onb-footer-side is-end">
        <button
          v-if="!isFirstStep"
          type="button"
          class="onb-btn-ghost"
          data-te-back-button="pill"
          :disabled="saving"
          @click="back"
        >
          返回
        </button>
        <button
          type="button"
          class="onb-btn-primary"
          :disabled="saving || !canAdvance"
          @click="handlePrimary"
        >
          {{ primaryLabel }}
          <i :class="primaryIcon"></i>
        </button>
      </div>
    </footer>
  </div>
</template>

<style src="./OnboardingWizard.css"></style>
