import type { ThemeTone } from './theme.ts'
import {
  normalizeThemeTokenValue,
  findUnsupportedThemeModeIds,
  findInvalidThemeShellLayoutFields,
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  themeContrastRatio
} from './theme.ts'
import { normalizeThemeEditor } from './themeEditor.ts'
import { validateWorkshopValue } from './themeWorkshopCompiler.ts'
import { workshopEditor, type WorkshopProject } from './themeWorkshop.ts'
import { workshopAssetReferences, workshopAssetBytes } from './themeWorkshopEditing.ts'
import { diagnoseWorkshopCss } from './themeWorkshopCssDiagnostics.ts'

export interface WorkshopDiagnosticLocation {
  kind: 'project' | 'control' | 'token' | 'css' | 'asset' | 'layer' | 'layout' | 'mode' | 'preview'
  id?: string
  tone?: ThemeTone
  surface?: string
  width?: number
  state?: string
  line?: number
  column?: number
  source?: 'base' | 'draft'
}

export interface WorkshopDiagnostic {
  id: string
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  location: WorkshopDiagnosticLocation
  repair?: 'reset-control' | 'reset-token' | 'clear-reference' | 'fix-contrast'
}

export interface WorkshopDiagnosticReport {
  diagnostics: WorkshopDiagnostic[]
  errors: number
  warnings: number
}

export function workshopDiagnosticReport(
  diagnostics: WorkshopDiagnostic[]
): WorkshopDiagnosticReport {
  return {
    diagnostics,
    errors: diagnostics.reduce((count, item) => count + Number(item.severity === 'error'), 0),
    warnings: diagnostics.reduce((count, item) => count + Number(item.severity === 'warning'), 0)
  }
}

