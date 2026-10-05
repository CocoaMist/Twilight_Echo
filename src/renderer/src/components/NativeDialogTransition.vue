<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { finishNativeDialog, manageNativeDialog } from '@renderer/composables/useNativeDialog'
import { documentMotionMode } from '@renderer/app/scrollMotion'
import './nativeDialogMotion.css'

// Legacy overlays share the same completion, interruption and focus lifecycle.
const props = defineProps<{ overlay?: boolean; restoreFocus?: HTMLElement | null }>()
const overlayFocus = new Map<HTMLElement, HTMLElement | null>()
const dialogs = new Set<HTMLDialogElement>()
const mode = ref(documentMotionMode())
const pending = new Map<Element, { finish: () => void; cancel: () => void }>()
let observer: MutationObserver | undefined
let media: MediaQueryList | undefined
function transition(element: Element, done: () => void, leaving: boolean): void {
  pending.get(element)?.cancel()
  if (documentMotionMode() === 'off') {
    done()
    return
  }
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const phase = `${props.overlay ? 'overlay-dialog' : 'native-dialog'}-${leaving ? 'leave' : 'enter'}-to`
  const cancel = (): void => {
    cancelled = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    pending.delete(element)
  }
  const finish = (): void => {
    if (cancelled) return
    cancel()
    done()
  }
  pending.set(element, { finish, cancel })
  // Bind completion to this phase's animation; a queued enter event may arrive
  // after leave has already installed its completion handler.
  const capture = (): void => {
    if (cancelled) return
    if (!element.classList.contains(phase)) {
      frame = requestAnimationFrame(capture)
      return
    }
    getComputedStyle(element).getPropertyValue('opacity')
    const animations = element
      .getAnimations()
      .filter(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === 'opacity'
      )
    const duration = documentMotionMode() === 'reduced' ? 120 : leaving ? 160 : 200
    timer = setTimeout(finish, duration + 30)
    if (animations.length) {
      void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish)
    }
  }
  frame = requestAnimationFrame(capture)
}
function enter(element: Element, done: () => void): void {
  transition(element, done, false)
}
function leave(element: Element, done: () => void): void {
  transition(element, done, true)
}
function cancelled(element: Element): void {
  pending.get(element)?.cancel()
}
function beforeEnter(element: Element): void {
  if (element instanceof HTMLElement) {
    element.inert = false
    if (props.overlay && !overlayFocus.has(element)) {
      overlayFocus.set(
        element,
        props.restoreFocus ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      )
    }
  }
  if (!(element instanceof HTMLDialogElement)) return
  dialogs.add(element)
  manageNativeDialog(element)
  element.inert = false
  element.removeEventListener('cancel', blockCancel, true)
}
function blockCancel(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}
function beforeLeave(element: Element): void {
  if (element instanceof HTMLElement) element.inert = true
  if (element instanceof HTMLDialogElement) {
    element.inert = true
    element.addEventListener('cancel', blockCancel, true)
  }
}
function afterLeave(element: Element): void {
  if (element instanceof HTMLElement && overlayFocus.has(element)) {
    const target = overlayFocus.get(element)
    overlayFocus.delete(element)
    const current = document.activeElement
    if (
      target?.isConnected &&
      (!current || current === document.body || element.contains(current)) &&
      !document.querySelector('dialog:modal')
    ) {
      target.focus({ preventScroll: true })
    }
  }
  if (!(element instanceof HTMLDialogElement)) return
  finishNativeDialog(element)
  dialogs.delete(element)
}
function leaveCancelled(element: Element): void {
  cancelled(element)
  if (element instanceof HTMLElement) element.inert = false
  if (element instanceof HTMLDialogElement) {
    element.inert = false
    element.removeEventListener('cancel', blockCancel, true)
  }
}
function preferenceChanged(): void {
  const next = documentMotionMode()
  if (mode.value === next) return
  mode.value = next
  for (const transition of [...pending.values()]) transition.finish()
}
onMounted(() => {
  observer = new MutationObserver(preferenceChanged)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-te-motion']
  })
  media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', preferenceChanged)
})
onBeforeUnmount(() => {
  for (const transition of [...pending.values()]) transition.cancel()
  observer?.disconnect()
  media?.removeEventListener('change', preferenceChanged)
  for (const dialog of dialogs) finishNativeDialog(dialog)
  dialogs.clear()
  for (const element of overlayFocus.keys()) afterLeave(element)
})
</script>

<template>
  <Transition
    :name="overlay ? 'overlay-dialog' : 'native-dialog'"
    :css="mode !== 'off'"
    appear
    @before-enter="beforeEnter"
    @enter="enter"
    @enter-cancelled="cancelled"
    @before-leave="beforeLeave"
    @leave="leave"
    @after-leave="afterLeave"
    @leave-cancelled="leaveCancelled"
  >
    <slot />
  </Transition>
</template>
