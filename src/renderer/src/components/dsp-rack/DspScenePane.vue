<script setup lang="ts">
import {
  DSP_FACTORY_SCENE_TEMPLATES,
  type DspFactorySceneTemplateId,
  type DspScene
} from '../../../../shared/dspGraph.ts'
defineProps<{ scenes: DspScene[]; selectedSceneId: string | null; activeSceneId: string | null }>()
const factoryTemplate = defineModel<DspFactorySceneTemplateId>('factoryTemplate')
const emit = defineEmits<{
  select: [id: string]
  add: []
  duplicate: []
  remove: []
  addFactory: []
}>()
</script>
<template>
  <aside class="scene-pane">
    <header class="pane-heading">
      <h2>场景</h2>
      <button class="icon-button" title="新建场景" @click="emit('add')">
        <i class="pi pi-plus"></i>
      </button>
    </header>
    <select
      class="compact-scene-select"
      aria-label="正在编辑的场景"
      :value="selectedSceneId"
      @change="emit('select', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
        {{ scene.name }}{{ scene.id === activeSceneId ? ' · 正在播放' : '' }}
      </option>
    </select>
    <div class="scene-list">
      <button
        v-for="scene in scenes"
        :key="scene.id"
        class="scene-row"
        :class="{ selected: scene.id === selectedSceneId }"
        :aria-pressed="scene.id === selectedSceneId"
        @click="emit('select', scene.id)"
      >
        <i :class="scene.id === activeSceneId ? 'pi pi-play-circle' : 'pi pi-sliders-v'"></i
        ><span
          >{{ scene.name
          }}<small>{{
            scene.id === activeSceneId
              ? '正在播放'
              : scene.enabled
                ? `优先级 ${scene.priority}`
                : '不参与匹配'
          }}</small></span
        >
      </button>
    </div>
    <div class="scene-actions toolbar">
      <button title="复制选中场景" @click="emit('duplicate')"><i class="pi pi-copy"></i>复制</button
      ><button
        class="icon-button danger"
        title="删除选中场景"
        :disabled="scenes.length <= 1"
        @click="emit('remove')"
      >
        <i class="pi pi-trash"></i>
      </button>
    </div>
    <div class="factory-template-picker">
      <label
        >工厂模板<select v-model="factoryTemplate">
          <option v-for="item in DSP_FACTORY_SCENE_TEMPLATES" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select></label
      ><button @click="emit('addFactory')">从模板创建</button>
    </div>
  </aside>
</template>
