<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DspNodeType, DspScene } from '../../../../shared/dspGraph.ts'
import {
  nodeCatalog,
  nodeLabel,
  singletonNodeTypes,
  dspNodeDescriptions
} from '@renderer/utils/dspNodeParams'
const scene = defineModel<DspScene | null>('scene')
defineProps<{ selectedNodeId: string | null; busy: boolean }>()
const emit = defineEmits<{
  selectNode: [id: string]
  addNode: [type: DspNodeType]
  removeNode: [id: string]
  moveNode: [id: string, destinationId: string]
  output: []
  rules: []
}>()
const dragged = ref<string | null>(null)
const adding = ref(false)
const query = ref('')
const category = ref('全部')
const categories = ['全部', '均衡与校正', '动态处理', '声场与路由', '插件与监测']
function add(type: DspNodeType): void {
  emit('addNode', type)
  adding.value = false
}
function group(type: DspNodeType): string {
  if (['equalizer', 'dynamicEqualizer', 'convolver'].includes(type)) return categories[1]
  if (
    [
      'replayGain',
      'gate',
      'compressor',
      'multibandCompressor',
      'truePeakLimiter',
      'loudnessContour'
    ].includes(type)
  )
    return categories[2]
  if (['nativePlugin', 'vst3Plugin', 'meter'].includes(type)) return categories[4]
  return categories[3]
}
const filtered = computed(() =>
  nodeCatalog.filter(
    (item) =>
      (category.value === '全部' || category.value === group(item.type)) &&
      `${item.label} ${item.type} ${dspNodeDescriptions[item.type]}`
        .toLowerCase()
        .includes(query.value.toLowerCase())
  )
)
function drop(id: string): void {
  if (dragged.value) emit('moveNode', dragged.value, id)
  dragged.value = null
}
function move(index: number, delta: number): void {
  const nodes = scene.value?.graph.nodes
  if (nodes?.[index + delta]) emit('moveNode', nodes[index].id, nodes[index + delta].id)
}
function canMove(index: number, delta: number): boolean {
  const nodes = scene.value?.graph.nodes
  return (
    !!nodes?.[index + delta] &&
    [nodes[index], nodes[index + delta]].every(
      (node) => !(node.type === 'nativePlugin' && node.pluginAbiVersion === 1)
    )
  )
}
</script>
<template>
  <section class="graph-pane">
    <header class="pane-heading">
      <h2>信号链</h2>
      <button :aria-expanded="adding" @click="adding = !adding">
        <i class="pi pi-plus"></i>添加
      </button>
    </header>
    <section v-if="adding" class="node-picker" aria-label="添加处理节点">
      <input v-model="query" type="search" aria-label="搜索处理器" placeholder="搜索处理器" />
      <select v-model="category" aria-label="处理器分类">
        <option v-for="item in categories" :key="item">{{ item }}</option>
      </select>
      <div class="node-picker-results">
        <button
          v-for="item in filtered"
          :key="item.type"
          :data-node-type="item.type"
          :disabled="
            singletonNodeTypes.has(item.type) &&
            scene?.graph.nodes.some((node) => node.type === item.type)
          "
          @click="add(item.type)"
        >
          <i :class="item.icon"></i
          ><span
            >{{ item.label }}<small>{{ dspNodeDescriptions[item.type] }}</small></span
          >
        </button>
      </div>
      <p v-if="!filtered.length" class="muted">未找到处理器</p>
    </section>
    <button class="signal-end" @click="emit('rules')">
      <i class="pi pi-sign-in"></i>输入 <small>场景与自动匹配</small>
    </button>
    <ol class="node-list" aria-label="串行处理顺序">
      <li
        v-for="(node, index) in scene?.graph.nodes ?? []"
        :key="node.id"
        class="graph-node"
        :class="{ selected: node.id === selectedNodeId, bypassed: !node.enabled }"
        :draggable="!(node.type === 'nativePlugin' && node.pluginAbiVersion === 1)"
        @dragstart="dragged = node.id"
        @dragend="dragged = null"
        @dragover.prevent
        @drop.prevent="drop(node.id)"
      >
        <button
          class="node-select"
          :aria-pressed="node.id === selectedNodeId"
          @click="emit('selectNode', node.id)"
          @keydown.alt.up.prevent="move(index, -1)"
          @keydown.alt.down.prevent="move(index, 1)"
        >
          <span class="node-index">{{ String(index + 1).padStart(2, '0') }}</span
          ><span
            ><strong>{{ nodeLabel(node.type) }}</strong
            ><small>{{
              node.type === 'nativePlugin' && node.pluginAbiVersion === 1
                ? 'ABI v1 · 固定尾端'
                : node.enabled
                  ? '已启用'
                  : '已旁路'
            }}</small></span
          >
        </button>
        <div class="node-actions">
          <button
            class="icon-button small"
            :disabled="!canMove(index, -1)"
            title="上移 · Alt+↑"
            @click="move(index, -1)"
          >
            <i class="pi pi-angle-up"></i>
          </button>
          <button
            class="icon-button small"
            :disabled="!canMove(index, 1)"
            title="下移 · Alt+↓"
            @click="move(index, 1)"
          >
            <i class="pi pi-angle-down"></i>
          </button>
          <button
            class="icon-button small"
            :title="node.enabled ? '旁路节点' : '启用节点'"
            :aria-pressed="node.enabled"
            @click="node.enabled = !node.enabled"
          >
            <i class="pi pi-power-off"></i>
          </button>
          <button
            class="icon-button small danger"
            title="删除节点"
            @click="emit('removeNode', node.id)"
          >
            <i class="pi pi-times"></i>
          </button>
        </div>
      </li>
    </ol>
    <p v-if="!scene?.graph.nodes.length" class="empty-detail">添加处理器，构建串行信号链。</p>
    <button class="signal-end" @click="emit('output')">
      <i class="pi pi-sign-out"></i>输出级 <small>采样率 / 抖动 / 安全保护</small>
    </button>
  </section>
</template>
