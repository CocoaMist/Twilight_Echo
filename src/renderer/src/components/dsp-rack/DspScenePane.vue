<script setup lang="ts">
import {
  DSP_FACTORY_SCENE_TEMPLATES,
  type DspFactorySceneTemplateId,
  type DspScene
} from '../../../../shared/dspGraph.ts'
defineProps<{
  scenes: DspScene[]
  selectedSceneId: string | null
  activeSceneId: string | null
  pinnedSceneId?: string | null
}>()
const factoryTemplate = defineModel<DspFactorySceneTemplateId>('factoryTemplate')
const emit = defineEmits<{
  select: [id: string]
  add: []
  duplicate: []
  remove: []
  addFactory: []
}>()
function processingCount(scene: DspScene): number {
  return scene.graph.nodes.filter((node) => node.enabled && node.type !== 'meter').length
}
</script>
<template>
  <aside class="scene-pane" aria-label="场景">
    <header class="pane-heading">
      <h2>
        场景<span class="count-badge">{{ scenes.length }}</span>
      </h2>
      <button class="icon-button" title="新建空白场景" aria-label="新建场景" @click="emit('add')">
        <i class="pi pi-plus"></i>
      </button>
    </header>
    <p class="pane-hint">引擎按优先级自动选择匹配当前设备与格式的场景，也可以固定使用其中一个。</p>
    <div class="scene-list">
      <button
        v-for="scene in scenes"
        :key="scene.id"
        class="scene-row"
        :class="{
          selected: scene.id === selectedSceneId,
          playing: scene.id === activeSceneId,
          disabled: !scene.enabled
        }"
        :aria-pressed="scene.id === selectedSceneId"
        @click="emit('select', scene.id)"
      >
        <span class="scene-led" aria-hidden="true"></span>
        <span class="scene-text"
          ><strong>{{ scene.name }}</strong
          ><small>{{
            scene.id === activeSceneId
              ? '正在播放'
              : scene.enabled
                ? `优先级 ${scene.priority}`
                : '不参与匹配'
          }}</small></span
        >
        <span class="scene-meta">
          <i
            v-if="pinnedSceneId && scene.id === pinnedSceneId"
            class="pi pi-thumbtack"
            title="已固定使用"
          ></i>
          <span class="scene-count" :title="`${processingCount(scene)} 个启用的处理器`">{{
            processingCount(scene)
          }}</span>
        </span>
      </button>
    </div>
    <div class="scene-actions">
      <button class="ghost-button" title="复制选中场景" @click="emit('duplicate')">
        <i class="pi pi-copy"></i>复制
      </button>
      <button
        class="icon-button danger"
        title="删除选中场景"
        aria-label="删除选中场景"
        :disabled="scenes.length <= 1"
        @click="emit('remove')"
      >
        <i class="pi pi-trash"></i>
      </button>
    </div>
    <div class="factory-template-picker">
      <label
        ><span>从工厂模板新建</span
        ><select v-model="factoryTemplate" aria-label="工厂模板">
          <option v-for="item in DSP_FACTORY_SCENE_TEMPLATES" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select></label
      ><button class="ghost-button" @click="emit('addFactory')">
        <i class="pi pi-sparkles"></i>从模板创建
      </button>
    </div>
  </aside>
</template>
