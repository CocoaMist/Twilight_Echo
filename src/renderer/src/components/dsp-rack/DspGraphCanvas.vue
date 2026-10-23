<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { DspNodeType, DspScene } from '../../../../shared/dspGraph.ts'
import {
  dspNodeCategories,
  dspNodeCategory,
  dspNodeDescriptions,
  nodeCatalog,
  nodeIcon,
  nodeLabel,
  singletonNodeTypes
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
const dropTarget = ref<string | null>(null)
const adding = ref(false)
const query = ref('')
const category = ref<string>('全部')
const categories = ['全部', ...dspNodeCategories]
const searchRef = ref<HTMLInputElement | null>(null)
const addButton = ref<HTMLButtonElement | null>(null)
const nodes = computed(() => scene.value?.graph.nodes ?? [])
const activeCount = computed(
  () => nodes.value.filter((node) => node.enabled && node.type !== 'meter').length
)
function categoryCount(name: string): number {
  return name === '全部'
    ? nodeCatalog.length
    : nodeCatalog.filter((item) => dspNodeCategory(item.type) === name).length
}
const filtered = computed(() =>
  nodeCatalog.filter(
    (item) =>
      (category.value === '全部' || category.value === dspNodeCategory(item.type)) &&
      `${item.label} ${item.type} ${dspNodeDescriptions[item.type]}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase())
  )
)
function present(type: DspNodeType): boolean {
  return singletonNodeTypes.has(type) && nodes.value.some((node) => node.type === type)
}
function openPicker(): void {
  adding.value = true
  void nextTick(() => searchRef.value?.focus())
}
function closePicker(): void {
  adding.value = false
  void nextTick(() => addButton.value?.focus())
}
function add(type: DspNodeType): void {
  emit('addNode', type)
  adding.value = false
  query.value = ''
}
function pickerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    closePicker()
  }
}
function drop(id: string): void {
  if (dragged.value) emit('moveNode', dragged.value, id)
  dragged.value = null
  dropTarget.value = null
}
function move(index: number, delta: number): void {
  const list = scene.value?.graph.nodes
  if (list?.[index + delta]) emit('moveNode', list[index].id, list[index + delta].id)
}
function canMove(index: number, delta: number): boolean {
  const list = scene.value?.graph.nodes
  return (
    !!list?.[index + delta] &&
    [list[index], list[index + delta]].every(
      (node) => !(node.type === 'nativePlugin' && node.pluginAbiVersion === 1)
    )
  )
}
</script>
<template>
  <section class="graph-pane" aria-label="信号链">
    <header class="pane-heading">
      <h2>信号链</h2>
      <small class="muted">{{ nodes.length }} 个节点 · {{ activeCount }} 个处理中</small>
    </header>
    <div class="chain-stack">
      <button class="signal-end signal-in" @click="emit('rules')">
        <span class="end-port"><i class="pi pi-sign-in"></i></span
        ><span class="end-copy"><strong>输入</strong><small>场景与自动匹配</small></span>
      </button>
      <ol class="node-list" aria-label="串行处理顺序">
        <li
          v-for="(node, index) in nodes"
          :key="node.id"
          class="graph-node"
          :class="{
            selected: node.id === selectedNodeId,
            bypassed: !node.enabled,
            dragging: dragged === node.id,
            'drop-target': dropTarget === node.id && dragged !== node.id
          }"
          :data-category="dspNodeCategory(node.type)"
          :draggable="!(node.type === 'nativePlugin' && node.pluginAbiVersion === 1)"
          @dragstart="dragged = node.id"
          @dragend="
            () => {
              dragged = null
              dropTarget = null
            }
          "
          @dragover.prevent="dropTarget = node.id"
          @dragleave="dropTarget = dropTarget === node.id ? null : dropTarget"
          @drop.prevent="drop(node.id)"
        >
          <span class="node-led" aria-hidden="true"></span>
          <button
            class="node-select"
            :aria-pressed="node.id === selectedNodeId"
            @click="emit('selectNode', node.id)"
            @keydown.alt.up.prevent="move(index, -1)"
            @keydown.alt.down.prevent="move(index, 1)"
          >
            <span class="node-index">{{ String(index + 1).padStart(2, '0') }}</span
            ><span class="node-glyph" aria-hidden="true"><i :class="nodeIcon(node.type)"></i></span
            ><span class="node-text"
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
              aria-label="上移"
              @click="move(index, -1)"
            >
              <i class="pi pi-angle-up"></i>
            </button>
            <button
              class="icon-button small"
              :disabled="!canMove(index, 1)"
              title="下移 · Alt+↓"
              aria-label="下移"
              @click="move(index, 1)"
            >
              <i class="pi pi-angle-down"></i>
            </button>
            <button
              class="icon-button small node-power"
              :title="node.enabled ? '旁路节点' : '启用节点'"
              :aria-label="node.enabled ? '旁路节点' : '启用节点'"
              :aria-pressed="node.enabled"
              @click="node.enabled = !node.enabled"
            >
              <i class="pi pi-power-off"></i>
            </button>
            <button
              class="icon-button small danger"
              title="删除节点"
              aria-label="删除节点"
              @click="emit('removeNode', node.id)"
            >
              <i class="pi pi-times"></i>
            </button>
          </div>
        </li>
      </ol>
      <p v-if="!nodes.length" class="chain-empty">
        <i class="pi pi-arrow-down"></i>信号将直接送往输出级。添加处理器，构建你的串行信号链。
      </p>
      <button
        ref="addButton"
        class="add-node-button"
        :aria-expanded="adding"
        aria-haspopup="dialog"
        :disabled="busy || !scene"
        @click="openPicker"
      >
        <i class="pi pi-plus"></i>添加处理器
      </button>
      <button class="signal-end signal-out" @click="emit('output')">
        <span class="end-port"><i class="pi pi-sign-out"></i></span
        ><span class="end-copy"><strong>输出级</strong><small>采样率 · 抖动 · 安全保护</small></span
        ><i class="pi pi-arrow-up-right end-go" aria-hidden="true"></i>
      </button>
    </div>
    <div v-if="adding" class="node-picker-layer" @click.self="closePicker" @keydown="pickerKeydown">
      <section class="node-picker" role="dialog" aria-modal="true" aria-label="添加处理节点">
        <header class="picker-heading">
          <div>
            <p class="eyebrow">添加到「{{ scene?.name }}」末端</p>
            <h3>选择处理器</h3>
          </div>
          <button class="icon-button" aria-label="关闭" title="关闭 · Esc" @click="closePicker">
            <i class="pi pi-times"></i>
          </button>
        </header>
        <label class="picker-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input
            ref="searchRef"
            v-model="query"
            type="search"
            aria-label="搜索处理器"
            placeholder="搜索名称、类型或用途"
          />
        </label>
        <div class="picker-categories" role="group" aria-label="处理器分类">
          <button
            v-for="item in categories"
            :key="item"
            class="chip"
            :aria-pressed="category === item"
            @click="category = item"
          >
            {{ item }}<small>{{ categoryCount(item) }}</small>
          </button>
        </div>
        <div class="node-picker-results">
          <button
            v-for="item in filtered"
            :key="item.type"
            :data-node-type="item.type"
            :data-category="dspNodeCategory(item.type)"
            :disabled="present(item.type)"
            @click="add(item.type)"
          >
            <span class="picker-glyph" aria-hidden="true"><i :class="item.icon"></i></span
            ><span class="picker-copy"
              ><strong>{{ item.label }}</strong
              ><small>{{ dspNodeDescriptions[item.type] }}</small></span
            ><span v-if="present(item.type)" class="picker-tag">已在链中</span>
          </button>
        </div>
        <p v-if="!filtered.length" class="picker-empty">没有匹配的处理器，换个关键词试试。</p>
      </section>
    </div>
  </section>
</template>
