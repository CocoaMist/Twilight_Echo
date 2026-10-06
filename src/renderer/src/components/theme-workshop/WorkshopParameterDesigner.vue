<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { normalizeThemeEditor, WORKSHOP_IMAGE_SLOTS } from '../../../../shared/themeEditor.ts'
import {
  workshopEditor,
  type WorkshopProject,
  type ThemeEditorControl
} from '../../../../shared/themeWorkshop.ts'
import { normalizeThemeTokenValue, THEME_TOKEN_DEFINITIONS } from '../../../../shared/theme.ts'
import { validateWorkshopValue } from '../../../../shared/themeWorkshopCompiler.ts'
import {
  setWorkshopControl,
  removeWorkshopControl
} from '../../../../shared/themeWorkshopEditing.ts'

const props = defineProps<{ project: WorkshopProject; busy: boolean }>()
const emit = defineEmits<{ change: [project: WorkshopProject]; problem: [message: string] }>()
const controls = computed(() => workshopEditor(props.project)?.controls ?? [])
const edit = shallowRef<ThemeEditorControl>()
const existingId = ref('')
const binding = ref<'variable' | 'token' | 'slot'>('variable')
const tokenOptions = computed(() =>
  THEME_TOKEN_DEFINITIONS.filter((token) =>
    edit.value?.type === 'color'
      ? token.kind === 'color'
      : edit.value?.type === 'number'
        ? ['number', 'length'].includes(token.kind)
        : edit.value?.type === 'select'
          ? token.kind === 'enum'
          : edit.value?.type === 'text' && !['enum', 'number', 'color'].includes(token.kind)
  )
)
function choose(control?: ThemeEditorControl): void {
  existingId.value = control?.id ?? ''
  edit.value = control
    ? JSON.parse(JSON.stringify(control))
    : {
        id: `parameter-${controls.value.length + 1}`,
        label: '新参数',
        group: '自定义',
        type: 'color',
        variable: '--workshop-parameter-' + (controls.value.length + 1),
        defaults: { pureWhite: '#2563eb', dark: '#60a5fa' }
      }
  binding.value = control?.token ? 'token' : control?.slot ? 'slot' : 'variable'
}
function update(key: string, value: unknown): void {
  if (edit.value) edit.value = { ...edit.value, [key]: value }
}
function type(value: ThemeEditorControl['type']): void {
  if (!edit.value) return
  const defaults = {
    color: ['#2563eb', '#60a5fa'],
    number: ['16px', '16px'],
    select: ['soft', 'soft'],
    boolean: ['1', '1'],
    image: ['none', 'none'],
    text: ['normal', 'normal']
  }[value]
  edit.value = {
    ...edit.value,
    type: value,
    variable: '--workshop-custom',
    token: undefined,
    slot: undefined,
    defaults: { pureWhite: defaults[0], dark: defaults[1] },
    min: value === 'number' ? 0 : undefined,
    max: value === 'number' ? 100 : undefined,
    step: value === 'number' ? 1 : undefined,
    unit: value === 'number' ? 'px' : undefined,
    options: value === 'select' ? ['soft', 'solid'] : undefined
  }
  binding.value = 'variable'
}
function bind(value: 'variable' | 'token' | 'slot'): void {
  binding.value = value
  update('variable', undefined)
  update('token', undefined)
  update('slot', undefined)
  if (value === 'variable') update('variable', '--workshop-custom')
  if (value === 'token') update('token', tokenOptions.value[0]?.id)
  if (value === 'slot') update('slot', Object.keys(WORKSHOP_IMAGE_SLOTS)[0])
}
const problem = computed(() => {
  if (!edit.value) return ''
  if (
    controls.value.some(
      (control) => control.id === edit.value!.id && control.id !== existingId.value
    )
  )
    return '参数 ID 已存在'
  if (!normalizeThemeEditor({ schemaVersion: 1, controls: [edit.value] })?.controls.length)
    return '请检查 ID、名称、分组、绑定、选项和数值范围'
  try {
    for (const tone of ['pureWhite', 'dark'] as const) {
      validateWorkshopValue(edit.value, edit.value.defaults[tone])
      if (
        edit.value.token &&
        normalizeThemeTokenValue(edit.value.token, edit.value.defaults[tone]) === null
      )
        return '默认值不符合所绑定的标准参数'
    }
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  return ''
})
function save(): void {
  if (!edit.value || problem.value) return
  emit('change', setWorkshopControl(props.project, edit.value))
  edit.value = undefined
}
function duplicate(control: ThemeEditorControl): void {
  let id = `${control.id.slice(0, 85)}-copy`
  let counter = 2
  while (controls.value.some((item) => item.id === id))
    id = `${control.id.slice(0, 85)}-copy-${counter++}`
  choose({ ...control, id, label: `${control.label} 副本` })
  existingId.value = ''
}
function move(id: string, offset: number): void {
  const list = controls.value.slice()
  const index = list.findIndex((control) => control.id === id)
  const target = index + offset
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
  emit('change', { ...props.project, editor: { schemaVersion: 1, controls: list } })
}
function input(event: Event): string {
  return (event.target as HTMLInputElement).value
}
watch(problem, (message) => emit('problem', message), { immediate: true })
</script>
<template>
  <p class="workshop-hint">为导出的主题声明可调参数。来源快照保留；新增声明随项目和成品导出。</p>
  <button :disabled="busy || controls.length >= 512" @click="choose()">＋ 新增参数</button>
  <article v-for="(control, index) in controls" :key="control.id" class="workshop-designer-row">
    <button :disabled="busy" @click="choose(control)">
      {{ control.label }}<small>{{ control.group }} · {{ control.type }}</small>
    </button>
    <div>
      <button :disabled="busy || index === 0" aria-label="参数上移" @click="move(control.id, -1)">
        ↑</button
      ><button
        :disabled="busy || index === controls.length - 1"
        aria-label="参数下移"
        @click="move(control.id, 1)"
      >
        ↓</button
      ><button :disabled="busy || controls.length >= 512" @click="duplicate(control)">复制</button
      ><button :disabled="busy" @click="emit('change', removeWorkshopControl(project, control.id))">
        删除
      </button>
    </div>
  </article>
  <form v-if="edit" class="workshop-designer-form" @submit.prevent="save">
    <h3>{{ existingId ? '编辑参数' : '新增参数' }}</h3>
    <label
      >ID<input :value="edit.id" :readonly="!!existingId" @input="update('id', input($event))"
    /></label>
    <label>名称<input :value="edit.label" @input="update('label', input($event))" /></label>
    <label>分组<input :value="edit.group" @input="update('group', input($event))" /></label>
    <label
      >说明<textarea
        :value="edit.description ?? ''"
        @input="update('description', input($event) || undefined)"
      />
    </label>
    <label
      >类型<select :value="edit.type" @change="type(input($event) as ThemeEditorControl['type'])">
        <option
          v-for="[value, label] in [
            ['color', '颜色'],
            ['number', '数值'],
            ['select', '选项'],
            ['boolean', '开关'],
            ['image', '图片'],
            ['text', '文本']
          ]"
          :key="value"
          :value="value"
        >
          {{ label }}
        </option>
      </select></label
    >
    <label
      >绑定<select :value="binding" @change="bind(input($event) as typeof binding)">
        <option value="variable">CSS 变量</option>
        <option v-if="tokenOptions.length" value="token">宿主标准参数</option>
        <option v-if="edit.type === 'image'" value="slot">宿主图片槽</option>
      </select></label
    >
    <label v-if="binding === 'variable'"
      >变量<input :value="edit.variable" @input="update('variable', input($event))"
    /></label>
    <label v-if="binding === 'token'"
      >标准参数<select :value="edit.token" @change="update('token', input($event))">
        <option v-for="token in tokenOptions" :key="token.id" :value="token.id">
          {{ token.label }}
        </option>
      </select></label
    >
    <label v-if="binding === 'slot'"
      >图片槽<select :value="edit.slot" @change="update('slot', input($event))">
        <option v-for="(_, id) in WORKSHOP_IMAGE_SLOTS" :key="id" :value="id">{{ id }}</option>
      </select></label
    >
    <label v-if="binding !== 'slot'"
      >作用区域选择器<input
        :value="edit.selector ?? ''"
        placeholder="留空表示整个主题"
        @input="update('selector', input($event) || undefined)"
    /></label>
    <label v-for="tone in ['pureWhite', 'dark'] as const" :key="tone"
      >{{ tone === 'dark' ? '深色默认值' : '浅色默认值'
      }}<input
        :value="edit.defaults[tone]"
        @input="update('defaults', { ...edit.defaults, [tone]: input($event) })"
    /></label>
    <template v-if="edit.type === 'number'"
      ><label v-for="key in ['min', 'max', 'step'] as const" :key="key"
        >{{ { min: '最小值', max: '最大值', step: '步长' }[key]
        }}<input
          type="number"
          :value="edit[key]"
          @input="update(key, input($event) === '' ? undefined : Number(input($event)))" /></label
      ><label
        >单位<select :value="edit.unit ?? ''" @change="update('unit', input($event))">
          <option
            v-for="unit in ['', 'px', '%', 'ms', 's', 'deg', 'em', 'rem']"
            :key="unit"
            :value="unit"
          >
            {{ unit || '无单位' }}
          </option>
        </select></label
      ></template
    >
    <label v-if="edit.type === 'select'"
      >选项（每行一个）<textarea
        :value="edit.options?.join('\n')"
        @input="update('options', input($event).split('\n').filter(Boolean))"
      />
    </label>
    <template v-if="edit.type === 'boolean'"
      ><label
        >开启值<input
          :value="edit.checkedValue ?? '1'"
          @input="update('checkedValue', input($event))" /></label
      ><label
        >关闭值<input
          :value="edit.uncheckedValue ?? '0'"
          @input="update('uncheckedValue', input($event))" /></label
    ></template>
    <p v-if="problem" role="alert" class="workshop-error">{{ problem }}</p>
    <button type="submit" :disabled="busy || !!problem">保存参数声明</button
    ><button type="button" @click="edit = undefined">取消</button>
  </form>
</template>
