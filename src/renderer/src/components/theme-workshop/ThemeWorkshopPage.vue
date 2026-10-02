<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WorkshopLayersPanel from '@renderer/components/theme-workshop/WorkshopLayersPanel.vue'
import WorkshopAssetsPanel from '@renderer/components/theme-workshop/WorkshopAssetsPanel.vue'
import WorkshopModesPanel from '@renderer/components/theme-workshop/WorkshopModesPanel.vue'
import WorkshopPreview from '@renderer/components/theme-workshop/WorkshopPreview.vue'
import WorkshopControl from '@renderer/components/theme-workshop/WorkshopControl.vue'
import WorkshopProjectPanel from '@renderer/components/theme-workshop/WorkshopProjectPanel.vue'
import WorkshopParameterDesigner from '@renderer/components/theme-workshop/WorkshopParameterDesigner.vue'
import WorkshopDiagnosticsPanel from '@renderer/components/theme-workshop/WorkshopDiagnosticsPanel.vue'
import WorkshopOnboarding from '@renderer/components/theme-workshop/WorkshopOnboarding.vue'
import ThemeAppearanceControl from '@renderer/components/theme-studio/ThemeAppearanceControl.vue'
import { useThemeWorkshopEditor } from '@renderer/components/theme-workshop/useThemeWorkshopEditor'
import { useWorkshopDiagnostics } from '@renderer/components/theme-workshop/useWorkshopDiagnostics'
import { createWorkshopTrial } from '@renderer/components/theme-workshop/workshopTrial'
import {
  WORKSHOP_PREVIEW_SURFACES,
  WORKSHOP_PREVIEW_STATES,
  WORKSHOP_SIMPLE_GROUPS,
  WORKSHOP_SIMPLE_TOKENS,
  workshopTokenGroup
} from '@renderer/components/theme-workshop/workshopCatalog'
import {
  workshopEditor,
  type WorkshopAsset,
  type WorkshopProject,
  type ThemeEditorControl
} from '../../../../shared/themeWorkshop.ts'
import { workshopControlKey } from '../../../../shared/themeEditor.ts'
import {
  repairWorkshopDiagnostic,
  replaceWorkshopAsset
} from '../../../../shared/themeWorkshopEditing.ts'
import {
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  THEME_ACCENT_PALETTES,
  createThemeAccentTokenOverrides,
  type ThemeTone
} from '../../../../shared/theme.ts'
import type { WorkshopSurface, WorkshopLayer } from '../../../../shared/themeWorkshopLayers.ts'
import type { WorkshopDiagnostic } from '../../../../shared/themeWorkshopDiagnostics.ts'
import { useThemeStore } from '@renderer/stores/useThemeStore'
import { useExtensionRegistry } from '@renderer/extensions/registry'

