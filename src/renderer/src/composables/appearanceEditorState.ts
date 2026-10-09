import { ref } from 'vue'
export type AppearanceEditorArea = 'background' | 'material' | 'advanced'
export const appearanceEditorOpen = ref(false)
export const appearanceFullWindowPreview = ref(false)
export const appearanceEditorArea = ref<AppearanceEditorArea>('background')
export function openAppearanceEditor(area: AppearanceEditorArea = 'background'): void {
  appearanceEditorArea.value = area
  appearanceEditorOpen.value = true
}
