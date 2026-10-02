import type { EqMode, EqualizerBand, EqualizerFilterType } from '../types/settings'

/**
 * Exact RBJ biquad response math mirrored from the native engine
 * (audio-engine/dsp/ParametricEqProcessor.cpp) so the plotted curve matches
 * what the DSP chain actually applies. Keep coefficient formulas and
 * clamping in sync with the C++ side.
 */

export interface BiquadCoefficients {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface EqResponsePoint {
  frequency: number
  db: number
}

export interface EqResponseOptions {
  /** Display reference rate; the engine rebuilds filters at the device rate. */
  sampleRate?: number
  pointCount?: number
  minFrequency?: number
  maxFrequency?: number
  /** Graphic mode forces every band to a peak filter, exactly like the engine. */
  mode?: EqMode
}

export const EQ_RESPONSE_DEFAULT_SAMPLE_RATE = 48000
export const EQ_RESPONSE_DEFAULT_POINT_COUNT = 256
const DEFAULT_MIN_FREQUENCY = 20
const DEFAULT_MAX_FREQUENCY = 20000

/** Matches kGainEpsilonDb in ParametricEqProcessor.cpp. */
const GAIN_EPSILON_DB = 0.0001
const MAGNITUDE_FLOOR = 1e-12

const IDENTITY_COEFFICIENTS: BiquadCoefficients = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }

function clampFrequency(frequency: number, sampleRate: number): number {
  const nyquist = Math.max(1, sampleRate * 0.5)
  return Math.min(Math.max(frequency, 10), nyquist * 0.98)
}

function clampQ(q: number): number {
  return Math.min(Math.max(q, 0.1), 20)
}

