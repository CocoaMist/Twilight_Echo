import type { CoreStateRow } from './coreState.ts'

export interface EqualizerAutoPreamp {
  enabled: boolean
  manualDb: number | null
}

export function normalizeEqualizerAutoPreamp(
  value: EqualizerAutoPreamp | null | undefined
): EqualizerAutoPreamp | null {
  if (!value) return null
  const enabled = value.enabled === true
  return {
    enabled,
    manualDb:
      enabled &&
      typeof value.manualDb === 'number' &&
      Number.isFinite(value.manualDb) &&
      value.manualDb >= -24 &&
      value.manualDb <= 24
        ? value.manualDb
        : null
  }
}

/** Import once; subsequent native/preference commits use the same atomic settings file. */
export function importedEqualizerAutoPreamp(rows: CoreStateRow[]): EqualizerAutoPreamp {
  return normalizeEqualizerAutoPreamp({
    enabled: rows.find((row) => row.key === 'autoPreamp')?.value === true,
    manualDb: rows.find((row) => row.key === 'manualPreamp')?.value as number | null
  })!
}
