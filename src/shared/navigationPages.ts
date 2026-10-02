export interface NavigationPagePreferences {
  version: 1
  order: string[]
  hidden: string[]
}

export function normalizeNavigationPagePreferences(value: unknown): NavigationPagePreferences {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  function ids(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [
      ...new Set(
        value.filter(
          (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256
        )
      )
    ].slice(0, 512)
  }
  return { version: 1, order: ids(input.order), hidden: ids(input.hidden) }
}
