import { parse, walk, generate } from 'css-tree'
import type { WorkshopDiagnostic } from './themeWorkshopDiagnostics.ts'

const cache = new Map<string, WorkshopDiagnostic[]>()

export function diagnoseWorkshopCss(css: string, source: 'base' | 'draft'): WorkshopDiagnostic[] {
  const key = source + css
  const previous = cache.get(key)
  if (previous) return previous
  const diagnostics: WorkshopDiagnostic[] = []
  const add = (code: string, message: string, line = 1, column = 1): void => {
    const id = `${code}:${source}:${line}:${column}`
    if (!diagnostics.some((item) => item.id === id))
      diagnostics.push({
        id,
        code,
        message,
        severity: 'error',
        location: { kind: 'css', source, line, column }
      })
  }
  try {
    const ast = parse(css, {
      positions: true,
      onParseError: (error) => add('css.syntax', error.message, error.line, error.column)
    })
    walk(ast, (node) => {
      const position = node.loc?.start
      if (node.type === 'Atrule' && node.name.toLowerCase() === 'import')
        add(
          'css.import',
          '独立主题不能使用 @import，请将样式合并到此项目',
          position?.line,
          position?.column
        )
      if (node.type === 'Url' && !/^(?:data:|#)/i.test(node.value))
        add(
          'css.resource',
          '请通过素材库使用内嵌素材，外部或相对 URL 无法独立打包',
          position?.line,
          position?.column
        )
    })
  } catch (cause) {
    const error = cause as { message?: string; line?: number; column?: number }
    add('css.syntax', error.message ?? 'CSS 语法错误', error.line, error.column)
  }
  if (cache.size >= 4) cache.delete(cache.keys().next().value!)
  cache.set(key, diagnostics)
  return diagnostics
}

export function diagnoseWorkshopCssSupport(
  css: string,
  supports: (property: string, value: string) => boolean
): WorkshopDiagnostic[] {
  const diagnostics: WorkshopDiagnostic[] = []
  const ast = parse(css, { positions: true })
  walk(ast, (node) => {
    if (node.type !== 'Declaration' || node.property.startsWith('--')) return
    const value = generate(node.value)
    if (!supports(node.property, value))
      diagnostics.push({
        id: `css.unsupported:${node.loc?.start.offset}`,
        code: 'css.unsupported',
        severity: 'warning',
        message: `当前浏览器不支持 ${node.property}: ${value.slice(0, 100)}，该声明可能被忽略`,
        location: {
          kind: 'css',
          source: 'draft',
          line: node.loc?.start.line,
          column: node.loc?.start.column
        }
      })
  })
  return diagnostics
}
