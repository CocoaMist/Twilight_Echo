import { inject, provide, ref, watch, type InjectionKey, type Ref } from 'vue'

const requestKey: InjectionKey<Ref<readonly string[]>> = Symbol('settings-search-disclosure')

/** Reveal controls without changing their saved values or enabling their prerequisites. */
export function provideSettingsSearchDisclosure(): (ids?: readonly string[]) => void {
  const requested = ref<readonly string[]>([])
  provide(requestKey, requested)
  return (ids = []) => {
    requested.value = [...ids]
  }
}

export function useSettingsSearchDisclosure(
  id: string,
  open: Ref<boolean>,
  onOpen?: () => void
): void {
  const requested = inject(requestKey, null)
  if (!requested) return
  watch(
    requested,
    (ids) => {
      if (ids.includes(id) && !open.value) {
        onOpen?.()
        open.value = true
      }
    },
    { immediate: true }
  )
}

export function revealSettingsDetails(target: HTMLElement): void {
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
  }
}
