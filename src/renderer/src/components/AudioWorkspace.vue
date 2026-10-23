<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import DspRackPage from './DspRackPage.vue'
import DspSignalOverview from './dsp-rack/DspSignalOverview.vue'
import AppBackgroundLayer from './AppBackgroundLayer.vue'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { dspApplyLabel, dspWorkspaceTabs, type DspWorkspaceTab } from '@renderer/utils/dspWorkbench'
import type { DspGraphStatus, DspSceneState } from '../../../shared/dspGraph.ts'
import {
  dspEditorDocumentVisible,
  useDspEditorWindow
} from '@renderer/composables/useDspEditorWindow'
const EqualizerPage = defineAsyncComponent(() => import('./EqualizerPage.vue'))
const props = defineProps<{ active: boolean; initialTab: DspWorkspaceTab }>()
const rack = ref<InstanceType<typeof DspRackPage> | null>(null)
const equalizer = ref<InstanceType<typeof EqualizerPage> | null>(null)
const tab = ref<DspWorkspaceTab>(props.initialTab)
const status = ref<DspGraphStatus | null>(null)
const sceneState = ref<DspSceneState | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const sceneName = ref('自动匹配')
const error = ref('')
const diagnosticsError = ref('')
const dirty = ref(false)
const masterBusy = ref(false)
const switching = ref(false)
const { audioProcessing, audioEngineReady } = storeToRefs(useAudioOutputDspStore())
const outputStore = useAudioOutputDspStore()
const detached = ref(false)
const editorWindow = useDspEditorWindow((value) => {
  detached.value = value
})
const { target } = editorWindow
const hostDocument = computed(() => target.value?.ownerDocument ?? document)
const visible = computed(() => (detached.value ? dspEditorDocumentVisible.value : props.active))
const currentMode = computed(
  () => dspWorkspaceTabs.find((item) => item.id === tab.value)?.mode ?? 'status'
)
const processingBypassed = computed(
  () => audioProcessing.value.directMode || !audioProcessing.value.dspEnabled
)
const eqLive = computed(() => !processingBypassed.value && audioProcessing.value.eqEnabled)
const applyLabel = computed(() => dspApplyLabel(status.value))
const engineLabel = computed(() =>
  audioProcessing.value.directMode
    ? 'Direct 直通'
    : audioProcessing.value.dspEnabled
      ? applyLabel.value
      : 'DSP 已旁路'
)
const engineTone = computed(() => {
  if (!audioEngineReady.value) return 'offline'
  if (status.value?.applyState === 'failed') return 'error'
  if (processingBypassed.value) return 'bypassed'
  return applyLabel.value === '已生效' ? 'live' : 'pending'
})
const pageHeading = computed(
  () =>
    ({
      equalizer: {
        kicker: '实时生效',
        title: '均衡器',
        description:
          '调整立即作用于正在播放的声音，无需保存。先用 OPRA 校正耳机频响，再按喜好塑造音色。'
      },
      chain: {
        kicker: '场景草稿 · 保存后生效',
        title: '效果链',
        description:
          '每个场景是一条串行处理链，按信号经过的顺序编排；引擎根据设备与音源格式自动选择场景。'
      },
      output: {
        kicker: '场景草稿 · 设备参数',
        title: '输出',
        description:
          '信号离开 DSP 前的最后一站。采样率、重采样与保护随场景保存，缓冲直接作用于设备。'
      },
      library: {
        kicker: '跨场景共享',
        title: '资料库',
        description:
          '脉冲响应、耳机与房间校正、VST3 插件集中于此。先在效果链中选中节点，再回来一键绑定。'
      },
      monitor: { kicker: '', title: '', description: '' }
    })[tab.value]
)
const lifecycle = computed(() => {
  const confirmed = !dirty.value && applyLabel.value === '已生效'
  return [
    { label: '编辑草稿', state: dirty.value ? 'current' : 'done' },
    { label: '保存', state: dirty.value ? 'next' : 'done' },
    {
      label: processingBypassed.value ? '引擎确认 · 已旁路' : '引擎确认',
      state: dirty.value ? 'next' : confirmed ? 'done' : 'current'
    }
  ]
})
async function prepareLeave(): Promise<boolean> {
  if (tab.value === 'equalizer' && equalizer.value && !(await equalizer.value.requestLeave()))
    return false
  return (await rack.value?.requestLeave()) ?? true
}
async function requestLeave(): Promise<boolean> {
  if (switching.value || masterBusy.value) return false
  return prepareLeave()
}
async function selectTab(next: DspWorkspaceTab): Promise<void> {
  if (next === tab.value || switching.value || masterBusy.value) return
  switching.value = true
  try {
    if ((next === 'equalizer' || tab.value === 'equalizer') && !(await prepareLeave())) return
    if (!(await rack.value?.finishAudition())) return
    if (tab.value === 'equalizer') await rack.value?.syncFromEngine()
    tab.value = next
    await nextTick()
    contentRef.value?.scrollTo({ top: 0 })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    switching.value = false
  }
}
async function focusNode(id: string): Promise<void> {
  await selectTab('chain')
  if (tab.value === 'chain') await rack.value?.focusRuntimeNode(id)
}
watch(
  () => props.initialTab,
  (next) => void selectTab(next)
)
async function toggleMaster(): Promise<void> {
  if (masterBusy.value || switching.value) return
  masterBusy.value = true
  error.value = ''
  try {
    if (!(await prepareLeave())) return
    await outputStore.setAudioProcessing(
      { dspEnabled: !audioProcessing.value.dspEnabled },
      { throwOnError: true }
    )
    await rack.value?.syncFromEngine()
    await rack.value?.refreshDiagnostics()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    masterBusy.value = false
  }
}
function popout(): void {
  try {
    editorWindow.open()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
async function leave(): Promise<boolean> {
  if (!(await requestLeave())) return false
  if (detached.value) await editorWindow.dock()
  return true
}
let closingWindow = false
function beforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value || equalizer.value?.busy) {
    event.preventDefault()
    event.returnValue = ''
    if (closingWindow) return
    closingWindow = true
    void leave()
      .then((allowed) => {
        if (allowed) window.api.window.close()
      })
      .finally(() => {
        closingWindow = false
      })
  }
}
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
defineExpose({ requestLeave: leave })
</script>

