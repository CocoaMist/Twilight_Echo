<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ParametricEqWorkspace from '../equalizer/ParametricEqWorkspace.vue'
import EqBandTable from '../equalizer/EqBandTable.vue'
import type { DspGraphNode } from '../../../../shared/dspGraph.ts'
import type { EqualizerBand } from '@renderer/types/settings'
import type { EqDisplayRange } from '@renderer/utils/eqViewport'
import { computeAutoPreampDb, computeCompositeResponse } from '@renderer/utils/eqResponse'
import {
  defaultEqBands,
  filterTypes,
  patchBand,
  responseToPath
} from '@renderer/utils/equalizerPageLogic'
import { createParametricBand } from '@renderer/utils/parametricEqInteraction'
import type { EqBandPatch } from '@renderer/utils/parametricEqSelection'

const node = defineModel<DspGraphNode>({ required: true })
const props = defineProps<{ sampleRate: number; hostDocument?: Document }>()
const emit = defineEmits<{ commit: [] }>()
const bands = computed(() =>
  Array.isArray(node.value.params.bands) ? (node.value.params.bands as EqualizerBand[]) : []
)
const mode = computed(() => (node.value.params.mode === 'graphic' ? 'graphic' : 'parametric'))
const editorBands = computed(() =>
  mode.value === 'graphic'
    ? bands.value.map((band) => ({ ...band, filterType: 'peak' as const }))
    : bands.value
)
const availableFilters = computed(() =>
  mode.value === 'graphic' ? filterTypes.filter((filter) => filter.value === 'peak') : filterTypes
)
const selected = ref(0)
const indices = ref<number[]>([0])
const range = ref<EqDisplayRange>(12)
const feedback = ref('')
const clipboardBusy = ref(false)
let mounted = true
onBeforeUnmount(() => {
  mounted = false
})
watch(
  () => node.value,
  () => {
    selected.value = 0
    indices.value = bands.value.length ? [0] : []
    feedback.value = ''
  }
)
watch(
  () => bands.value.length,
  (length) => {
    selected.value = Math.min(selected.value, length - 1)
    indices.value = indices.value.filter((index) => index >= 0 && index < length)
  }
)
const preamp = computed(() => Number(node.value.params.preampDb) || 0)
const responsePath = computed(() =>
  responseToPath(
    computeCompositeResponse(bands.value, preamp.value, {
      mode: mode.value,
      sampleRate: props.sampleRate,
      pointCount: 257,
      minFrequency: 20,
      maxFrequency: 20000
    }),
    range.value,
    false
  )
)
function preview(changes: EqBandPatch[]): void {
  let next = bands.value
  for (const change of changes)
    next = patchBand(
      next,
      change.index,
      mode.value === 'graphic' ? { ...change.patch, filterType: 'peak' } : change.patch,
      mode.value
    )
  node.value.params.bands = next
}
function edit(index: number, patch: Partial<EqualizerBand>): void {
  preview([{ index, patch }])
  emit('commit')
}
function selectBand(index: number, selectedIndices = [index]): void {
  selected.value = index
  indices.value = selectedIndices
}
function add(frequency = 1000, gain = 0): void {
  if (mode.value === 'graphic' || bands.value.length >= 32) return
  node.value.params.bands = [...bands.value, createParametricBand(frequency, gain)]
  selected.value = bands.value.length - 1
  indices.value = [selected.value]
  emit('commit')
}
function remove(index: number): void {
  if (mode.value === 'graphic') return
  node.value.params.bands = bands.value.filter((_, i) => i !== index)
  selected.value = Math.min(index, bands.value.length - 1)
  indices.value = selected.value < 0 ? [] : [selected.value]
  emit('commit')
}
function changeMode(event: Event): void {
  node.value.params.mode = (event.target as HTMLSelectElement).value
  if (mode.value === 'graphic')
    node.value.params.bands = defaultEqBands.map((band) => ({ ...band }))
  emit('commit')
}
async function clipboard(paste: boolean, all = false): Promise<void> {
  if (clipboardBusy.value) return
  clipboardBusy.value = true
  const target = node.value
  try {
    if (paste) {
      if (mode.value === 'graphic') return
      const incoming = await window.api.window.pasteEqBands()
      if (!mounted || node.value !== target) return
      if (bands.value.length + incoming.length > 32) throw new Error('最多支持 32 个频段')
      node.value.params.bands = [...bands.value, ...incoming]
      emit('commit')
      feedback.value = `已粘贴 ${incoming.length} 个频段`
    } else {
      await window.api.window.copyEqBands(
        JSON.parse(JSON.stringify(bands.value.filter((_, i) => all || indices.value.includes(i))))
      )
      feedback.value = '频段已复制'
    }
  } catch (error) {
    feedback.value = error instanceof Error ? error.message : String(error)
  } finally {
    clipboardBusy.value = false
  }
}
function autoPreamp(): void {
  node.value.params.preampDb = computeAutoPreampDb(bands.value, {
    sampleRate: props.sampleRate,
    mode: mode.value,
    marginDb: 0.5,
    minPreampDb: -24,
    maxPreampDb: 24
  })
  emit('commit')
}
</script>

