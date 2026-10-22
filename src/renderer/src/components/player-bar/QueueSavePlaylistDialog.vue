<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useNativeDialog } from '../../composables/useNativeDialog.ts'

const props = defineProps<{
  save: (name: string, signal: AbortSignal) => string | Promise<string> | null
}>()
const emit = defineEmits<{ close: []; saved: [id: string] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const name = ref('')
const pending = ref(false)
const error = ref('')
const cancellation = new AbortController()
const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
useNativeDialog(dialog, () => restoreTarget)
onBeforeUnmount(() => cancellation.abort())

function close(): void {
  cancellation.abort()
  emit('close')
}

async function submitSave(): Promise<void> {
  if (pending.value || !name.value.trim()) return
  pending.value = true
  error.value = ''
  try {
    const id = await props.save(name.value.trim(), cancellation.signal)
    if (cancellation.signal.aborted) return
    if (!id) throw new Error('队列中没有可保存的歌曲，请刷新后重试')
    emit('saved', id)
    emit('close')
  } catch (reason) {
    if (!cancellation.signal.aborted)
      error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="queue-save-dialog"
      aria-labelledby="queue-save-title"
      @cancel.prevent="close"
      @click.self="close"
      @keydown.stop
    >
      <form :aria-busy="pending" @submit.prevent="submitSave">
        <h2 id="queue-save-title">将队列存为歌单</h2>
        <label for="queue-save-name">歌单名称</label>
        <input
          id="queue-save-name"
          v-model="name"
          autofocus
          required
          maxlength="80"
          autocomplete="off"
          :disabled="pending"
        />
        <p class="queue-save-hint">同名普通歌单会追加歌曲，重复曲目只保留一首。</p>
        <p v-if="error" class="queue-save-error" role="alert">{{ error }}</p>
        <p v-if="pending" role="status">正在读取完整队列…</p>
        <footer>
          <button type="button" @click="close">取消</button>
          <button class="queue-save-confirm" type="submit" :disabled="pending || !name.trim()">
            {{ pending ? '保存中…' : '保存歌单' }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.queue-save-dialog {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(420px, calc(100vw - 40px));
  box-sizing: border-box;
  padding: 26px;
  border: 1px solid var(--te-neutral-300);
  border-radius: 20px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  font-family: var(--te-font-sans);
  box-shadow: 0 24px 80px #0003;
}
.queue-save-dialog::backdrop {
  background: #0006;
}
form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h2 {
  margin: 0 0 8px;
  font-size: 20px;
}
label,
p,
input,
button {
  font-size: var(--te-font-size-body, 14px);
}
input {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--te-neutral-300);
  border-radius: 9px;
  color: inherit;
  background: var(--te-card-bg);
  font-family: inherit;
}
p {
  margin: 0;
  line-height: 1.6;
}
.queue-save-hint {
  color: var(--te-neutral-600);
}
.queue-save-error {
  color: var(--te-danger-500, #dc2626);
  overflow-wrap: anywhere;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
button {
  padding: 9px 16px;
  border: 1px solid var(--te-neutral-300);
  border-radius: 9px;
  color: inherit;
  background: var(--te-card-bg);
  font-family: inherit;
  cursor: pointer;
}
.queue-save-confirm {
  border-color: var(--te-primary-500);
  color: #fff;
  background: var(--te-primary-500);
}
:global(:root[data-theme='dark'] .queue-save-confirm) {
  color: #181818;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
input:focus-visible,
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
</style>