<template>
  <div class="audio-workspace-host" :class="{ detached }">
    <div v-if="detached && active" class="detached-placeholder">
      <span class="placeholder-mark"><i class="pi pi-window-maximize"></i></span>
      <h2>DSP 工作台已在独立窗口中打开</h2>
      <p>草稿、试听与监测都在独立窗口中继续运行；收回后保持不变。</p>
      <div class="toolbar">
        <button @click="editorWindow.focus">显示窗口</button
        ><button class="primary-button" @click="editorWindow.dock">收回主窗口</button>
      </div>
    </div>
    <Teleport :to="target ?? 'body'" :disabled="!target">
      <main
        v-show="active || detached"
        class="audio-workspace"
        :class="{ 'is-detached': detached }"
        :data-engine-tone="engineTone"
        data-testid="audio-workspace"
      >
        <AppBackgroundLayer
          :key="detached ? 'window-background' : 'main-background'"
          page="app"
          embedded
          reading
        />
        <header class="workspace-header">
          <div class="workspace-identity">
            <span class="workspace-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  class="mark-wave"
                  d="M2.5 12h3.2l2.1-5.6 3.6 11.2 3-8.4 1.9 4.6 1.3-1.8h3.9"
                />
              </svg>
            </span>
            <h1>DSP 工作台</h1>
          </div>
          <nav class="workspace-tabs" aria-label="DSP 工作台">
            <button
              v-for="item in dspWorkspaceTabs"
              :key="item.id"
              :data-mode="item.mode"
              :title="item.hint"
              :aria-current="tab === item.id ? 'page' : undefined"
              :disabled="switching || rack?.busy || equalizer?.busy"
              @click="selectTab(item.id)"
            >
              <span class="tab-label">{{ item.label }}</span
              ><span
                v-if="item.id === 'equalizer'"
                class="tab-live"
                :class="{ on: eqLive }"
                aria-hidden="true"
              ></span
              ><span
                v-if="(item.id === 'chain' || item.id === 'output') && dirty"
                class="unsaved-mark"
                aria-label="未保存"
              ></span>
            </button>
          </nav>
          <div class="workspace-actions">
            <button
              class="workspace-power"
              :class="{ enabled: audioProcessing.dspEnabled }"
              :aria-pressed="audioProcessing.dspEnabled"
              aria-label="DSP 总开关"
              :title="audioProcessing.dspEnabled ? '点击旁路全部 DSP 处理' : '点击开启 DSP 处理'"
              :disabled="masterBusy || switching || rack?.busy || rack?.loading || equalizer?.busy"
              @click="toggleMaster"
            >
              <span class="power-switch" aria-hidden="true"><i></i></span
              ><span class="power-copy"
                ><strong>DSP</strong
                ><small>{{
                  masterBusy ? '切换中' : audioProcessing.dspEnabled ? '处理中' : '已旁路'
                }}</small></span
              >
            </button>
            <button
              class="workspace-popout"
              :title="detached ? '收回主窗口' : '在独立窗口中调节'"
              @click="detached ? editorWindow.dock() : popout()"
            >
              <i :class="detached ? 'pi pi-window-minimize' : 'pi pi-external-link'"></i
              ><span class="action-label">{{ detached ? '收回' : '弹出窗口' }}</span>
            </button>
          </div>
        </header>
        <div ref="contentRef" class="workspace-content" :data-workspace-tab="tab">
          <div class="workspace-page" :data-tab="tab">
            <p
              v-if="error || (tab !== 'monitor' && (status?.applyError || diagnosticsError))"
              class="rack-message error"
              role="alert"
            >
              <i class="pi pi-exclamation-triangle"></i
              ><span>{{ error || status?.applyError || diagnosticsError }}</span>
            </p>
            <header
              v-if="tab !== 'monitor'"
              class="workspace-page-heading"
              :data-mode="currentMode"
            >
              <p class="page-kicker">
                <i class="mode-dot" aria-hidden="true"></i>{{ pageHeading.kicker }}
              </p>
              <h2>{{ pageHeading.title }}</h2>
              <p class="page-description">{{ pageHeading.description }}</p>
              <p
                v-if="tab === 'equalizer'"
                class="realtime-label"
                :class="{ 'is-bypassed': !eqLive }"
              >
                <i class="state-dot" aria-hidden="true"></i
                >{{
                  processingBypassed
                    ? '实时编辑 · 输出已旁路'
                    : audioProcessing.eqEnabled
                      ? '正在实时处理'
                      : '均衡器已旁路'
                }}
              </p>
              <ol
                v-else-if="tab === 'chain' || tab === 'output'"
                class="draft-lifecycle"
                aria-label="草稿进度"
              >
                <li v-for="(step, index) in lifecycle" :key="step.label" :data-state="step.state">
                  <span class="step-index">{{ index + 1 }}</span
                  ><span class="step-label">{{ step.label }}</span>
                </li>
              </ol>
            </header>
            <div
              v-if="tab === 'equalizer' && processingBypassed"
              class="live-eq-context"
              role="note"
            >
              <i class="pi pi-info-circle" aria-hidden="true"></i
              ><span>{{
                audioProcessing.directMode
                  ? 'Direct 正在旁路音效，退出直通后才能听到调整。'
                  : 'DSP 总开关已旁路：可以继续编辑，开启后才会处理音频。'
              }}</span
              ><button
                v-if="!audioProcessing.directMode"
                class="ghost-button"
                :disabled="masterBusy || switching || equalizer?.busy"
                @click="toggleMaster"
              >
                开启 DSP
              </button>
            </div>
            <EqualizerPage
              v-if="tab === 'equalizer'"
              ref="equalizer"
              embedded
              :visible="visible"
              :host-document="hostDocument"
              :active-scene-id="status?.activeSceneId"
            />
            <DspRackPage
              ref="rack"
              v-show="tab !== 'equalizer'"
              :tab="tab"
              :visible="visible"
              :host-document="hostDocument"
              :master-busy="masterBusy"
              @diagnostic-error="diagnosticsError = $event"
              @status="status = $event"
              @scene="sceneName = $event"
              @state="sceneState = $event"
              @dirty="dirty = $event"
              @navigate="selectTab"
              @master="toggleMaster"
            />
          </div>
        </div>
        <footer class="workspace-status">
          <span class="engine-state" :data-tone="engineTone"
            ><i :class="['state-dot', { ready: audioEngineReady }]" aria-hidden="true"></i
            >{{ engineLabel }}</span
          >
          <DspSignalOverview
            :status="status"
            :scene-state="sceneState"
            :scene-name="sceneName"
            :disabled="switching || masterBusy || !!rack?.busy || !!equalizer?.busy"
            @node="focusNode"
            @output="selectTab('output')"
          />
          <span class="status-revision" title="引擎确认的版本 / 请求的版本"
            >ACK {{ status?.appliedRevision ?? '—' }} / {{ status?.requestedRevision ?? '—' }}</span
          >
        </footer>
      </main>
    </Teleport>
  </div>
</template>

<style src="./dsp-rack/DspWorkbench.css"></style>
