<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkshopProject, WorkshopBase } from '../../../../shared/themeWorkshop.ts'
import type { WorkshopDiagnostic } from '../../../../shared/themeWorkshopDiagnostics.ts'
const props = defineProps<{
  project: WorkshopProject
  busy: boolean
  candidate?: WorkshopBase
  canFinish: boolean
  buffer?: { name: string; author: string; version: string; description: string }
}>()
const emit = defineEmits<{
  field: [key: 'name' | 'author' | 'version' | 'description', value: string]
  problems: [items: WorkshopDiagnostic[]]
  duplicate: []
  remove: []
  restore: []
  export: [format: 'project' | 'tep']
  update: []
  adopt: []
  cancel: []
  buffer: [value: { name: string; author: string; version: string; description: string }]
}>()
const form = ref({ name: '', author: '', version: '', description: '' })
const invalidName = computed(() => !form.value.name.trim() || form.value.name.length > 160)
const invalidVersion = computed(() => !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(form.value.version))
watch(
  () => props.project.id,
  () => {
    form.value = {
      name: props.buffer?.name ?? props.project.name,
      author: props.buffer?.author ?? props.project.author,
      version: props.buffer?.version ?? props.project.version,
      description: props.buffer?.description ?? props.project.description
    }
  },
  { immediate: true }
)
watch(
  () => [
    props.project.name,
    props.project.author,
    props.project.version,
    props.project.description
  ],
  () => {
    form.value = {
      name: invalidName.value ? form.value.name : props.project.name,
      author: props.project.author,
      version: invalidVersion.value ? form.value.version : props.project.version,
      description: props.project.description
    }
  }
)
watch(
  [invalidName, invalidVersion],
  () => {
    const problems: WorkshopDiagnostic[] = []
    if (invalidName.value)
      problems.push({
        id: 'buffer.name',
        code: 'project.name',
        severity: 'error',
        message: '请填写名称（最多 160 个字符），当前输入尚未保存',
        location: { kind: 'project', id: 'name' }
      })
    if (invalidVersion.value)
      problems.push({
        id: 'buffer.version',
        code: 'project.version',
        severity: 'error',
        message: '版本请使用 1.0.0 或 1.0.0-beta，当前输入尚未保存',
        location: { kind: 'project', id: 'version' }
      })
    emit('problems', problems)
  },
  { immediate: true }
)
watch(form, () => emit('buffer', form.value), { immediate: true })
function input(key: keyof typeof form.value, value: string): void {
  form.value = { ...form.value, [key]: value }
  if ((key === 'name' && invalidName.value) || (key === 'version' && invalidVersion.value)) return
  emit('field', key, value)
}
</script>
<template>
  <label
    v-for="[key, label] in [
      ['name', '名称'],
      ['author', '作者'],
      ['version', '版本'],
      ['description', '描述']
    ] as const"
    :key="key"
    :data-workshop-field="key"
    tabindex="-1"
    >{{ label
    }}<textarea
      v-if="key === 'description'"
      :disabled="busy"
      :value="form[key]"
      @input="input(key, ($event.target as HTMLTextAreaElement).value)" /><input
      v-else
      :disabled="busy"
      :aria-invalid="key === 'name' ? invalidName : key === 'version' ? invalidVersion : false"
      :value="form[key]"
      @input="input(key, ($event.target as HTMLInputElement).value)"
  /></label>
  <p v-if="invalidName || invalidVersion" role="alert" class="workshop-error">
    补全名称和版本后才能保存或切换项目。
  </p>
  <div class="workshop-inline">
    <button :disabled="busy || invalidName || invalidVersion" @click="emit('duplicate')">
      复制项目</button
    ><button :disabled="busy" @click="emit('remove')">删除项目…</button>
  </div>
  <button :disabled="busy || !project.lastApplied" @click="emit('restore')">
    恢复上次应用版本
  </button>
  <p class="workshop-hint">
    来源：{{ project.base.pluginId ?? '内置模板' }} {{ project.base.version }}<br />许可：{{
      project.base.license
    }}
  </p>
  <div class="workshop-inline">
    <button :disabled="busy || invalidName || invalidVersion" @click="emit('export', 'project')">
      导出可编辑项目</button
    ><button :disabled="busy || !canFinish" @click="emit('export', 'tep')">导出独立 .tep</button>
  </div>
  <button v-if="project.base.pluginId" :disabled="busy" @click="emit('update')">
    检查基础主题更新
  </button>
  <div v-if="candidate" class="workshop-candidate">
    <p>正在预览来源 {{ candidate.version }}。个人参数声明保留；采用后请查看参数兼容性诊断。</p>
    <button :disabled="busy" @click="emit('adopt')">采用新基础</button
    ><button @click="emit('cancel')">取消候选预览</button>
  </div>
  <p v-if="!project.editor && !project.base.editor" class="workshop-hint">
    来源没有专属参数，可调整标准外观，或切换专业模式自行设计参数。
  </p>
</template>
