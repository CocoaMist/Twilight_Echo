<script setup lang="ts">
import ThemeColorControl from '@renderer/components/theme-studio/ThemeColorControl.vue'
import type { ThemeEditorControl, WorkshopAsset } from '../../../../shared/themeWorkshop.ts'
const props = defineProps<{
  control: ThemeEditorControl
  value: string
  modified: boolean
  busy: boolean
  assets: WorkshopAsset[]
  unlinked?: boolean
}>()
const emit = defineEmits<{
  change: [value: string, continuous: boolean]
  reset: []
  image: []
  link: []
  gesture: [action: 'begin' | 'end' | 'cancel']
}>()
function input(event: Event): string {
  return (event.target as HTMLInputElement).value
}
function number(event: Event): void {
  const unit = props.control.unit ?? props.control.defaults.pureWhite.match(/[a-z%]+$/i)?.[0] ?? ''
  emit('change', input(event) + unit, true)
}
</script>
<template>
  <section class="workshop-control" :data-workshop-control="control.id" tabindex="-1">
    <div class="workshop-control-heading">
      <strong>{{ control.label }}</strong
      ><span v-if="modified" class="workshop-badge">已修改</span
      ><button
        :disabled="busy || !modified"
        :aria-label="'恢复' + control.label"
        @click="emit('reset')"
      >
        ↶
      </button>
    </div>
    <p v-if="control.description" class="workshop-hint">{{ control.description }}</p>
    <button v-if="control.targets" :disabled="busy" @click="emit('link')">
      {{ unlinked ? '重新同步本地与流媒体' : '解除本地／流媒体同步' }}
    </button>
    <template v-if="control.type === 'image'">
      <div class="workshop-asset" :style="{ backgroundImage: value }" />
      <button :disabled="busy" @click="emit('image')">导入图片</button>
      <select
        :disabled="busy"
        aria-label="使用素材库图片"
        value=""
        @change="
          emit(
            'change',
            `url('${assets.find((asset) => asset.id === input($event))!.dataUrl}')`,
            false
          )
        "
      >
        <option value="" disabled>使用已导入图片…</option>
        <option
          v-for="asset in assets.filter((item) => item.type === 'image')"
          :key="asset.id"
          :value="asset.id"
        >
          {{ asset.name }}
        </option></select
      ><button :disabled="busy" @click="emit('change', 'none', false)">移除图片</button>
    </template>
    <ThemeColorControl
      v-else-if="control.type === 'color'"
      :label="control.label"
      :value="value"
      :disabled="busy"
      @change="emit('change', $event, true)"
    />
    <div v-else-if="control.type === 'number'" class="workshop-number">
      <input
        type="range"
        :aria-label="control.label"
        :disabled="busy"
        :min="control.min ?? 0"
        :max="control.max ?? 100"
        :step="control.step ?? 1"
        :value="parseFloat(value)"
        @pointerdown="emit('gesture', 'begin')"
        @pointerup="emit('gesture', 'end')"
        @pointercancel="emit('gesture', 'cancel')"
        @input="number"
      />
      <label
        ><input
          type="number"
          :aria-label="control.label + '精确数值'"
          :disabled="busy"
          :min="control.min"
          :max="control.max"
          :step="control.step ?? 1"
          :value="parseFloat(value)"
          @input="number"
        /><span>{{ control.unit }}</span></label
      >
    </div>
    <select
      v-else-if="control.type === 'select'"
      :aria-label="control.label"
      :disabled="busy"
      :value="value"
      @change="emit('change', input($event), false)"
    >
      <option v-for="option in control.options" :key="option" :value="option">{{ option }}</option>
    </select>
    <label v-else-if="control.type === 'boolean'" class="workshop-checkbox"
      ><input
        type="checkbox"
        :aria-label="control.label"
        :disabled="busy"
        :checked="value === (control.checkedValue ?? '1')"
        @change="
          emit(
            'change',
            ($event.target as HTMLInputElement).checked
              ? (control.checkedValue ?? '1')
              : (control.uncheckedValue ?? '0'),
            false
          )
        "
      />{{ value === (control.checkedValue ?? '1') ? '已开启' : '已关闭' }}</label
    >
    <input
      v-else
      :aria-label="control.label"
      :disabled="busy"
      :value="value"
      @input="emit('change', input($event), true)"
    />
    <details v-if="control.type === 'color'">
      <summary>颜色值</summary>
      <input
        :aria-label="control.label + '颜色值'"
        :disabled="busy"
        :value="value"
        @input="emit('change', input($event), true)"
      />
    </details>
    <small v-if="control.type !== 'image'" class="workshop-hint">{{ value }}</small>
  </section>
</template>