const api = window.api.themeWorkshop
const editor = useThemeWorkshopEditor(api)
const {
  projects,
  sources,
  draft,
  candidate,
  previewProject,
  generation,
  busy,
  error,
  notice,
  saveState,
  savedAt,
  cursor,
  historyLength,
  change,
  persist,
  adopt,
  select,
  create,
  duplicate,
  saveCopy,
  remove,
  undo,
  run
} = editor
const metadataBuffer = ref<{ name: string; author: string; version: string; description: string }>()
const mode = ref<'simple' | 'professional'>('simple')
const tone = ref<ThemeTone>('pureWhite')
const group = ref('项目')
const search = ref('')
const projectSearch = ref('')
const modifiedOnly = ref(false)
const surface = ref('dashboard')
const previewState = ref('normal')
const editTarget = ref<'local' | 'streaming'>('local')
const width = ref(1180)
const zoom = ref(0.65)
const canvasEditing = ref(true)
const selectedLayer = ref('')
const layerSurface = ref<WorkshopSurface>('app')
const guide = ref(true)
const guideStep = ref(0)
const creating = ref(false)
function startProjectGuide(): void {
  guide.value = true
  creating.value = true
  guideStep.value = 0
}
function closeProjectGuide(): void {
  guide.value = false
  creating.value = false
}
function selectGroup(name: string): void {
  group.value = name
  search.value = ''
}
function confirmRemove(): void {
  deleteDialog.value?.close()
  void run(remove)
}
const trial = ref(false)
const deleteDialog = ref<HTMLDialogElement>()
const page = ref<HTMLElement>()
const preview = ref<InstanceType<typeof WorkshopPreview>>()
const code = ref<HTMLTextAreaElement>()
const sourceCode = ref<HTMLTextAreaElement>()
const sourceDetails = ref<HTMLDetailsElement>()
const metadataProblems = ref<WorkshopDiagnostic[]>([])
const designerProblem = ref('')
const diagnostics = useWorkshopDiagnostics(
  previewProject,
  generation,
  candidate,
  async () => preview.value?.inspect() ?? []
)
const {
  css,
  validProject,
  previewValid,
  report,
  checking,
  progress,
  stale,
  scene,
  previewP95,
  bufferProblems
} = diagnostics
watch([metadataProblems, designerProblem], () => {
  bufferProblems.value = [
    ...metadataProblems.value,
    ...(designerProblem.value
      ? [
          {
            id: 'editor.buffer',
            code: 'editor.buffer',
            severity: 'error' as const,
            message: designerProblem.value,
            location: { kind: 'control' as const }
          }
        ]
      : [])
  ]
})
const trialRuntime = createWorkshopTrial(document, () => {
  trial.value = false
})
const canFinish = computed(
  () => !!draft.value && previewValid.value && !report.value.errors && !candidate.value
)
const activeScene = computed(
  () =>
    scene.value ?? {
      tone: tone.value,
      surface: surface.value,
      width: width.value,
      state: previewState.value
    }
)
const groups = computed(() =>
  [
    ...WORKSHOP_SIMPLE_GROUPS,
    ...(mode.value === 'professional'
      ? [
          '标准外观',
          ...new Set(workshopEditor(draft.value!)?.controls.map((control) => control.group) ?? []),
          '参数设计器',
          '高级 CSS'
        ]
      : [])
  ].filter((name, index, all) => all.indexOf(name) === index)
)
const visibleProjects = computed(() =>
  projects.value.filter((project) =>
    `${project.name} ${project.author}`.toLowerCase().includes(projectSearch.value.toLowerCase())
  )
)
function key(control: ThemeEditorControl): string {
  return workshopControlKey(control, draft.value?.unlinked, editTarget.value)
}
function value(control: ThemeEditorControl): string {
  return draft.value?.values[tone.value][key(control)] ?? control.defaults[tone.value]
}
const controls = computed(() =>
  (draft.value ? (workshopEditor(draft.value)?.controls ?? []) : []).filter(
    (control) =>
      (search.value ||
        control.group === group.value ||
        (group.value === '配色' && control.type === 'color')) &&
      `${control.label} ${control.id} ${control.group} ${control.description ?? ''}`
        .toLowerCase()
        .includes(search.value.toLowerCase()) &&
      (!modifiedOnly.value || draft.value?.values[tone.value][key(control)] !== undefined)
  )
)
const tokens = computed(() =>
  THEME_TOKEN_DEFINITIONS.filter(
    (token) =>
      (mode.value === 'professional' || WORKSHOP_SIMPLE_TOKENS.has(token.id)) &&
      (search.value || group.value === '标准外观' || workshopTokenGroup(token) === group.value) &&
      `${token.id} ${token.label}`.toLowerCase().includes(search.value.toLowerCase()) &&
      (!modifiedOnly.value || draft.value?.tokens[tone.value][token.id] !== undefined)
  )
)
const modeDomain = computed(
  () => ({ 导航: 'navigation', 列表: 'library', 播放栏: 'player' })[group.value]
)
const saveLabel = computed(() =>
  bufferProblems.value.length
    ? '输入尚未保存'
    : { saved: '已保存', pending: '待保存', saving: '保存中…', failed: '保存失败' }[saveState.value]
)
let releaseSession: (() => void) | undefined