export function diagnoseWorkshopProject(project: WorkshopProject): WorkshopDiagnosticReport {
  const diagnostics: WorkshopDiagnostic[] = []
  const add = (
    code: string,
    message: string,
    location: WorkshopDiagnosticLocation,
    severity: WorkshopDiagnostic['severity'] = 'error',
    repair?: WorkshopDiagnostic['repair']
  ): void => {
    diagnostics.push({
      id: `${code}:${JSON.stringify(location)}`,
      code,
      message,
      location,
      severity,
      repair
    })
  }
  if (!project.name.trim() || project.name.length > 160)
    add('project.name', '主题名称不能为空，且不能超过 160 个字符', { kind: 'project', id: 'name' })
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(project.version))
    add('project.version', '版本请使用 1.0.0 或 1.0.0-beta 等格式', {
      kind: 'project',
      id: 'version'
    })
  const editor = workshopEditor(project)
  if (editor && normalizeThemeEditor(editor)?.controls.length !== editor.controls.length)
    add('editor.descriptor', '参数声明包含重复 ID、无效绑定或不支持的配置', { kind: 'control' })
  const ids = new Set(editor?.controls.map((control) => control.id))
  for (const tone of ['pureWhite', 'dark'] as const) {
    for (const control of editor?.controls ?? []) {
      const keys =
        control.targets && project.unlinked?.[control.id]
          ? [`${control.id}.local`, `${control.id}.streaming`]
          : [control.id]
      for (const key of keys) {
        const value = project.values[tone][key] ?? control.defaults[tone]
        try {
          validateWorkshopValue(control, value)
        } catch (cause) {
          add(
            'control.value',
            cause instanceof Error ? cause.message : String(cause),
            { kind: 'control', id: key, tone },
            'error',
            'reset-control'
          )
        }
      }
    }
    for (const id of Object.keys(project.values[tone])) {
      if (!ids.has(id) && !ids.has(id.replace(/\.(local|streaming)$/, '')))
        add(
          'control.orphan',
          `参数 ${id} 已失效，可以清理`,
          { kind: 'control', id, tone },
          'warning',
          'reset-control'
        )
    }
    for (const [id, value] of Object.entries(project.tokens[tone])) {
      if (normalizeThemeTokenValue(id, value) === null)
        add(
          'token.value',
          `标准外观 ${id} 的值无效`,
          { kind: 'token', id, tone },
          'error',
          'reset-token'
        )
    }
    const tokens = {
      ...TWILIGHT_DEFAULT_THEME.variants[tone].tokens,
      ...project.base.structured?.variants[tone]?.tokens,
      ...project.tokens[tone]
    }
    for (const control of editor?.controls ?? []) {
      if (control.token && !control.selector && project.values[tone][control.id] !== undefined)
        tokens[control.token] = project.values[tone][control.id]
    }
    for (const [foreground, background] of [
      ['color.neutral.900', 'surface.app'],
      ['settings.text.primary', 'surface.settings'],
      ['navigation.text', 'navigation.surface']
    ] as const) {
      const ratio = themeContrastRatio(
        tokens[foreground],
        tokens[background],
        tokens['surface.app']
      )
      if (ratio !== null && ratio < 4.5)
        add(
          'contrast.tokens',
          `${THEME_TOKEN_DEFINITIONS.find((token) => token.id === foreground)?.label ?? foreground} 对比度为 ${ratio.toFixed(2)}:1，建议至少 4.5:1`,
          { kind: 'token', id: foreground, tone },
          'warning',
          'fix-contrast'
        )
    }
    for (const [surface, layers] of Object.entries(project.layers?.[tone] ?? {})) {
      for (const layer of layers) {
        if (
          layer.kind === 'image' &&
          (!layer.assetId ||
            !project.assets?.some((asset) => asset.id === layer.assetId && asset.type === 'image'))
        )
          add(
            'layer.asset',
            `${layer.name} 尚未选择有效图片`,
            { kind: 'layer', id: layer.id, surface, tone },
            layer.visible ? 'error' : 'warning',
            'clear-reference'
          )
        if (layer.visible && layer.blur > 20)
          add(
            'layer.blur',
            `${layer.name} 使用较强模糊，请检查预览性能`,
            { kind: 'layer', id: layer.id, surface, tone },
            'info'
          )
      }
    }
  }
  for (const id of findUnsupportedThemeModeIds(project.modes))
    add('mode.invalid', `不支持的组件模式：${id}`, { kind: 'mode', id })
  if (project.layout) {
    for (const id of findInvalidThemeShellLayoutFields(project.layout))
      add('layout.invalid', `无效窗口布局：${id}`, { kind: 'layout', id })
  }
  for (const [family, id] of Object.entries(project.fonts ?? {})) {
    if (!project.assets?.some((asset) => asset.id === id && asset.type === 'font'))
      add(
        'font.asset',
        `字体 ${family} 引用了不存在的素材`,
        { kind: 'asset', id: family },
        'error',
        'clear-reference'
      )
  }
  const assetIds = new Set<string>()
  for (const asset of project.assets ?? []) {
    if (assetIds.has(asset.id))
      add('asset.duplicate', `素材 ID 重复：${asset.name}`, { kind: 'asset', id: asset.id })
    assetIds.add(asset.id)
    if (workshopAssetBytes(asset) > 16 * 1024 * 1024)
      add('asset.size', `${asset.name} 超过单个素材 16 MB 上限`, { kind: 'asset', id: asset.id })
    if (!asset.license.trim())
      add(
        'asset.license',
        `${asset.name} 尚未填写许可或署名`,
        { kind: 'asset', id: asset.id },
        'warning'
      )
    if (!workshopAssetReferences(project, asset).length)
      add('asset.unused', `${asset.name} 尚未使用`, { kind: 'asset', id: asset.id }, 'info')
  }
  diagnostics.push(
    ...diagnoseWorkshopCss(project.base.css, 'base'),
    ...diagnoseWorkshopCss(project.css, 'draft')
  )
  return workshopDiagnosticReport(diagnostics)
}
