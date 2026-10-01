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
}>()

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
    <div class="pane-heading">
      <h2>场景</h2>
      <button
        aria-label="新建场景"
        type="button"
        class="icon-button"
        title="新建场景"
        @click="emit('add')"
      >
        <i aria-hidden="true" class="pi pi-plus"></i>
      </button>
    </div>
    <button
      v-for="scene in scenes"
      :key="scene.id"
      type="button"
      class="scene-row"
      :class="{ selected: scene.id === selectedSceneId, active: scene.id === activeSceneId }"
      @click="emit('select', scene.id)"
    >
      <i
        aria-hidden="true"
        :class="scene.id === activeSceneId ? 'pi pi-play-circle' : 'pi pi-sliders-v'"
      ></i>
      <span>{{ scene.name }}</span>
      <small>P{{ scene.priority }}</small>
    </button>
    <div class="scene-actions">
      <button
        aria-label="复制场景"
        type="button"
        class="icon-button"
        title="复制场景"
        @click="emit('duplicate')"
      >
        <i aria-hidden="true" class="pi pi-copy"></i>
      </button>
      <button
        aria-label="删除场景"
        type="button"
        class="icon-button"
        title="删除场景"
        :disabled="scenes.length <= 1"
        @click="emit('remove')"
      >
        <i aria-hidden="true" class="pi pi-trash"></i>
      </button>
    </div>
    <div class="factory-template-picker">
      <select v-model="factoryTemplate" aria-label="Factory DSP template">
        <option
          v-for="template in DSP_FACTORY_SCENE_TEMPLATES"
          :key="template.id"
          :value="template.id"
        >
          {{ template.name }}
        </option>
      </select>
      <button
        aria-label="Add factory template"
        type="button"
        class="icon-button"
        title="Add factory template"
        @click="emit('addFactory')"
      >
        <i aria-hidden="true" class="pi pi-plus"></i>
      </button>
    </div>
  </aside>
</template>
