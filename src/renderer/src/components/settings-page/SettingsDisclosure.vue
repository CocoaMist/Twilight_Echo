<script lang="ts">
// Several disclosures can relocate the same later section. A new projection
// replaces the old one from its visible position, including across instances.
const siblingMotion = new WeakMap<HTMLElement, Animation>()
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { documentMotionMode } from '@renderer/app/scrollMotion'

defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    open: boolean
    tag?: string
    boundary?: string
    triggerSelector?: string
    keepMounted?: boolean
  }>(),
  { tag: 'div', boundary: '.settings-preview-stack' }
)
const root = ref<HTMLElement | null>(null)
const rendered = ref(props.open)
let contentAnimation: Animation | undefined
const movements = new Map<HTMLElement, Animation>()
let before = new Map<HTMLElement, DOMRect>()
let disposed = false
let observer: MutationObserver | undefined
let media: MediaQueryList | undefined
let motionMode = documentMotionMode()
const curve = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue('--te-ease-out-strong').trim() ||
  'cubic-bezier(0.23, 1, 0.32, 1)'

function capture(): void {
  before = new Map()
  let branch = root.value
  // Only siblings are projected: nested descendants must never move twice.
  while (branch && !branch.matches(props.boundary)) {
    let sibling = branch.nextElementSibling
    while (sibling) {
      if (sibling instanceof HTMLElement && sibling.getClientRects().length) {
        before.set(sibling, sibling.getBoundingClientRect())
      }
      sibling = sibling.nextElementSibling
    }
    branch = branch.parentElement
  }
  // Capture visual positions before cancelling an interrupted projection.
  for (const element of before.keys()) siblingMotion.get(element)?.cancel()
  for (const animation of movements.values()) animation.cancel()
  movements.clear()
}

function relocate(duration: number): void {
  if (disposed || documentMotionMode() !== 'full') return
  for (const [element, previous] of before) {
    if (!element.isConnected) continue
    const distance = previous.top - element.getBoundingClientRect().top
    if (Math.abs(distance) < 0.5) continue
    const base = getComputedStyle(element).transform
    const transform = base === 'none' ? '' : base
    const animation = element.animate(
      [{ transform: `translateY(${distance}px) ${transform}` }, { transform: base }],
      { duration, easing: curve() }
    )
    movements.set(element, animation)
    siblingMotion.set(element, animation)
    const release = (): void => {
      if (movements.get(element) === animation) movements.delete(element)
      if (siblingMotion.get(element) === animation) siblingMotion.delete(element)
    }
    void animation.finished.then(release, release)
  }
  before.clear()
}

function restoreTriggerFocus(): void {
  const panel = root.value
  const sibling = panel?.previousElementSibling
  const trigger = props.triggerSelector
    ? panel?.parentElement?.querySelector(props.triggerSelector)
    : sibling?.matches('button, input, [tabindex]')
      ? sibling
      : sibling?.querySelector('button, input, [tabindex]')
  if (trigger instanceof HTMLElement) trigger.focus({ preventScroll: true })
}

watch(
  () => props.open,
  (open) => {
    capture()
    if (open) rendered.value = true
    else if (root.value?.contains(document.activeElement)) {
      restoreTriggerFocus()
    }
  },
  { flush: 'sync' }
)

function animate(element: Element, opening: boolean, done: () => void): void {
  const panel = element as HTMLElement
  const mode = documentMotionMode()
  const interrupted = !!contentAnimation
  const style = getComputedStyle(panel)
  const from = {
    opacity: interrupted || !opening ? style.opacity : '0',
    transform:
      mode !== 'full' ? 'none' : interrupted || !opening ? style.transform : 'translateY(6px)'
  }
  contentAnimation?.cancel()
  contentAnimation = undefined
  if (!opening && panel.contains(document.activeElement)) {
    restoreTriggerFocus()
  }
  panel.inert = !opening
  if (mode === 'off') {
    done()
    return
  }
  const animation = panel.animate(
    [
      from,
      {
        opacity: opening ? '1' : '0',
        transform: opening || mode !== 'full' ? 'none' : 'translateY(6px)'
      }
    ],
    { duration: mode === 'reduced' ? 120 : opening ? 200 : 160, easing: curve(), fill: 'both' }
  )
  contentAnimation = animation
  void animation.finished.then(
    () => {
      if (contentAnimation !== animation) return
      contentAnimation = undefined
      done()
      animation.cancel()
    },
    () => undefined
  )
}
function enter(element: Element, done: () => void): void {
  animate(element, true, done)
  relocate(200)
}
function leave(element: Element, done: () => void): void {
  animate(element, false, done)
}
function afterLeave(): void {
  if (props.open) return
  if (!props.keepMounted) rendered.value = false
  // v-show applies display:none before this tick. Layout changes once; only
  // following content is translated, never the disclosure's height or text.
  void nextTick(() => relocate(120))
}
function settle(): void {
  const next = documentMotionMode()
  if (next === motionMode) return
  motionMode = next
  contentAnimation?.finish()
  for (const animation of movements.values()) animation.cancel()
  movements.clear()
}
onMounted(() => {
  observer = new MutationObserver(settle)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-te-motion']
  })
  media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', settle)
})
onBeforeUnmount(() => {
  disposed = true
  contentAnimation?.cancel()
  for (const animation of movements.values()) animation.cancel()
  observer?.disconnect()
  media?.removeEventListener('change', settle)
})
</script>

<template>
  <Transition :css="false" @enter="enter" @leave="leave" @after-leave="afterLeave">
    <component :is="tag" v-show="open" ref="root" v-bind="$attrs" :inert="!open">
      <slot v-if="rendered" />
    </component>
  </Transition>
</template>
