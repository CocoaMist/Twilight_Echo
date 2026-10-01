<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAppDialog } from '../../app/useAppDialog.ts'
const { dialog, resolveDialog } = useAppDialog()
const panel = ref<HTMLElement | null>(null)
const inputValue = ref('')
let previousFocus: HTMLElement | null = null
let inertElements: Array<{ element: HTMLElement; inert: boolean }> = []
function restoreBackground(): void {
  for (const { element, inert } of inertElements) element.inert = inert
  inertElements = []
}
watch(
  () => dialog.value?.id,
  async (id, previousId) => {
    if (id && !previousId) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    inputValue.value = dialog.value?.input?.value ?? ''
    await nextTick()
    if (id) {
      if (!previousId) {
        const backdrop = panel.value?.closest('.hig-dialog-backdrop')
        inertElements = Array.from(document.body.children)
          .filter(
            (element): element is HTMLElement =>
              element instanceof HTMLElement &&
              element !== backdrop &&
              !element.matches('script, style, link')
          )
          .map((element) => ({ element, inert: element.inert }))
        inertElements.forEach(({ element }) => {
          element.inert = true
        })
      }
      const target = panel.value?.querySelector<HTMLElement>(
        dialog.value?.input ? 'input' : '[data-dialog-initial-focus]'
      )
      target?.focus()
      if (target instanceof HTMLInputElement) target.select()
    } else {
      restoreBackground()
      previousFocus?.focus()
      previousFocus = null
    }
  }
)
function confirm(): void {
  if (dialog.value?.input && !inputValue.value.trim()) return
  resolveDialog(dialog.value?.input ? inputValue.value.trim() : true)
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!dialog.value?.destructive) resolveDialog(null)
    return
  }
  if (event.key !== 'Tab') return
  const focusable = Array.from(
    panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
    ) ?? []
  )
  if (!focusable.length) return
  const first = focusable[0],
    last = focusable.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
onBeforeUnmount(restoreBackground)
</script>
<template>
  <Teleport to="body">
    <div
      v-if="dialog"
      class="hig-dialog-backdrop"
      @keydown="onKeydown"
      @click.self="!dialog.destructive && resolveDialog(null)"
    >
      <section
        ref="panel"
        class="hig-dialog"
        :role="dialog.destructive ? 'alertdialog' : 'dialog'"
        aria-modal="true"
        aria-labelledby="hig-dialog-title"
        aria-describedby="hig-dialog-message"
      >
        <header class="hig-dialog-header">
          <h2 id="hig-dialog-title">{{ dialog.title }}</h2>
        </header>
        <div class="hig-dialog-body">
          <p id="hig-dialog-message">{{ dialog.message }}</p>
          <form v-if="dialog.input" @submit.prevent="confirm">
            <label for="hig-dialog-input">{{ dialog.input.label }}</label
            ><input
              id="hig-dialog-input"
              v-model="inputValue"
              autocomplete="off"
              maxlength="200"
              required
            />
          </form>
        </div>
        <footer class="hig-dialog-actions">
          <button
            v-if="!dialog.informational"
            class="hig-button"
            data-dialog-initial-focus
            @click="resolveDialog(null)"
          >
            {{ dialog.cancelLabel ?? '取消' }}
          </button>
          <button
            class="hig-button hig-button-primary"
            :class="{ 'hig-button-destructive': dialog.destructive }"
            :data-dialog-initial-focus="dialog.informational ? '' : undefined"
            :disabled="!!dialog.input && !inputValue.trim()"
            @click="confirm"
          >
            {{ dialog.confirmLabel ?? '确认' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
