export type SpectrumRange = 60 | 90 | 100
export type SpectrumSpeed = 'fast' | 'medium' | 'slow'
const releaseSeconds: Record<SpectrumSpeed, number> = { fast: 0.12, medium: 0.3, slow: 0.9 }

export function spectrumDb(level: number): number {
  return Math.min(1, Math.max(0, level)) * 100 - 90
}

export function spectrumPath(levels: Float32Array, range: SpectrumRange): string {
  if (levels.length < 2) return ''
  return Array.from(levels, (level, index) => {
    const x = (index / (levels.length - 1)) * 100
    const amount = Math.max(0, Math.min(1, (spectrumDb(level) - (10 - range)) / range))
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${(98 - amount * 86).toFixed(2)}`
  }).join(' ')
}

export function accumulateSpectrumPeak(peak: Float32Array, input: Float32Array): void {
  for (let index = 0; index < peak.length; index++)
    peak[index] = Math.max(peak[index], input[index])
}

export function smoothSpectrum(
  displayed: Float32Array,
  target: Float32Array,
  elapsedMs: number,
  speed: SpectrumSpeed
): boolean {
  const attack = 1 - Math.exp(-elapsedMs / 60)
  const release = 1 - Math.exp(-elapsedMs / (releaseSeconds[speed] * 1000))
  let moving = false
  for (let index = 0; index < displayed.length; index++) {
    const delta = target[index] - displayed[index]
    displayed[index] += delta * (delta > 0 ? attack : release)
    if (Math.abs(target[index] - displayed[index]) > 0.0001) moving = true
  }
  return moving
}
