<script setup lang="ts">
import { ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'

defineProps<{ name: string }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
useNativeDialog(dialog)
</script>

<template>
  <dialog
    ref="dialog"
    class="workshop-delete-dialog"
    aria-labelledby="workshop-delete-title"
    @cancel.prevent="emit('close')"
  >
    <h2 id="workshop-delete-title">删除「{{ name }}」？</h2>
    <p>删除编辑项目及其备份。已经应用的主题仍可使用。</p>
    <div class="workshop-inline">
      <button @click="emit('close')">取消</button>
      <button class="workshop-danger" @click="emit('confirm')">删除编辑项目</button>
    </div>
  </dialog>
</template>
