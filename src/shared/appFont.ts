/**
 * Global UI typography (设置 → 外观 → 全局字体).
 *
 * System typography follows Fluent's native platform stack. Theme typography
 * is an explicit preference; content typography remains separately configurable.
 */
type BuiltinAppFontFamily = 'system' | 'theme' | 'inter' | 'lxgw' | 'sarasa' | 'comic'
export type AppFontFamily = BuiltinAppFontFamily | `local:${string}`

export const APP_FONT_SYSTEM = 'system' as const

export const APP_FONT_FAMILIES: readonly AppFontFamily[] = [
  'system',
  'theme',
  'inter',
  'lxgw',
  'sarasa',
  'comic'
]

/**
 * Kept at the tail of every stack: the picked family may only ship Latin
 * glyphs, and the packaged MiSans subsets still have to cover CJK. Falling
 * straight to a bare `serif`/`cursive` would drop the whole UI onto SimSun.
 */
const FALLBACK_STACK =
  "'MiSans', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif"
export const APP_SYSTEM_FONT_STACK =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', 'MiSans', sans-serif"

export const APP_FONT_FAMILY_STACKS: Readonly<
  Record<Exclude<BuiltinAppFontFamily, 'system' | 'theme'>, string>
> = {
  inter: `'Inter', 'Plus Jakarta Sans', 'Roboto', ${FALLBACK_STACK}`,
  lxgw: `'LXGW WenKai', 'LXGW WenKai GB', '霞鹜文楷', 'KaiTi', 'STKaiti', ${FALLBACK_STACK}`,
  sarasa: `'Sarasa Gothic SC', 'Sarasa Gothic', '更纱黑体 SC', ${FALLBACK_STACK}`,
  comic: `'Comic Sans MS', 'Comic Sans', ${FALLBACK_STACK}`
}

/**
 * The three typography variables every surface renders through. Overriding only
 * `--te-font-sans` leaves titles and rounded chrome on the theme font, which
 * reads as "the setting did nothing" — the bug this contract exists to prevent.
 */
export const APP_FONT_VARIABLES = [
  '--te-font-sans',
  '--te-font-display',
  '--te-font-rounded'
] as const

export function normalizeAppFontFamily(value: unknown): AppFontFamily {
  if (
    typeof value === 'string' &&
    /^local:[^"'\\;{}]{1,96}$/.test(value) &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  ) {
    const name = value.slice(6).trim()
    if (name) return `local:${name}`
  }
  return typeof value === 'string' && APP_FONT_FAMILIES.includes(value as AppFontFamily)
    ? (value as AppFontFamily)
    : APP_FONT_SYSTEM
}

/** Only the explicit theme preference delegates typography to the theme. */
export function resolveAppFontStack(value: unknown): string | null {
  const family = normalizeAppFontFamily(value)
  if (family === APP_FONT_SYSTEM) return APP_SYSTEM_FONT_STACK
  if (family === 'theme') return null
  if (family.startsWith('local:')) return `"${family.slice(6)}", ${FALLBACK_STACK}`
  return APP_FONT_FAMILY_STACKS[family as Exclude<BuiltinAppFontFamily, 'system' | 'theme'>]
}

/**
 * Settings-owned CSS variables, merged into the theme runtime block so the
 * choice survives a theme re-apply and lands in the startup theme cache
 * (no font flash on launch).
 */
export function appFontCssVariables(value: unknown): Record<string, string> {
  const stack = resolveAppFontStack(value)
  if (!stack) return {}
  return Object.fromEntries(APP_FONT_VARIABLES.map((name) => [name, stack]))
}