<template>
  <section class="draft-equalizer">
    <div class="toolbar">
      <label
        >模式<select :value="mode" @change="changeMode">
          <option value="parametric">参数</option>
          <option value="graphic">图形 · 10 段</option>
        </select></label
      >
      <label
        >前级 · dB<input
          v-model.number="node.params.preampDb"
          type="number"
          min="-24"
          max="24"
          step="0.1"
          @change="emit('commit')"
      /></label>
      <button @click="autoPreamp">自动前级</button
      ><button :disabled="bands.length >= 32 || mode === 'graphic'" @click="add()">添加频段</button>
    </div>
    <ParametricEqWorkspace
      docked-inspector
      :host-document="hostDocument"
      :fixed-band-count="mode === 'graphic'"
      :bands="editorBands"
      :selected-index="selected"
      :selected-indices="indices"
      v-model:display-range-db="range"
      :filter-types="availableFilters"
      response-view="dsp"
      :response-path="responsePath"
      :spectrum-levels="null"
      :spectrum-visible="false"
      measured-source-path=""
      target-response-path=""
      combined-filter-path=""
      corrected-acoustic-path=""
      :band-response-paths="[]"
      :show-measured-source="false"
      :show-target-response="false"
      :show-individual-filters="false"
      :show-combined-filter="false"
      :show-corrected-response="false"
      :eq-enabled="node.enabled"
      :meter-peak-db="-Infinity"
      :meter-rms-db="-Infinity"
      status="场景草稿 · 保存后生效"
      status-state="editing"
      error=""
      :clipboard-message="feedback"
      :clipboard-busy="clipboardBusy"
      @select="selectBand"
      @preview-bands="preview"
      @commit="emit('commit')"
      @add="
        (f, g) => {
          if (mode === 'parametric') add(f, g)
        }
      "
      @delete="remove"
      @toggle="edit($event, { enabled: bands[$event].enabled === false })"
      @filter="(index, filterType) => edit(index, { filterType })"
      @copy="clipboard(false, $event)"
      @paste="clipboard(true)"
    />
    <EqBandTable
      :bands="editorBands"
      :graphic="mode === 'graphic'"
      :selected-indices="indices"
      caption="频段 · 当前场景草稿"
      @select="selectBand"
      @patch="edit"
      @remove="remove"
    />
  </section>
</template>

<style scoped>
.draft-equalizer {
  min-width: 0;
  grid-column: 1 / -1;
}
.draft-equalizer :deep(.parametric-workspace) {
  min-height: 360px;
  margin: 16px 0;
}
.draft-equalizer :deep(.output-meter),
.draft-equalizer :deep(.spectrum-toggle) {
  display: none;
}
.draft-equalizer .toolbar input {
  width: 90px;
}
.band-table input[type='number'] {
  width: 90px;
}
.band-table .selected {
  background: color-mix(in srgb, var(--te-primary-500) 7%, transparent);
}
</style>
