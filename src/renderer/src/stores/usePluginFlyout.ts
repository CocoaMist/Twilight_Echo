import { computed, ref } from 'vue'

export interface PluginFlyoutTarget {
  pluginId: string
  title: string
}

const target = ref<PluginFlyoutTarget | null>(null)

/** Host-owned right-side flyout for plugin panel experiences (titlebar entry). */
export function usePluginFlyout() {
  return {
    target: computed(() => target.value),
    open(next: PluginFlyoutTarget): void {
      target.value = next
    },
    toggle(next: PluginFlyoutTarget): void {
      target.value =
        target.value?.pluginId === next.pluginId ? null : next
    },
    close(): void {
      target.value = null
    }
  }
}