function gesture(action: 'begin' | 'end' | 'cancel'): void {
  if (action === 'begin') editor.beginGesture()
  else editor.endGesture(action === 'cancel')
}
function replace(next: WorkshopProject): void {
  change((project) => Object.assign(project, next), true)
}
function chooseLayer(id: string, region: WorkshopSurface): void {
  selectedLayer.value = id
  layerSurface.value = region
  group.value = '图层与蒙版'
  const target = WORKSHOP_PREVIEW_SURFACES.find((entry) => entry.layer === region)
  if (target) surface.value = target.id
}
function editLayer(id: string, region: WorkshopSurface, patch: Partial<WorkshopLayer>): void {
  change((project) => {
    const layer = project.layers?.[tone.value]?.[region]?.find((entry) => entry.id === id)
    if (layer) Object.assign(layer, patch)
  }, true)
}
function setValue(control: ThemeEditorControl, raw: string, continuous = false): void {
  change((project) => {
    project.values[tone.value][key(control)] = raw
  }, continuous)
}
function toggleLink(control: ThemeEditorControl): void {
  change((project) => {
    project.unlinked = { ...project.unlinked }
    if (project.unlinked[control.id]) {
      for (const currentTone of ['pureWhite', 'dark'] as const) {
        project.values[currentTone][control.id] =
          project.values[currentTone][`${control.id}.${editTarget.value}`] ??
          control.defaults[currentTone]
        delete project.values[currentTone][`${control.id}.local`]
        delete project.values[currentTone][`${control.id}.streaming`]
      }
      delete project.unlinked[control.id]
    } else {
      for (const currentTone of ['pureWhite', 'dark'] as const)
        for (const target of ['local', 'streaming'])
          project.values[currentTone][`${control.id}.${target}`] =
            project.values[currentTone][control.id] ?? control.defaults[currentTone]
      project.unlinked[control.id] = true
    }
  })
}
async function importAsset(type: 'image' | 'font', control?: ThemeEditorControl): Promise<void> {
  const asset = await api.importAsset(type)
  if (!asset) return
  change((project) => {
    project.assets = [...(project.assets ?? []), asset]
    if (control) project.values[tone.value][key(control)] = `url('${asset.dataUrl}')`
  })
}
async function replaceAsset(asset: WorkshopAsset): Promise<void> {
  const replacement = await api.importAsset(asset.type)
  if (replacement && draft.value)
    change((project) =>
      Object.assign(project, replaceWorkshopAsset(project, asset.id, replacement))
    )
}
function resetGroup(): void {
  const tokenIds = tokens.value.map((token) => token.id)
  const controlIds = controls.value.map((control) => key(control))
  change((project) => {
    for (const id of tokenIds) delete project.tokens[tone.value][id]
    for (const id of controlIds) delete project.values[tone.value][id]
  })
}
function copyTone(): void {
  const other = tone.value === 'dark' ? 'pureWhite' : 'dark'
  change((project) => {
    for (const token of tokens.value) {
      if (project.tokens[tone.value][token.id] === undefined) delete project.tokens[other][token.id]
      else project.tokens[other][token.id] = project.tokens[tone.value][token.id]
    }
    for (const control of controls.value) project.values[other][key(control)] = value(control)
    if (group.value === '图层与蒙版' && project.layers)
      project.layers[other] = JSON.parse(JSON.stringify(project.layers[tone.value]))
  })
  notice.value = `已将当前分组从${tone.value === 'dark' ? '深色复制到浅色' : '浅色复制到深色'}，可撤销`
}
async function locate(item: WorkshopDiagnostic): Promise<void> {
  const location = item.location
  search.value = ''
  modifiedOnly.value = false
  if (location.tone) tone.value = location.tone
  if (location.width) width.value = location.width
  if (location.state) previewState.value = location.state
  if (location.surface && WORKSHOP_PREVIEW_SURFACES.some((entry) => entry.id === location.surface))
    surface.value = location.surface
  let selector = ''
  if (location.kind === 'control') {
    const control = workshopEditor(draft.value!)?.controls.find(
      (entry) =>
        entry.id === location.id || entry.id === location.id?.replace(/\.(local|streaming)$/, '')
    )
    group.value = control?.group ?? '参数设计器'
    mode.value = 'professional'
    selector = `[data-workshop-control="${CSS.escape(control?.id ?? '')}"]`
  }
  if (location.kind === 'token') {
    group.value = '标准外观'
    mode.value = 'professional'
    selector = `[data-studio-setting="${CSS.escape(location.id ?? '')}"]`
  }
  if (location.kind === 'css') {
    mode.value = 'professional'
    group.value = '高级 CSS'
  }
  if (location.kind === 'project') {
    group.value = '项目'
    selector = `[data-workshop-field="${CSS.escape(location.id ?? '')}"]`
  }
  if (location.kind === 'asset') {
    group.value = '素材库'
    selector = `[data-workshop-asset="${CSS.escape(location.id ?? '')}"]`
  }
  if (location.kind === 'layer') chooseLayer(location.id ?? '', location.surface as WorkshopSurface)
  if (location.kind === 'layout' || location.kind === 'mode') group.value = '布局与模式'
  await nextTick()
  if (selector) {
    const element = page.value?.querySelector<HTMLElement>(selector)
    element?.scrollIntoView({ block: 'nearest' })
    element?.focus()
  }
  if (location.kind === 'preview' && location.id) preview.value?.highlight(location.id)
  if (location.kind === 'css') {
    if (location.source === 'base' && sourceDetails.value) sourceDetails.value.open = true
    const target = location.source === 'base' ? sourceCode.value : code.value
    if (!target) return
    const offset =
      target.value
        .split('\n')
        .slice(0, (location.line ?? 1) - 1)
        .reduce((count, line) => count + line.length + 1, 0) +
      (location.column ?? 1) -
      1
    target.focus()
    target.setSelectionRange(offset, offset + 1)
  }
}
async function preflight(): Promise<void> {
  await diagnostics.flush()
  if (!canFinish.value)
    throw new Error(candidate.value ? '请先采用或取消基础主题候选版本' : '请先修复检测中的错误')
  await persist()
  const result = await api.preflight(draft.value!.id, draft.value!.revision)
  if (result.errors)
    throw new Error(result.diagnostics.find((item) => item.severity === 'error')!.message)
}
async function apply(): Promise<void> {
  await preflight()
  const result = await api.apply(draft.value!.id, draft.value!.revision)
  await useExtensionRegistry().syncExtensions()
  trialRuntime.stop()
  await useThemeStore().setActive({
    kind: 'plugin',
    pluginId: result.pluginId,
    themeId: result.themeId
  })
  projects.value = await api.list()
  adopt(result.project)
  notice.value = '主题已应用，停用工坊后仍可使用'
}
async function exportProject(format: 'project' | 'tep'): Promise<void> {
  if (format === 'tep') await preflight()
  else await persist()
  const path = await api.exportProject(draft.value!.id, format, draft.value!.revision)
  if (path) notice.value = `已导出：${path}`
}
function checkFull(): void {
  void diagnostics.fullCheck().catch((cause) => {
    error.value = String(cause)
  })
}
async function toggleTrial(): Promise<void> {
  if (trial.value) {
    trialRuntime.stop()
    return
  }
  await diagnostics.flush()
  if (!previewValid.value || report.value.errors || !validProject.value)
    throw new Error('请先修复检测中的错误，再整窗试用')
  trialRuntime.start(validProject.value, css.value, tone.value)
  trial.value = true
}
function step(index: number): void {
  guideStep.value = index
  creating.value = index === 0
  if (index === 1) group.value = '配色'
  if (index === 2) group.value = '卡片'
  if (index === 3) {
    tone.value = 'dark'
    void diagnostics.fullCheck().catch((cause) => {
      error.value = String(cause)
    })
  }
  if (index === 4) group.value = '项目'
}
async function createTemplate(template: string): Promise<void> {
  await create(template)
  creating.value = false
  guideStep.value = 1
  group.value = '背景'
}
function adoptCandidate(): void {
  if (!candidate.value) return
  const base = candidate.value
  change((project) => {
    project.base = base
  })
  candidate.value = undefined
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    editor.endGesture(true)
    trialRuntime.stop()
  }
  if (
    !(event.ctrlKey || event.metaKey) ||
    (event.target as HTMLElement).matches('input,textarea,select,[contenteditable]')
  )
    return
  if (event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undo(event.shiftKey ? 1 : -1)
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    void run(persist)
  }
}
watch([css, tone, validProject], () => {
  if (trial.value && validProject.value)
    trialRuntime.update(validProject.value, css.value, tone.value)
})
watch([surface, previewState, width, tone], diagnostics.scheduleRuntime)
watch(mode, () => {
  if (mode.value === 'simple' && !WORKSHOP_SIMPLE_GROUPS.includes(group.value)) group.value = '配色'
  search.value = ''
})
watch(
  () => draft.value?.id,
  () => {
    metadataProblems.value = []
    designerProblem.value = ''
    bufferProblems.value = []
    metadataBuffer.value = undefined
    selectedLayer.value = ''
    layerSurface.value = 'app'
  }
)
onMounted(() => {
  mode.value =
    localStorage.getItem('twilight:workshop:mode') === 'professional' ? 'professional' : 'simple'
  guide.value = localStorage.getItem('twilight:workshop:guide') !== 'hidden'
  releaseSession = editor.bindLifecycle(trialRuntime.stop, () => !bufferProblems.value.length)
  window.addEventListener('keydown', keydown, true)
  void run(editor.initialize)
})
watch(mode, () => localStorage.setItem('twilight:workshop:mode', mode.value))
watch(guide, () =>
  localStorage.setItem('twilight:workshop:guide', guide.value ? 'visible' : 'hidden')
)
watch(
  () => [draft.value?.name, draft.value?.author, draft.value?.version, draft.value?.description],
  () => {
    if (!draft.value || !metadataBuffer.value) return
    metadataBuffer.value = {
      name: bufferProblems.value.some((item) => item.location.id === 'name')
        ? metadataBuffer.value.name
        : draft.value.name,
      author: draft.value.author,
      version: bufferProblems.value.some((item) => item.location.id === 'version')
        ? metadataBuffer.value.version
        : draft.value.version,
      description: draft.value.description
    }
  }
)
onBeforeUnmount(() => {
  releaseSession?.()
  window.removeEventListener('keydown', keydown, true)
  trialRuntime.stop()
})
</script>

