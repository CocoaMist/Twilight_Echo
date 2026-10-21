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
const overviewOpen = ref(false)
const contentRef = ref<HTMLElement | null>(null)
const sceneName = ref('自动匹配')
const error = ref('')
const diagnosticsError = ref('')
const dirty = ref(false)
const masterBusy = ref(false)
const switching = ref(false)
const { audioProcessing, audioDevice, audioDeviceOptions, audioEngineReady } =
  storeToRefs(useAudioOutputDspStore())
const outputStore = useAudioOutputDspStore()
const detached = ref(false)
const editorWindow = useDspEditorWindow((value) => {
  detached.value = value
})
const { target } = editorWindow
const hostDocument = computed(() => target.value?.ownerDocument ?? document)
const visible = computed(() => (detached.value ? dspEditorDocumentVisible.value : props.active))
const outputName = computed(
  () =>
    audioDeviceOptions.value.find((item) => item.id === audioDevice.value)?.label ??
    audioDevice.value
)
const pageHeading = computed(
  () =>
    ({
      equalizer: {
        eyebrow: '02 / TONE & CORRECTION',
        title: '均衡与校正',
        description: '先校正耳机，再微调你喜欢的音色。'
      },
      chain: {
        eyebrow: '03 / EFFECTS & ROUTING',
        title: '把声音，调成你的样子',
        description: '按信号经过的顺序组合处理器；保存后应用到场景。'
      },
      output: {
        eyebrow: '04 / OUTPUT & PERFORMANCE',
        title: '声音的最后一站',
        description: '把采样、精度和播放稳定性，一起照顾好。'
      },
      library: {
        eyebrow: '05 / ASSETS & PLUGINS',
        title: '你的声音工具箱',
        description: '集中管理脉冲响应、校正文件与效果插件。'
      },
      monitor: { eyebrow: '', title: '', description: '' }
    })[tab.value]
)
function metric(value: number | null | undefined, unit: string): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} ${unit}`
    : `— ${unit}`
}
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
      <i class="pi pi-window-maximize"></i>
      <h2>DSP 已在独立窗口中打开</h2>
      <div class="toolbar">
        <button @click="editorWindow.focus">显示窗口</button
        ><button @click="editorWindow.dock">收回主窗口</button>
      </div>
    </div>
    <Teleport :to="target ?? 'body'" :disabled="!target">
      <main
        v-show="active || detached"
        class="audio-workspace"
        :class="{ 'is-detached': detached }"
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
            <span class="workspace-symbol"><i class="pi pi-sliders-h"></i></span>
            <div class="workspace-brand">
              <h1>DSP<span>声音工作台</span></h1>
              <p>TWILIGHT ECHO / AUDIO LAB</p>
            </div>
            <div class="route-context">
              <strong>{{ sceneName }}</strong
              ><span>{{ outputName }}</span>
            </div>
          </div>
          <div class="toolbar">
            <button
              class="master-switch"
              :class="{ enabled: audioProcessing.dspEnabled }"
              :aria-pressed="audioProcessing.dspEnabled"
              :disabled="masterBusy || switching || rack?.busy || rack?.loading || equalizer?.busy"
              @click="toggleMaster"
            >
              <i class="pi pi-power-off"></i
              >{{ audioProcessing.dspEnabled ? 'DSP 已开启' : 'DSP 已旁路' }}</button
            ><button
              :title="detached ? '收回主窗口' : '在独立窗口中调节'"
              @click="detached ? editorWindow.dock() : popout()"
            >
              <i :class="detached ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"></i
              ><span>{{ detached ? '收回' : '弹出窗口' }}</span>
            </button>
          </div>
        </header>
        <div class="workspace-body" :class="{ 'overview-expanded': overviewOpen }">
          <button
            class="overview-disclosure"
            :aria-expanded="overviewOpen"
            @click="overviewOpen = !overviewOpen"
          >
            <i class="pi pi-share-alt"></i>链路总览<span>{{
              audioProcessing.directMode
                ? 'Direct'
                : audioProcessing.dspEnabled
                  ? 'DSP 已开启'
                  : 'DSP 已旁路'
            }}</span
            ><i :class="overviewOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"></i>
          </button>
          <DspSignalOverview
            :status="status"
            :scene-state="sceneState"
            :scene-name="sceneName"
            :disabled="switching || masterBusy || !!rack?.busy || !!equalizer?.busy"
            @node="focusNode"
            @output="selectTab('output')"
          />
          <div class="workspace-main">
            <nav class="workspace-tabs" aria-label="DSP 工作台">
              <button
                v-for="(item, index) in dspWorkspaceTabs"
                :key="item.id"
                :data-step="String(index + 1).padStart(2, '0')"
                :aria-current="tab === item.id ? 'page' : undefined"
                :disabled="switching || rack?.busy || equalizer?.busy"
                @click="selectTab(item.id)"
              >
                <i :class="item.icon"></i><span>{{ item.label }}</span
                ><span
                  v-if="(item.id === 'chain' || item.id === 'output') && dirty"
                  class="unsaved-mark"
                  aria-label="未保存"
                ></span>
              </button>
            </nav>
            <div ref="contentRef" class="workspace-content" :data-workspace-tab="tab">
              <p
                v-if="error || (tab !== 'monitor' && (status?.applyError || diagnosticsError))"
                class="rack-message error"
                role="alert"
              >
                {{ error || status?.applyError || diagnosticsError }}
              </p>
              <header v-if="tab !== 'monitor'" class="workspace-page-heading">
                <div>
                  <p class="eyebrow">{{ pageHeading.eyebrow }}</p>
                  <h2>{{ pageHeading.title }}<span class="heading-period">.</span></h2>
                  <p>{{ pageHeading.description }}</p>
                </div>
                <span
                  v-if="tab === 'equalizer'"
                  class="realtime-label"
                  :class="{
                    'is-bypassed': audioProcessing.directMode || !audioProcessing.dspEnabled
                  }"
                  ><i class="state-dot"></i
                  >{{
                    audioProcessing.directMode || !audioProcessing.dspEnabled
                      ? '实时编辑 · 输出已旁路'
                      : '实时生效'
                  }}</span
                >
              </header>
              <div
                v-if="
                  tab === 'equalizer' && (audioProcessing.directMode || !audioProcessing.dspEnabled)
                "
                class="live-eq-context"
              >
                <i class="pi pi-info-circle"></i
                ><span>{{
                  audioProcessing.directMode
                    ? 'Direct 正在旁路音效，退出直通后可听到调整。'
                    : 'DSP 总开关已旁路；可以编辑，开启后处理音频。'
                }}</span>
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
                @diagnostic-error="diagnosticsError = $event"
                @status="status = $event"
                @scene="sceneName = $event"
                @state="sceneState = $event"
                @dirty="dirty = $event"
                @navigate="selectTab"
              />
            </div>
          </div>
        </div>
        <footer class="workspace-status">
          <span class="engine-state"
            ><i :class="['state-dot', { ready: audioEngineReady }]"></i
            >{{
              audioProcessing.directMode
                ? 'Direct'
                : audioProcessing.dspEnabled
                  ? dspApplyLabel(status)
                  : 'DSP 已旁路'
            }}</span
          ><span>{{
            status?.outputStage?.actualSampleRate
              ? `${(status.outputStage.actualSampleRate / 1000).toFixed(1)} kHz`
              : '— kHz'
          }}</span
          ><span>{{ metric(status?.meter?.integratedLufs, 'LUFS') }}</span
          ><span>{{ metric(status?.meter?.truePeakDb, 'dBTP') }}</span
          ><span
            >{{
              status
                ? status.nodes.reduce((sum, node) => sum + node.lastProcessMs, 0).toFixed(3)
                : '—'
            }}
            ms</span
          ><span class="status-revision"
            >ACK {{ status?.appliedRevision ?? '—' }} / {{ status?.requestedRevision ?? '—' }}</span
          >
        </footer>
      </main>
    </Teleport>
  </div>
</template>

<style src="./dsp-rack/DspWorkbench.css"></style>
<style src="./dsp-rack/DspStudio.css"></style>
