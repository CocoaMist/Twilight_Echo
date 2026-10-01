import {
  workshopEditor,
  copyWorkshopDraft,
  type WorkshopAsset,
  type WorkshopProject,
  type ThemeEditorControl
} from './themeWorkshop.ts'
import { ensureThemeTextContrast, TWILIGHT_DEFAULT_THEME } from './theme.ts'
import type { WorkshopDiagnostic } from './themeWorkshopDiagnostics.ts'

export function workshopAssetBytes(asset: WorkshopAsset): number {
  const encoded = asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1)
  return (
    Math.floor((encoded.length * 3) / 4) -
    (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
  )
}

export function workshopAssetReferences(project: WorkshopProject, asset: WorkshopAsset): string[] {
  const references: string[] = []
  for (const [family, id] of Object.entries(project.fonts ?? {}))
    if (id === asset.id) references.push(`字体 · ${family}`)
  for (const tone of ['pureWhite', 'dark'] as const) {
    for (const [surface, layers] of Object.entries(project.layers?.[tone] ?? {}))
      for (const layer of layers)
        if (layer.assetId === asset.id)
          references.push(`${tone === 'dark' ? '深色' : '浅色'} · ${surface} · ${layer.name}`)
    for (const [id, value] of Object.entries(project.values[tone]))
      if (value.includes(asset.dataUrl))
        references.push(`${tone === 'dark' ? '深色' : '浅色'} · ${id}`)
  }
  for (const control of workshopEditor(project)?.controls ?? [])
    if (Object.values(control.defaults).some((value) => value.includes(asset.dataUrl)))
      references.push(`参数默认值 · ${control.label}`)
  if (project.css.includes(asset.dataUrl)) references.push('高级 CSS')
  const original = asset.originalDataUrl ?? asset.dataUrl
  if (
    project.base.css.includes(original) ||
    Object.values(project.base.variables).some((value) => value.includes(original))
  )
    references.push('来源样式')
  return references
}

export function replaceWorkshopAsset(
  project: WorkshopProject,
  assetId: string,
  replacement: WorkshopAsset
): WorkshopProject {
  const next = copyWorkshopDraft(project)
  const previous = next.assets?.find((asset) => asset.id === assetId)
  if (!previous || previous.type !== replacement.type) throw new Error('替换素材类型必须一致')
  const replace = (value: string): string => value.replaceAll(previous.dataUrl, replacement.dataUrl)
  next.assets = next.assets!.map((asset) =>
    asset.id === assetId
      ? {
          ...replacement,
          id: assetId,
          name: previous.name,
          license: previous.license,
          source: previous.source,
          originalDataUrl: previous.originalDataUrl ?? previous.dataUrl
        }
      : asset
  )
  for (const tone of ['pureWhite', 'dark'] as const)
    for (const [id, value] of Object.entries(next.values[tone]))
      next.values[tone][id] = replace(value)
  const editor = workshopEditor(next)
  if (
    editor?.controls.some((control) =>
      Object.values(control.defaults).some((value) => value.includes(previous.dataUrl))
    )
  ) {
    next.editor = {
      schemaVersion: 1,
      controls: editor.controls.map((control) => ({
        ...control,
        defaults: {
          pureWhite: replace(control.defaults.pureWhite),
          dark: replace(control.defaults.dark)
        }
      }))
    }
  }
  next.css = replace(next.css)
  return next
}

export function removeWorkshopControl(project: WorkshopProject, id: string): WorkshopProject {
  const next = copyWorkshopDraft(project)
  next.editor = {
    schemaVersion: 1,
    controls: (workshopEditor(next)?.controls ?? []).filter((control) => control.id !== id)
  }
  for (const tone of ['pureWhite', 'dark'] as const)
    for (const key of [id, `${id}.local`, `${id}.streaming`]) delete next.values[tone][key]
  delete next.unlinked?.[id]
  return next
}

export function setWorkshopControl(
  project: WorkshopProject,
  control: ThemeEditorControl
): WorkshopProject {
  const next = copyWorkshopDraft(project)
  const controls = workshopEditor(next)?.controls ?? []
  const previous = controls.find((item) => item.id === control.id)
  next.editor = {
    schemaVersion: 1,
    controls: previous
      ? controls.map((item) => (item.id === control.id ? control : item))
      : [...controls, control]
  }
  for (const tone of ['pureWhite', 'dark'] as const) {
    if (!previous || previous.defaults[tone] !== control.defaults[tone])
      next.values[tone][control.id] = control.defaults[tone]
  }
  return next
}

export function repairWorkshopDiagnostic(
  project: WorkshopProject,
  diagnostic: WorkshopDiagnostic
): WorkshopProject {
  const next = copyWorkshopDraft(project)
  const { id, tone = 'pureWhite', surface, kind } = diagnostic.location
  if (!id) return next
  if (diagnostic.repair === 'reset-control') delete next.values[tone][id]
  if (diagnostic.repair === 'reset-token') delete next.tokens[tone][id]
  if (diagnostic.repair === 'fix-contrast') {
    const tokens = {
      ...TWILIGHT_DEFAULT_THEME.variants[tone].tokens,
      ...next.base.structured?.variants[tone]?.tokens,
      ...next.tokens[tone]
    }
    const background =
      id === 'navigation.text'
        ? 'navigation.surface'
        : id === 'settings.text.primary'
          ? 'surface.settings'
          : 'surface.app'
    next.tokens[tone][id] = ensureThemeTextContrast(tokens[id], tokens[background])
    for (const control of workshopEditor(next)?.controls ?? [])
      if (control.token === id && !control.selector)
        next.values[tone][control.id] = next.tokens[tone][id]
  }
  if (diagnostic.repair === 'clear-reference') {
    if (kind === 'asset') delete next.fonts?.[id as keyof NonNullable<WorkshopProject['fonts']>]
    if (kind === 'layer' && surface) {
      const layer = next.layers?.[tone]?.[
        surface as keyof NonNullable<WorkshopProject['layers']>['dark']
      ]?.find((item) => item.id === id)
      if (layer) {
        layer.assetId = undefined
        layer.visible = false
      }
    }
  }
  return next
}
