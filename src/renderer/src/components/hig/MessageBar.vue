<script setup lang="ts">
import type { AppNoticeKind } from '../../stores/useAppNoticeStore'
import { onMounted, onUpdated, ref, watch } from 'vue'
const props = withDefaults(
  defineProps<{
    intent?: AppNoticeKind
    title?: string
    dismissible?: boolean
    announce?: boolean
  }>(),
  { intent: 'info', dismissible: true, announce: true }
)
const emit = defineEmits<{ dismiss: [] }>()
const dismissed = ref(false)
const copy = ref<HTMLElement | null>(null)
let content = ''
onMounted(() => {
  content = copy.value?.textContent ?? ''
})
onUpdated(() => {
  const next = copy.value?.textContent ?? ''
  if (next !== content) {
    content = next
    dismissed.value = false
  }
})
watch(
  () => [props.intent, props.title],
  () => {
    dismissed.value = false
  }
)
function dismiss(): void {
  dismissed.value = true
  emit('dismiss')
}
</script>
<template>
  <div
    class="hig-message-bar"
    v-show="!dismissed"
    :class="`hig-message-bar-${intent}`"
    :role="announce ? (intent === 'error' || intent === 'warning' ? 'alert' : 'status') : undefined"
  >
    <i
      class="pi"
      :class="
        intent === 'error'
          ? 'pi-exclamation-circle'
          : intent === 'warning'
            ? 'pi-exclamation-triangle'
            : intent === 'success'
              ? 'pi-check-circle'
              : 'pi-info-circle'
      "
      aria-hidden="true"
    ></i>
    <div ref="copy" class="hig-message-copy">
      <strong v-if="title">{{ title }}</strong>
      <div><slot /></div>
    </div>
    <div v-if="$slots.actions" class="hig-message-actions"><slot name="actions" /></div>
    <button v-if="dismissible" class="hig-icon-button" aria-label="关闭提示" @click="dismiss">
      <i class="pi pi-times" aria-hidden="true"></i>
    </button>
  </div>
</template>
