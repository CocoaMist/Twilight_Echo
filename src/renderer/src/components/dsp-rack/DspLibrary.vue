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
const props = defineProps<{
  assets: DspAsset[]
  catalog: Vst3CatalogState | null
  scenes: DspScene[]
  savedScenes: DspScene[]
  selectedNode: DspGraphNode | null
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
}>()
const query = ref('')
const filtered = computed(() =>
  props.assets.filter((asset) =>
    `${asset.name} ${asset.kind}`.toLowerCase().includes(query.value.toLowerCase())
  )
)
const labels: Record<DspAssetKind, string> = {
  impulseResponse: '脉冲响应',
  correctionProfile: 'EQ 校正',
  vst3Preset: 'VST3 预设',
  vst3State: 'VST3 状态'
}
function references(asset: DspAsset): string[] {
  return [
    ...new Set([
      ...dspAssetReferences(props.savedScenes, asset.id),
      ...dspAssetReferences(props.scenes, asset.id)
    ])
  ]
}
function canBind(asset: DspAsset): boolean {
  return (
    (asset.kind === 'impulseResponse' && props.selectedNode?.type === 'convolver') ||
    (asset.kind === 'correctionProfile' && props.selectedNode?.type === 'equalizer') ||
    ((asset.kind === 'vst3Preset' || asset.kind === 'vst3State') && !!props.selectedNode?.vst3)
  )
}
function size(bytes: number): string {
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
}
</script>

<template>
  <section class="library-page">
    <header class="pane-heading">
      <div>
        <p class="eyebrow">LIBRARY</p>
        <h2>校正资料</h2>
      </div>
      <div class="toolbar">
        <button @click="emit('importAsset', 'impulseResponse')">
          <i class="pi pi-plus"></i> IR</button
        ><button @click="emit('importCorrection')">导入校正</button>
        <select
          aria-label="导入 VST3 文件"
          value=""
          @change="
            emit('importAsset', ($event.target as HTMLSelectElement).value as DspAssetKind)
            ;($event.target as HTMLSelectElement).value = ''
          "
        >
          <option value="" disabled>导入 VST3 文件</option>
          <option value="vst3Preset">预设</option>
          <option value="vst3State">状态</option>
        </select>
      </div>
    </header>
    <input
      v-model="query"
      class="library-search"
      type="search"
      placeholder="搜索资料"
      aria-label="搜索资料"
    />
    <p v-if="!filtered.length" class="empty-detail">
      {{ query ? '没有匹配的资料' : '导入 IR 或耳机 / 房间校正资料，在效果链中选择节点后绑定。' }}
    </p>
    <div v-for="asset in filtered" :key="asset.id" class="asset-row">
      <i :class="asset.kind === 'impulseResponse' ? 'pi pi-wave-pulse' : 'pi pi-file'"></i>
      <div class="asset-info">
        <strong>{{ asset.name }}</strong
        ><small
          >{{ labels[asset.kind] }} · {{ asset.mediaType }} · {{ size(asset.byteSize)
          }}<template v-if="asset.sourceSampleRate"> · {{ asset.sourceSampleRate }} Hz</template
          ><template v-if="asset.sourceChannels"> · {{ asset.sourceChannels }} ch</template></small
        >
        <small>{{
          references(asset).length
            ? `引用：${references(asset).join('、')}`
            : asset.referenceCount
              ? `已保存引用 ${asset.referenceCount} 处`
              : '尚未引用'
        }}</small>
      </div>
      <button
        :disabled="!canBind(asset)"
        :title="
          canBind(asset) ? '绑定至效果链选中节点的草稿' : '先在效果链选中相应 EQ、卷积或 VST3 节点'
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
        @click="emit('remove', asset.id)"
      >
        <i class="pi pi-trash"></i>
      </button>
    </div>
    <section class="vst-library">
      <header class="pane-heading">
        <div>
          <p class="eyebrow">PLUGINS</p>
          <h2>VST3</h2>
        </div>
        <div class="toolbar">
          <label class="switch-field"
            ><input
              type="checkbox"
              :checked="catalog?.enabled"
              :disabled="!!notice"
              @change="emit('enableVst3', ($event.target as HTMLInputElement).checked)"
            />启用 VST3</label
          >
          <button :disabled="!!notice || busy" @click="emit('scan')">
            <i class="pi pi-refresh"></i>扫描
          </button>
        </div>
      </header>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <div class="pane-heading">
        <h3>扫描目录</h3>
        <button :disabled="!!notice" @click="emit('addPath')">添加目录</button>
      </div>
      <div v-for="path in catalog?.searchPaths ?? []" :key="path" class="path-row">
        <code>{{ path }}</code
        ><button
          class="icon-button"
          :aria-label="`移除目录 ${path}`"
          @click="emit('removePath', path)"
        >
          <i class="pi pi-times"></i>
        </button>
      </div>
      <p v-if="!catalog?.entries.length" class="muted">尚无扫描结果。</p>
      <div v-for="entry in catalog?.entries ?? []" :key="entry.id" class="asset-row">
        <i class="pi pi-box"></i>
        <div class="asset-info">
          <strong>{{ entry.name }}</strong
          ><small
            >{{ entry.vendor }} · {{ entry.version }} · {{ entry.supportedLayouts.join(' / ') }} ·
            {{ entry.parameters.length }} 参数</small
          ><small>{{ entry.status }}{{ entry.error ? ` · ${entry.error}` : '' }}</small
          ><small>{{ entry.modulePath }}</small>
        </div>
        <button
          v-if="entry.status !== 'available'"
          :disabled="!!notice"
          @click="emit('recover', entry.id)"
        >
          隔离重扫
        </button>
      </div>
    </section>
  </section>
</template>
