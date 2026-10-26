<script setup lang="ts">
import { ref, useId } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'

defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const titleId = `album-metadata-title-${useId()}`
useNativeDialog(dialog)
</script>

<template>
  <dialog
    ref="dialog"
    class="album-metadata-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
  >
    <header class="album-metadata-dialog-heading">
      <div>
        <p>专辑资料</p>
        <h2 :id="titleId">{{ title }}</h2>
      </div>
      <button
        type="button"
        class="album-metadata-close"
        aria-label="关闭专辑资料"
        autofocus
        @click="emit('close')"
      >
        <i class="pi pi-times" aria-hidden="true"></i>
      </button>
    </header>
    <slot />
  </dialog>
</template>

<style scoped>
.album-metadata-dialog {
  position: fixed;
  inset: 0;
  width: min(1040px, calc(100vw - 48px));
  max-height: calc(100dvh - 64px);
  margin: auto;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid var(--te-card-border);
  border-radius: 20px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  box-shadow: 0 24px 90px rgb(0 0 0 / 25%);
  font: var(--te-font-size-body, 14px) var(--te-font-body, system-ui, sans-serif);
  overflow: auto;
}
.album-metadata-dialog::backdrop {
  background: rgb(8 12 20 / 55%);
}
.album-metadata-dialog-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 32px 20px;
}
.album-metadata-dialog-heading p {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--te-neutral-500);
}
.album-metadata-dialog-heading h2 {
  margin: 0;
  font-size: 23px;
  line-height: 1.35;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.album-metadata-close {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: 0;
  border-radius: 50%;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-700);
  cursor: pointer;
}
.album-metadata-close:hover {
  background: color-mix(in srgb, var(--te-neutral-500) 15%, transparent);
}
.album-metadata-close:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
@media (max-width: 640px) {
  .album-metadata-dialog {
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 24px);
    border-radius: 14px;
  }
  .album-metadata-dialog-heading {
    gap: 12px;
    padding: 22px 20px 16px;
  }
  .album-metadata-dialog-heading h2 {
    font-size: 19px;
  }
}
</style>
