import {
  EQ_MIN_FREQUENCY,
  EQ_MAX_FREQUENCY,
  percentToFrequency
} from '@renderer/utils/eqViewport.ts'
export {
  frequencyToPercent,
  percentToFrequency,
  gainToPercent,
  percentToGain
} from '@renderer/utils/eqViewport.ts'
import type { EqualizerBand, EqualizerFilterType } from '../types/settings'

export const PARAMETRIC_EQ_MIN_FREQUENCY = EQ_MIN_FREQUENCY
export const PARAMETRIC_EQ_MAX_FREQUENCY = EQ_MAX_FREQUENCY
export const PARAMETRIC_EQ_MIN_GAIN = -24
export const PARAMETRIC_EQ_MAX_GAIN = 24
export const PARAMETRIC_EQ_MIN_Q = 0.1
export const PARAMETRIC_EQ_MAX_Q = 20
export const PARAMETRIC_EQ_MAX_BANDS = 32

const GAIN_FILTER_TYPES = new Set<EqualizerFilterType>(['peak', 'lowShelf', 'highShelf'])
const SPECTRUM_ATTACK_RATE = Math.log(1 - 0.42) / 0.06
const SPECTRUM_RELEASE_RATE = Math.log(1 - 0.18) / 0.06

export function clampEqValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function filterUsesGain(filterType: EqualizerFilterType): boolean {
  return GAIN_FILTER_TYPES.has(filterType)
}

export function displayBandGain(band: EqualizerBand): number {
  return filterUsesGain(band.filterType) ? band.gain : 0
}

export function adjustQByWheel(q: number, deltaY: number, fine = false): number {
  const sensitivity = fine ? 0.00045 : 0.0015
  const next = q * Math.exp(-deltaY * sensitivity)
  return Math.round(clampEqValue(next, PARAMETRIC_EQ_MIN_Q, PARAMETRIC_EQ_MAX_Q) * 100) / 100
}

export function createParametricBand(frequency: number, gain: number): EqualizerBand {
  return {
    frequency: Math.round(
      clampEqValue(frequency, PARAMETRIC_EQ_MIN_FREQUENCY, PARAMETRIC_EQ_MAX_FREQUENCY)
    ),
    gain: percentSafeGain(gain),
    q: 1,
    filterType: 'peak',
    enabled: true
  }
}

export function percentSafeGain(gain: number): number {
  return Math.round(clampEqValue(gain, -24, 24) * 10) / 10
}

export function spectrumToPath(
  spectrum: readonly number[],
  sampleRate: number,
  pointCount = 720
): string {
  return spectrumLevelsToPath(projectSpectrumLevels(spectrum, sampleRate, pointCount))
}

function roundedBassMagnitude(spectrum: readonly number[], low: number, mix: number): number {
  const start = spectrum[low] ?? 0
  const end = spectrum[low + 1] ?? start
  const leftDelta = start - (spectrum[Math.max(0, low - 1)] ?? start)
  const middleDelta = end - start
  const rightDelta = (spectrum[Math.min(spectrum.length - 1, low + 2)] ?? end) - end
  const startSlope =
    leftDelta * middleDelta > 0 ? (2 * leftDelta * middleDelta) / (leftDelta + middleDelta) : 0
  const endSlope =
    middleDelta * rightDelta > 0 ? (2 * middleDelta * rightDelta) / (middleDelta + rightDelta) : 0
  const squared = mix * mix
  const cubed = squared * mix
  const value =
    (2 * cubed - 3 * squared + 1) * start +
    (cubed - 2 * squared + mix) * startSlope +
    (-2 * cubed + 3 * squared) * end +
    (cubed - squared) * endSlope
  return clampEqValue(value, Math.min(start, end), Math.max(start, end))
}

export function projectSpectrumLevels(
  spectrum: readonly number[],
  sampleRate: number,
  pointCount = 720
): Float32Array {
  if (spectrum.length < 2 || sampleRate <= 0) return new Float32Array(0)
  const count = Math.max(16, Math.min(pointCount, 960))
  const nyquist = sampleRate * 0.5
  const maxFrequency = Math.min(PARAMETRIC_EQ_MAX_FREQUENCY, nyquist * 0.98)
  const levels = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const x = (index / (count - 1)) * 100
    const frequency = percentToFrequency(x)
    const leftFrequency = percentToFrequency(((index - 0.5) / (count - 1)) * 100)
    const rightFrequency = percentToFrequency(((index + 0.5) / (count - 1)) * 100)
    const binPosition = clampEqValue(
      (frequency / nyquist) * (spectrum.length - 1),
      0,
      spectrum.length - 1
    )
    const low = Math.floor(binPosition)
    const high = Math.min(spectrum.length - 1, low + 1)
    const mix = binPosition - low
    let rawMagnitude = (spectrum[low] ?? 0) * (1 - mix) + (spectrum[high] ?? 0) * mix
    if (frequency < 240 && low !== high) {
      const bassBlend = clampEqValue((240 - frequency) / 120, 0, 1)
      rawMagnitude += (roundedBassMagnitude(spectrum, low, mix) - rawMagnitude) * bassBlend
    }
    const firstBin = Math.ceil((leftFrequency / nyquist) * (spectrum.length - 1))
    const lastBin = Math.floor((rightFrequency / nyquist) * (spectrum.length - 1))
    for (let bin = firstBin; bin <= lastBin && bin < spectrum.length; bin += 1) {
      rawMagnitude = Math.max(rawMagnitude, spectrum[bin] ?? 0)
    }
    const magnitude = frequency > maxFrequency ? 0 : clampEqValue(rawMagnitude, 0, 1)
    levels[index] = magnitude
  }
  return levels
}

export function spectrumLevelsToPath(levels: ArrayLike<number>): string {
  if (levels.length < 2) return ''
  const points: string[] = []
  for (let index = 0; index < levels.length; index += 1) {
    const x = (index / (levels.length - 1)) * 100
    const y = 98 - levels[index] * 86
    points.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return points.join(' ')
}

export function advanceSpectrumLevels(
  displayed: Float32Array,
  target: Float32Array,
  elapsedMs: number
): boolean {
  const seconds = Math.max(0, elapsedMs) / 1000
  const attack = 1 - Math.exp(SPECTRUM_ATTACK_RATE * seconds)
  const release = 1 - Math.exp(SPECTRUM_RELEASE_RATE * seconds)
  let moving = false
  for (let index = 0; index < displayed.length; index += 1) {
    const difference = target[index] - displayed[index]
    displayed[index] += difference * (difference > 0 ? attack : release)
    if (Math.abs(target[index] - displayed[index]) > 0.0001) moving = true
  }
  return moving
}
