import { onBeforeUnmount, onMounted, type Ref } from 'vue'

type DialogLifecycle = { finish: () => void }
const lifecycles = new WeakMap<HTMLDialogElement, DialogLifecycle>()
const managed = new WeakSet<HTMLDialogElement>()

/** A transition owns the native top layer until its leave has completed. */
export function manageNativeDialog(dialog: HTMLDialogElement): void {
  managed.add(dialog)
}

export function finishNativeDialog(dialog: HTMLDialogElement): void {
  managed.delete(dialog)
  lifecycles.get(dialog)?.finish()
}

export function useNativeDialog(
  dialog: Ref<HTMLDialogElement | null>,
  restoreFocus?: () => HTMLElement | null | undefined
): void {
  let element: HTMLDialogElement | null = null
  onMounted(() => {
    element = dialog.value
    if (!element) return
    const target =
      restoreFocus?.() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const current = element
    let finished = false
    lifecycles.set(current, {
      finish() {
        if (finished) return
        finished = true
        lifecycles.delete(current)
        current.close()
        // A newer modal owns focus when an outgoing modal was replaced rapidly.
        const modal = document.querySelector('dialog:modal')
        if (target?.isConnected && (!modal || modal.contains(target))) {
          target.focus({ preventScroll: true })
        }
      }
    })
    current.showModal()
  })
  onBeforeUnmount(() => {
    if (element && !managed.has(element)) finishNativeDialog(element)
  })
}
