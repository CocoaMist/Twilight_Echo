<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  DspAsset,
  DspAssetKind,
  DspGraphNode,
  DspScene,
  Vst3CatalogState
} from '../../../../shared/dspGraph.ts'
import { dspAssetReferences } from '@renderer/utils/dspWorkbench'
import { nodeLabel } from '@renderer/utils/dspNodeParams'
const props = defineProps<{
  assets: DspAsset[]
  catalog: Vst3CatalogState | null
  scenes: DspScene[]
  savedScenes: DspScene[]
  selectedNode: DspGraphNode | null
  selectedSceneName?: string
  notice: string
  busy: boolean
}>()
const emit = defineEmits<{
  importAsset: [kind: DspAssetKind]
  importCorrection: []
  remove: [id: string]
  bind: [asset: DspAsset]
  enableVst3: [enabled: boolean]
  addPath: []
  removePath: [path: string]
  scan: []
  recover: [id: string]
  chain: []
}>()
const query = ref('')
const kind = ref<DspAssetKind | 'all'>('all')
const labels: Record<DspAssetKind, string> = {
  impulseResponse: '脉冲响应',
  correctionProfile: 'EQ 校正',
  vst3Preset: 'VST3 预设',
  vst3State: 'VST3 状态'
}
const icons: Record<DspAssetKind, string> = {
  impulseResponse: 'pi pi-wave-pulse',
  correctionProfile: 'pi pi-sliders-h',
  vst3Preset: 'pi pi-bookmark',
  vst3State: 'pi pi-database'
}
const kinds = computed(() => [
  { id: 'all' as const, label: '全部', count: props.assets.length },
  ...(Object.keys(labels) as DspAssetKind[]).map((id) => ({
    id,
    label: labels[id],
    count: props.assets.filter((asset) => asset.kind === id).length
  }))
])
const filtered = computed(() =>
  props.assets.filter(
    (asset) =>
      (kind.value === 'all' || asset.kind === kind.value) &&
      `${asset.name} ${asset.kind} ${labels[asset.kind]}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase())
  )
)
const bindKinds = computed<DspAssetKind[]>(() => {
  const node = props.selectedNode
  if (node?.type === 'convolver') return ['impulseResponse']
  if (node?.type === 'equalizer') return ['correctionProfile']
  if (node?.vst3) return ['vst3Preset', 'vst3State']
  return []
})
const bindHint = computed(() => {
  const node = props.selectedNode
  if (!node) return '先在效果链中选中参数均衡器、卷积或 VST3 节点，再回到这里绑定资料。'
  if (!bindKinds.value.length)
    return `${nodeLabel(node.type)} 不使用外部资料。选择参数均衡器、卷积或已加载的 VST3 节点即可绑定。`
  return `可绑定${bindKinds.value.map((item) => labels[item]).join(' / ')}，绑定会写入「${props.selectedSceneName || '当前场景'}」的草稿。`
})
const vst3Counts = computed(() => {
  const entries = props.catalog?.entries ?? []
  return {
    available: entries.filter((entry) => entry.status === 'available').length,
    problem: entries.filter((entry) => entry.status !== 'available').length
  }
})
function references(asset: DspAsset): string[] {
  return [
    ...new Set([
      ...dspAssetReferences(props.savedScenes, asset.id),
      ...dspAssetReferences(props.scenes, asset.id)
    ])
  ]
}
function canBind(asset: DspAsset): boolean {
  return bindKinds.value.includes(asset.kind)
}
function size(bytes: number): string {
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
}
function importVst3(next: DspAssetKind, event: Event): void {
  ;(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
  emit('importAsset', next)
}
const statusLabels: Record<string, string> = {
  available: '可用',
  incompatible: '不兼容',
  quarantined: '已隔离',
  failed: '扫描失败'
}
</script>

<template>
  <section class="library-page">
    <div class="bind-target" :class="{ ready: bindKinds.length > 0 }" role="status">
      <i class="bind-led" aria-hidden="true"></i>
      <div class="bind-copy">
        <strong>{{
          selectedNode
            ? `绑定目标 · ${nodeLabel(selectedNode.type)}${selectedSceneName ? ` · ${selectedSceneName}` : ''}`
            : '尚未选择绑定目标'
        }}</strong>
        <small>{{ bindHint }}</small>
      </div>
      <button class="ghost-button" @click="emit('chain')">前往效果链</button>
    </div>

    <section class="library-section">
      <header class="section-heading">
        <div>
          <h2>
            校正资料<span class="count-badge">{{ assets.length }}</span>
          </h2>
        </div>
        <div class="toolbar">
          <button @click="emit('importAsset', 'impulseResponse')">
            <i class="pi pi-plus"></i>导入 IR
          </button>
          <button @click="emit('importCorrection')"><i class="pi pi-plus"></i>导入 EQ 校正</button>
          <details class="import-menu">
            <summary>
              <i class="pi pi-plus"></i>导入 VST3 文件<i class="pi pi-chevron-down"></i>
            </summary>
            <div class="menu-panel" role="menu">
              <button role="menuitem" @click="importVst3('vst3Preset', $event)">
                <i class="pi pi-bookmark"></i>VST3 预设
              </button>
              <button role="menuitem" @click="importVst3('vst3State', $event)">
                <i class="pi pi-database"></i>VST3 组件状态
              </button>
            </div>
          </details>
        </div>
      </header>
      <div class="library-filters">
        <div class="chip-row" role="group" aria-label="资料类型">
          <button
            v-for="item in kinds"
            :key="item.id"
            class="chip"
            :aria-pressed="kind === item.id"
            @click="kind = item.id"
          >
            {{ item.label }}<small>{{ item.count }}</small>
          </button>
        </div>
        <label class="library-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input v-model="query" type="search" placeholder="搜索资料" aria-label="搜索资料" />
        </label>
      </div>
      <div v-if="filtered.length" class="asset-grid">
        <article
          v-for="asset in filtered"
          :key="asset.id"
          class="asset-row"
          :data-kind="asset.kind"
          :class="{ bindable: canBind(asset) }"
        >
          <span class="asset-glyph" aria-hidden="true"><i :class="icons[asset.kind]"></i></span>
          <div class="asset-info">
            <strong :title="asset.name">{{ asset.name }}</strong
            ><small
              >{{ labels[asset.kind] }} · {{ size(asset.byteSize)
              }}<template v-if="asset.sourceSampleRate">
                · {{ Number((asset.sourceSampleRate / 1000).toFixed(1)) }} kHz</template
              ><template v-if="asset.sourceChannels">
                · {{ asset.sourceChannels }} ch</template
              ></small
            >
            <small
              class="asset-refs"
              :class="{ used: references(asset).length || asset.referenceCount }"
              ><i class="pi pi-link" aria-hidden="true"></i
              >{{
                references(asset).length
                  ? `引用：${references(asset).join('、')}`
                  : asset.referenceCount
                    ? `已保存引用 ${asset.referenceCount} 处`
                    : '尚未引用'
              }}</small
            >
          </div>
          <div class="asset-actions">
            <button
              :class="{ 'primary-button': canBind(asset) }"
              :disabled="!canBind(asset)"
              :title="
                canBind(asset)
                  ? '绑定至效果链选中节点的草稿'
                  : '先在效果链选中相应 EQ、卷积或 VST3 节点'
              "
              @click="emit('bind', asset)"
            >
              绑定
            </button>
            <button
              class="icon-button danger"
              :disabled="references(asset).length > 0 || asset.referenceCount > 0"
              :title="
                references(asset).length || asset.referenceCount
                  ? '请先解除保存场景和草稿中的引用'
                  : '删除资料'
              "
              :aria-label="`删除 ${asset.name}`"
              @click="emit('remove', asset.id)"
            >
              <i class="pi pi-trash"></i>
            </button>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        <i class="pi pi-inbox"></i>
        <strong>{{ query || kind !== 'all' ? '没有匹配的资料' : '资料库还是空的' }}</strong>
        <span>{{
          query || kind !== 'all'
            ? '换个关键词或类型筛选试试。'
            : '导入房间 / 耳机的脉冲响应（IR）或 REW、Equalizer APO、AutoEq 校正文件。'
        }}</span>
      </div>
    </section>

    <section class="vst-library library-section">
      <header class="section-heading">
        <div>
          <h2>
            插件管理<span class="count-badge">{{ vst3Counts.available }}</span>
          </h2>
        </div>
        <div class="toolbar">
          <label class="switch-field"
            ><input
              type="checkbox"
              :checked="catalog?.enabled"
              :disabled="!!notice"
              @change="emit('enableVst3', ($event.target as HTMLInputElement).checked)"
            /><span>启用 VST3</span></label
          >
          <button :disabled="!!notice || busy" @click="emit('scan')">
            <i class="pi pi-refresh"></i>扫描插件
          </button>
        </div>
      </header>
      <p v-if="notice" class="notice" role="status">
        <i class="pi pi-info-circle"></i>{{ notice }}
      </p>
      <div class="path-list">
        <div class="path-heading">
          <strong>扫描目录</strong><small>插件仅在这些目录中查找</small>
        </div>
        <div class="path-chips">
          <span v-for="path in catalog?.searchPaths ?? []" :key="path" class="path-row"
            ><i class="pi pi-folder" aria-hidden="true"></i><code :title="path">{{ path }}</code
            ><button
              class="icon-button small"
              :aria-label="`移除目录 ${path}`"
              @click="emit('removePath', path)"
            >
              <i class="pi pi-times"></i></button
          ></span>
          <button class="ghost-button add-path" :disabled="!!notice" @click="emit('addPath')">
            <i class="pi pi-folder-plus"></i>添加目录
          </button>
        </div>
      </div>
      <div v-if="catalog?.entries.length" class="plugin-grid">
        <article
          v-for="entry in catalog?.entries ?? []"
          :key="entry.id"
          class="plugin-card"
          :data-status="entry.status"
        >
          <span class="asset-glyph" aria-hidden="true"><i class="pi pi-box"></i></span>
          <div class="asset-info">
            <strong :title="entry.name">{{ entry.name }}</strong
            ><small
              >{{ entry.vendor || '未知厂商' }} · {{ entry.version }} ·
              {{ entry.parameters.length }} 参数</small
            ><small>{{ entry.supportedLayouts.join(' / ') }}</small
            ><small v-if="entry.error" class="error">{{ entry.error }}</small>
          </div>
          <span class="plugin-status" :data-status="entry.status">{{
            statusLabels[entry.status] ?? entry.status
          }}</span>
          <button
            v-if="entry.status !== 'available'"
            class="ghost-button"
            :disabled="!!notice"
            :title="entry.modulePath"
            @click="emit('recover', entry.id)"
          >
            <i class="pi pi-refresh"></i>隔离重扫
          </button>
        </article>
      </div>
      <div v-else class="empty-state compact">
        <i class="pi pi-box"></i>
        <strong>尚无扫描结果</strong>
        <span>添加插件目录并启用 VST3 后点击「扫描插件」。</span>
      </div>
    </section>
  </section>
</template>
