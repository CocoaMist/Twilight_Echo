export const EQ_DISPLAY_RANGES = [3, 6, 12, 30] as const
export type EqDisplayRange = (typeof EQ_DISPLAY_RANGES)[number]
export const EQ_MIN_FREQUENCY = 20
export const EQ_MAX_FREQUENCY = 20000

export function frequencyToPercent(frequency: number): number {
  const bounded = Math.min(EQ_MAX_FREQUENCY, Math.max(EQ_MIN_FREQUENCY, frequency))
  return (
    (Math.log10(bounded / EQ_MIN_FREQUENCY) / Math.log10(EQ_MAX_FREQUENCY / EQ_MIN_FREQUENCY)) * 100
  )
}

export function percentToFrequency(percent: number): number {
  return (
    EQ_MIN_FREQUENCY *
    (EQ_MAX_FREQUENCY / EQ_MIN_FREQUENCY) ** (Math.min(100, Math.max(0, percent)) / 100)
  )
}

export function gainToPercent(gain: number, rangeDb = 18, bounded = true): number {
  const y = 50 - (gain / rangeDb) * 50
  return bounded ? Math.min(100, Math.max(0, y)) : y
}

export function percentToGain(percent: number, rangeDb = 18): number {
  return Math.round((1 - Math.min(100, Math.max(0, percent)) / 50) * rangeDb * 10) / 10
}

export function gainTicksForRange(rangeDb: EqDisplayRange): number[] {
  return [rangeDb, (rangeDb * 2) / 3, rangeDb / 3, 0, -rangeDb / 3, (-rangeDb * 2) / 3, -rangeDb]
}

export function responseToPath(
  response: { frequency: number; db: number }[],
  rangeDb = 18,
  bounded = true
): string {
  return response
    .map((point, index) => {
      const x = frequencyToPercent(point.frequency)
      const y = gainToPercent(point.db, rangeDb, bounded)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

export function formatFrequency(frequency: number): string {
  if (frequency >= 1000) return (frequency / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return Math.round(frequency).toString()
}
