import { inject, nextTick, onBeforeUnmount, provide, ref, type InjectionKey, type Ref } from 'vue'

type Reveal = () => void | Promise<void>
export interface SettingsDisclosureRegistry {
  register: (id: string, reveal: Reveal) => () => void
  reveal: (id: string) => Promise<boolean>
}
const registryKey: InjectionKey<SettingsDisclosureRegistry> = Symbol('settings-disclosures')

export function provideSettingsDisclosures(): SettingsDisclosureRegistry {
  const disclosures = new Map<string, Reveal>()
  const registry: SettingsDisclosureRegistry = {
    register(id, reveal) {
      disclosures.set(id, reveal)
      return () => {
        if (disclosures.get(id) === reveal) disclosures.delete(id)
      }
    },
    async reveal(id) {
      const reveal = disclosures.get(id)
      if (!reveal) return false
      await reveal()
      await nextTick()
      return true
    }
  }
  provide(registryKey, registry)
  return registry
}

/** Use the same opening path for search and pointer input, including editor sessions. */
export function registerSettingsDisclosure(id: string, reveal: Reveal): void {
  const registry = inject(registryKey, null)
  const unregister = registry?.register(id, reveal)
  onBeforeUnmount(() => unregister?.())
}

export function useSettingsDisclosure(id: string, initiallyOpen = false): Ref<boolean> {
  const open = ref(initiallyOpen)
  registerSettingsDisclosure(id, () => {
    open.value = true
  })
  return open
}