<template>
  <section ref="page" class="workshop-page">
    <header class="workshop-header">
      <div>
        <small>THEME PLUGIN WORKSHOP</small>
        <h1>主题插件工坊</h1>
        <p class="workshop-hint">从一个想法，到可分享的主题</p>
      </div>
      <div class="workshop-mode-switch" aria-label="编辑模式">
        <button :aria-pressed="mode === 'simple'" @click="mode = 'simple'">简单模式</button
        ><button :aria-pressed="mode === 'professional'" @click="mode = 'professional'">
          专业模式
        </button>
      </div>
      <button @click="guide = !guide">{{ guide ? '收起引导' : '制作引导' }}</button
      ><button :disabled="busy" @click="startProjectGuide">＋ 新建</button
      ><button
        :disabled="busy"
        @click="
          run(async () => {
            await persist()
            const project = await api.importProject()
            if (project) {
              projects = [project, ...projects]
              adopt(project)
            }
          })
        "
      >
        导入项目
      </button>
    </header>
    <p v-if="error" role="alert" class="workshop-error">
      {{ error
      }}<template v-if="saveState === 'failed'"
        ><button @click="run(editor.reload)">重新加载</button
        ><button @click="run(saveCopy)">另存副本</button
        ><button @click="run(persist)">重试保存</button></template
      >
    </p>
    <p v-if="notice" role="status" class="workshop-notice">{{ notice }}</p>
    <WorkshopOnboarding
      v-if="guide || !draft"
      :step="guideStep"
      :has-project="!!draft"
      :busy="busy"
      :creating="creating"
      @step="step"
      @create="run(() => createTemplate($event))"
      @close="closeProjectGuide"
    />
    <div class="workshop-project-toolbar">
      <input v-model="projectSearch" aria-label="搜索项目" placeholder="搜索项目…" /><select
        aria-label="项目"
        :value="draft?.id ?? ''"
        :disabled="busy"
        @change="
          run(() =>
            select(
              projects.find((project) => project.id === ($event.target as HTMLSelectElement).value)!
            )
          )
        "
      >
        <option disabled value="">选择项目</option>
        <option v-for="project in visibleProjects" :key="project.id" :value="project.id">
          {{ project.name }}
        </option></select
      ><select
        aria-label="从插件创建"
        value=""
        :disabled="busy"
        @change="run(() => create('', sources[Number(($event.target as HTMLSelectElement).value)]))"
      >
        <option disabled value="">定制已安装主题…</option>
        <option
          v-for="(source, index) in sources"
          :key="`${source.pluginId}:${source.themeId}`"
          :value="index"
        >
          {{ source.name }} · {{ source.version }}
        </option>
      </select>
      <template v-if="draft"
        ><span
          role="status"
          :class="['workshop-save-state', saveState]"
          :title="savedAt ? '最近保存：' + savedAt : ''"
          >{{ saveLabel }}</span
        ><button :disabled="busy || cursor <= 0" @click="undo(-1)">撤销</button
        ><button :disabled="busy || cursor >= historyLength - 1" @click="undo(1)">重做</button
        ><button :disabled="busy" @click="run(persist)">保存</button
        ><button :disabled="busy || (!trial && !canFinish)" @click="run(toggleTrial)">
          {{ trial ? '退出试用（Esc）' : '整窗试用' }}</button
        ><button class="workshop-primary" :disabled="busy || !canFinish" @click="run(apply)">
          应用主题
        </button></template
      >
    </div>
    <div v-if="draft" class="workshop-workspace">
      <nav aria-label="编辑区域">
        <button
          v-for="name in groups"
          :key="name"
          :class="{ active: group === name }"
          :aria-current="group === name ? 'page' : undefined"
          @click="selectGroup(name)"
        >
          {{ name }}
        </button>
      </nav>
      <main class="workshop-preview">
        <div class="workshop-toolbar">
          <select v-model="tone" :disabled="checking" aria-label="深浅色">
            <option value="pureWhite">浅色</option>
            <option value="dark">深色</option></select
          ><select v-model="surface" :disabled="checking" aria-label="页面">
            <option v-for="entry in WORKSHOP_PREVIEW_SURFACES" :key="entry.id" :value="entry.id">
              {{ entry.label }}
            </option></select
          ><select v-model="width" :disabled="checking" aria-label="预览宽度">
            <option v-for="size in [640, 760, 1180, 1600]" :key="size" :value="size">
              {{ size }} px
            </option></select
          ><select v-model="previewState" :disabled="checking" aria-label="预览状态">
            <option v-for="state in WORKSHOP_PREVIEW_STATES" :key="state.id" :value="state.id">
              {{ state.label }}
            </option></select
          ><select v-model="zoom" aria-label="预览缩放">
            <option :value="0.5">50%</option>
            <option :value="0.65">65%</option>
            <option :value="0.8">80%</option>
            <option :value="1">100%</option></select
          ><button :aria-pressed="canvasEditing" @click="canvasEditing = !canvasEditing">
            {{ canvasEditing ? '画布编辑' : '体验控件' }}
          </button>
        </div>
        <WorkshopPreview
          v-if="validProject"
          ref="preview"
          :css="css"
          :project="validProject"
          :tone="activeScene.tone"
          :surface="activeScene.surface"
          :width="activeScene.width"
          :state="activeScene.state"
          :zoom="zoom"
          :selected="selectedLayer"
          :canvas-editing="canvasEditing && !checking && !busy"
          @select="chooseLayer"
          @region="group = $event"
          @edit="editLayer"
          @gesture="gesture"
        />
        <div v-else class="workshop-empty">正在准备预览；有错误时请先修复。</div>
        <small class="workshop-preview-metric"
          >预览更新 p95：{{ previewP95 === null ? '—' : previewP95.toFixed(1) + ' ms'
          }}<span v-if="candidate"> · 来源候选预览</span></small
        >
      </main>
      <aside class="workshop-properties">
        <div class="workshop-properties-heading">
          <h2>{{ search ? '搜索结果' : group }}</h2>
          <span>{{ tone === 'dark' ? '深色' : '浅色' }}</span>
        </div>
        <WorkshopProjectPanel
          v-if="group === '项目'"
          :key="draft.id"
          :project="draft"
          :busy="busy"
          :candidate="candidate"
          :can-finish="canFinish"
          :buffer="metadataBuffer"
          @buffer="metadataBuffer = $event"
          @field="
            (key, value) =>
              change((project) => {
                project[key] = value
              }, true)
          "
          @problems="metadataProblems = $event"
          @duplicate="run(duplicate)"
          @remove="deleteDialog?.showModal()"
          @restore="
            run(async () => {
              await persist()
              adopt(await api.restoreApplied(draft!.id))
            })
          "
          @export="run(() => exportProject($event))"
          @update="
            run(async () => {
              await persist()
              candidate = await api.updateBase(draft!.id)
            })
          "
          @adopt="adoptCandidate"
          @cancel="candidate = undefined"
        />
        <WorkshopLayersPanel
          v-else-if="group === '图层与蒙版'"
          :project="draft"
          :tone="tone"
          :selection="selectedLayer"
          :region="layerSurface"
          :busy="busy"
          @change="replace"
          @select="chooseLayer"
          @gesture="gesture"
        />
        <WorkshopAssetsPanel
          v-else-if="group === '素材库'"
          :project="draft"
          :busy="busy"
          @change="replace"
          @import="run(() => importAsset($event))"
          @replace="run(() => replaceAsset($event))"
        />
        <WorkshopModesPanel
          v-else-if="group === '布局与模式'"
          :project="draft"
          :busy="busy"
          @change="replace"
        />
        <template v-else-if="group === '高级 CSS'"
          ><p class="workshop-hint">
            样式在来源和参数之后应用。输入错误仍保存为草稿，预览保留最近有效版本。
          </p>
          <textarea
            ref="code"
            class="workshop-code"
            aria-label="高级 CSS"
            :disabled="busy"
            spellcheck="false"
            :value="draft.css"
            @input="
              change((project) => {
                project.css = ($event.target as HTMLTextAreaElement).value
              }, true)
            " />
          <details ref="sourceDetails">
            <summary>查看来源 CSS（只读）</summary>
            <textarea
              ref="sourceCode"
              aria-label="来源 CSS"
              class="workshop-code"
              readonly
              :value="draft.base.css"
            /></details
        ></template>
        <template v-else-if="group !== '参数设计器'"
          ><input v-model="search" aria-label="搜索参数" placeholder="搜索全部参数…" /><label
            class="workshop-checkbox"
            ><input v-model="modifiedOnly" type="checkbox" />仅查看修改项</label
          >
          <div class="workshop-inline">
            <button :disabled="busy" @click="resetGroup">恢复当前分组</button
            ><button :disabled="busy" @click="copyTone">
              {{ tone === 'dark' ? '深色 → 浅色' : '浅色 → 深色' }}
            </button>
          </div>
          <select
            v-if="controls.some((control) => draft!.unlinked?.[control.id])"
            v-model="editTarget"
            aria-label="编辑页面"
          >
            <option value="local">本地</option>
            <option value="streaming">流媒体</option>
          </select>
          <div v-if="group === '配色' && !search" class="workshop-palette">
            <button
              v-for="color in THEME_ACCENT_PALETTES[tone]"
              :key="color.id"
              :disabled="busy"
              :style="{ background: color.value }"
              :aria-label="'使用' + color.label + '主题色'"
              :title="color.label"
              @click="
                change((project) =>
                  Object.assign(
                    project.tokens[tone],
                    createThemeAccentTokenOverrides(
                      color.value,
                      tone,
                      project.tokens[tone]['surface.app'] ??
                        TWILIGHT_DEFAULT_THEME.variants[tone].tokens['surface.app']
                    )
                  )
                )
              "
            />
          </div>
          <WorkshopModesPanel
            v-if="modeDomain && !search"
            :project="draft"
            :busy="busy"
            :domain="modeDomain"
            @change="replace"
          />
          <WorkshopControl
            v-for="control in controls"
            :key="control.id"
            :control="control"
            :value="value(control)"
            :modified="draft.values[tone][key(control)] !== undefined"
            :busy="busy"
            :assets="draft.assets ?? []"
            :unlinked="draft.unlinked?.[control.id]"
            @change="(value, continuous) => setValue(control, value, continuous)"
            @reset="
              change((project) => {
                delete project.values[tone][key(control)]
              })
            "
            @image="run(() => importAsset('image', control))"
            @link="toggleLink(control)"
            @gesture="gesture"
          />
          <ThemeAppearanceControl
            v-for="token in tokens"
            :key="token.id"
            :definition="token"
            :value="
              draft.tokens[tone][token.id] ??
              draft.base.structured?.variants[tone]?.tokens?.[token.id] ??
              TWILIGHT_DEFAULT_THEME.variants[tone].tokens[token.id]
            "
            source="主题"
            :disabled="busy"
            :modified="draft.tokens[tone][token.id] !== undefined"
            @change="
              change((project) => {
                project.tokens[tone][token.id] = $event
              }, true)
            "
            @reset="
              change((project) => {
                delete project.tokens[tone][token.id]
              })
            "
          />
          <p v-if="!controls.length && !tokens.length && !modeDomain" class="workshop-hint">
            没有匹配参数。可清空搜索，或在专业模式中新增参数。
          </p>
        </template>
        <KeepAlive :max="1"
          ><WorkshopParameterDesigner
            v-if="group === '参数设计器'"
            :key="draft.id"
            :project="draft"
            :busy="busy"
            @change="(project) => change((next) => Object.assign(next, project))"
            @problem="designerProblem = $event"
        /></KeepAlive>
      </aside>
    </div>
    <WorkshopDiagnosticsPanel
      v-if="draft"
      :report="report"
      :checking="checking"
      :progress="progress"
      :stale="stale"
      :preview-valid="previewValid"
      @locate="locate"
      @repair="
        change((project) => Object.assign(project, repairWorkshopDiagnostic(project, $event)))
      "
      @check="checkFull"
      @cancel="diagnostics.cancel"
    />
    <dialog ref="deleteDialog" class="workshop-delete-dialog">
      <h2>删除「{{ draft?.name }}」？</h2>
      <p>删除编辑项目及其备份。已经应用的主题仍可使用。</p>
      <div class="workshop-inline">
        <button @click="deleteDialog?.close()">取消</button
        ><button class="workshop-danger" @click="confirmRemove">删除编辑项目</button>
      </div>
    </dialog>
  </section>
</template>
<style src="./ThemeWorkshopPage.css"></style>