function normalize(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number
): BiquadCoefficients {
  if (Math.abs(a0) < 1e-12) return { ...IDENTITY_COEFFICIENTS }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

export function computeBiquadCoefficients(
  type: EqualizerFilterType,
  frequency: number,
  gainDb: number,
  q: number,
  sampleRate: number = EQ_RESPONSE_DEFAULT_SAMPLE_RATE
): BiquadCoefficients {
  const clampedFrequency = clampFrequency(frequency, sampleRate)
  const clampedQ = clampQ(q)
  const w0 = (2 * Math.PI * clampedFrequency) / Math.max(1, sampleRate)
  const sinW0 = Math.sin(w0)
  const cosW0 = Math.cos(w0)
  const alpha = sinW0 / (2 * clampedQ)
  const a = 10 ** (gainDb / 40)

  switch (type) {
    case 'peak':
      return normalize(
        1 + alpha * a,
        -2 * cosW0,
        1 - alpha * a,
        1 + alpha / a,
        -2 * cosW0,
        1 - alpha / a
      )
    case 'lowShelf': {
      const sqrtA = Math.sqrt(a)
      const shelfAlpha = alpha
      return normalize(
        a * (a + 1 - (a - 1) * cosW0 + 2 * sqrtA * shelfAlpha),
        2 * a * (a - 1 - (a + 1) * cosW0),
        a * (a + 1 - (a - 1) * cosW0 - 2 * sqrtA * shelfAlpha),
        a + 1 + (a - 1) * cosW0 + 2 * sqrtA * shelfAlpha,
        -2 * (a - 1 + (a + 1) * cosW0),
        a + 1 + (a - 1) * cosW0 - 2 * sqrtA * shelfAlpha
      )
    }
    case 'highShelf': {
      const sqrtA = Math.sqrt(a)
      const shelfAlpha = alpha
      return normalize(
        a * (a + 1 + (a - 1) * cosW0 + 2 * sqrtA * shelfAlpha),
        -2 * a * (a - 1 + (a + 1) * cosW0),
        a * (a + 1 + (a - 1) * cosW0 - 2 * sqrtA * shelfAlpha),
        a + 1 - (a - 1) * cosW0 + 2 * sqrtA * shelfAlpha,
        2 * (a - 1 - (a + 1) * cosW0),
        a + 1 - (a - 1) * cosW0 - 2 * sqrtA * shelfAlpha
      )
    }
    case 'lowPass':
      return normalize(
        (1 - cosW0) * 0.5,
        1 - cosW0,
        (1 - cosW0) * 0.5,
        1 + alpha,
        -2 * cosW0,
        1 - alpha
      )
    case 'highPass':
      return normalize(
        (1 + cosW0) * 0.5,
        -(1 + cosW0),
        (1 + cosW0) * 0.5,
        1 + alpha,
        -2 * cosW0,
        1 - alpha
      )
    case 'bandPass':
      return normalize(alpha, 0, -alpha, 1 + alpha, -2 * cosW0, 1 - alpha)
    case 'allPass':
      return normalize(1 - alpha, -2 * cosW0, 1 + alpha, 1 + alpha, -2 * cosW0, 1 - alpha)
    case 'notch':
      return normalize(1, -2 * cosW0, 1, 1 + alpha, -2 * cosW0, 1 - alpha)
    default:
      return { ...IDENTITY_COEFFICIENTS }
  }
}

/** Evaluates |H(e^jw)| in dB for normalized biquad coefficients. */
export function magnitudeDbAtFrequency(
  coeffs: BiquadCoefficients,
  frequency: number,
  sampleRate: number = EQ_RESPONSE_DEFAULT_SAMPLE_RATE
): number {
  const w = (2 * Math.PI * frequency) / Math.max(1, sampleRate)
  const cos1 = Math.cos(w)
  const sin1 = Math.sin(w)
  const cos2 = Math.cos(2 * w)
  const sin2 = Math.sin(2 * w)

  // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
  const numReal = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2
  const numImag = -(coeffs.b1 * sin1 + coeffs.b2 * sin2)
  const denReal = 1 + coeffs.a1 * cos1 + coeffs.a2 * cos2
  const denImag = -(coeffs.a1 * sin1 + coeffs.a2 * sin2)

  const numMag = Math.hypot(numReal, numImag)
  const denMag = Math.hypot(denReal, denImag)
  const magnitude = numMag / Math.max(denMag, MAGNITUDE_FLOOR)
  return 20 * Math.log10(Math.max(magnitude, MAGNITUDE_FLOOR))
}

function effectiveFilterType(band: EqualizerBand, mode: EqMode): EqualizerFilterType {
  return mode === 'graphic' ? 'peak' : band.filterType
}

export function isBandActive(band: EqualizerBand, mode: EqMode = 'parametric'): boolean {
  if (band.enabled === false) return false
  const type = effectiveFilterType(band, mode)
  if (
    type === 'lowPass' ||
    type === 'highPass' ||
    type === 'bandPass' ||
    type === 'allPass' ||
    type === 'notch'
  )
    return true
  return Math.abs(band.gain) > GAIN_EPSILON_DB
}

export function sampleLogFrequencies(
  pointCount: number = EQ_RESPONSE_DEFAULT_POINT_COUNT,
  minFrequency: number = DEFAULT_MIN_FREQUENCY,
  maxFrequency: number = DEFAULT_MAX_FREQUENCY
): number[] {
  const count = Math.max(2, Math.floor(pointCount))
  const logMin = Math.log10(minFrequency)
  const logMax = Math.log10(maxFrequency)
  const frequencies: number[] = new Array(count)
  for (let index = 0; index < count; index++) {
    const ratio = index / (count - 1)
    frequencies[index] = 10 ** (logMin + ratio * (logMax - logMin))
  }
  return frequencies
}

/** Response of a single band; inactive bands (per engine rules) are flat. */
export function computeBandResponse(
  band: EqualizerBand,
  options: EqResponseOptions = {}
): EqResponsePoint[] {
  const sampleRate = options.sampleRate ?? EQ_RESPONSE_DEFAULT_SAMPLE_RATE
  const mode = options.mode ?? 'parametric'
  const frequencies = sampleLogFrequencies(
    options.pointCount,
    options.minFrequency,
    options.maxFrequency
  )
  if (!isBandActive(band, mode)) {
    return frequencies.map((frequency) => ({ frequency, db: 0 }))
  }
  const coeffs = computeBiquadCoefficients(
    effectiveFilterType(band, mode),
    band.frequency,
    band.gain,
    band.q,
    sampleRate
  )
  return frequencies.map((frequency) => ({
    frequency,
    db: magnitudeDbAtFrequency(coeffs, frequency, sampleRate)
  }))
}

/**
 * Composite response: sum of the per-band dB responses plus the preamp,
 * sampled at log-spaced points across the audible range.
 */
export function computeCompositeResponse(
  bands: EqualizerBand[],
  preampDb: number,
  options: EqResponseOptions = {}
): EqResponsePoint[] {
  const sampleRate = options.sampleRate ?? EQ_RESPONSE_DEFAULT_SAMPLE_RATE
  const mode = options.mode ?? 'parametric'
  const frequencies = sampleLogFrequencies(
    options.pointCount,
    options.minFrequency,
    options.maxFrequency
  )
  const totals = new Array<number>(frequencies.length).fill(preampDb)
  for (const band of bands) {
    if (!isBandActive(band, mode)) continue
    const coeffs = computeBiquadCoefficients(
      effectiveFilterType(band, mode),
      band.frequency,
      band.gain,
      band.q,
      sampleRate
    )
    for (let index = 0; index < frequencies.length; index++) {
      totals[index] += magnitudeDbAtFrequency(coeffs, frequencies[index], sampleRate)
    }
  }
  return frequencies.map((frequency, index) => ({ frequency, db: totals[index] }))
}

/**
 * Estimated source deviation relative to the unknown target that produced a
 * correction profile. This is the inverse of the correction filters only:
 * digital preamp/headroom is intentionally excluded because it is not an
 * acoustic property. The result is an estimate, not measured source response.
 */
export function computeEstimatedSourceDeviation(
  correctionBands: EqualizerBand[],
  options: EqResponseOptions = {}
): EqResponsePoint[] {
  const correction = computeCompositeResponse(correctionBands, 0, {
    ...options,
    mode: 'parametric'
  })
  return correction.map((point) => ({ frequency: point.frequency, db: -point.db }))
}

export interface AutoPreampOptions extends EqResponseOptions {
  /** Safety margin subtracted below the highest boost. */
  marginDb?: number
  minPreampDb?: number
  maxPreampDb?: number
}

/**
 * Gain compensation: negative of the highest positive dB in the band-only
 * composite response minus a safety margin, rounded to the 0.1 dB slider
 * step and clamped to the preamp range. Returns 0 when nothing boosts.
 */
export function computeAutoPreampDb(
  bands: EqualizerBand[],
  options: AutoPreampOptions = {}
): number {
  const marginDb = options.marginDb ?? 0.5
  const minPreampDb = options.minPreampDb ?? -24
  const maxPreampDb = options.maxPreampDb ?? 24
  const response = computeCompositeResponse(bands, 0, options)
  let maxPositiveDb = 0
  for (const point of response) {
    if (point.db > maxPositiveDb) maxPositiveDb = point.db
  }
  if (maxPositiveDb <= 0) return 0
  const target = -(maxPositiveDb + marginDb)
  const rounded = Math.round(target * 10) / 10
  return Math.min(maxPreampDb, Math.max(minPreampDb, rounded))
}
