export const STATIC_WAVEFORM_BIN_COUNT = 2000

const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < chars.length; i += 1) {
    table[chars.charCodeAt(i)] = i
  }
  return table
})()

export function decodeBase64Bytes(encoded: string): Uint8Array {
  const clean = encoded.trim()
  if (!clean) return new Uint8Array(0)
  const len = clean.length
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const byteLength = Math.max(0, Math.floor((len * 3) / 4) - pad)
  const out = new Uint8Array(byteLength)
  let outIndex = 0
  for (let i = 0; i < len; i += 4) {
    const c0 = clean.charCodeAt(i)
    const c1 = clean.charCodeAt(i + 1)
    const c2 = clean.charCodeAt(i + 2)
    const c3 = clean.charCodeAt(i + 3)
    const v0 = c0 < 128 ? BASE64_LOOKUP[c0] : -1
    const v1 = c1 < 128 ? BASE64_LOOKUP[c1] : -1
    const v2 = c2 < 128 && c2 !== 61 ? BASE64_LOOKUP[c2] : 0
    const v3 = c3 < 128 && c3 !== 61 ? BASE64_LOOKUP[c3] : 0
    if (v0 < 0 || v1 < 0) break
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3
    if (outIndex < byteLength) out[outIndex++] = (triple >> 16) & 0xff
    if (outIndex < byteLength) out[outIndex++] = (triple >> 8) & 0xff
    if (outIndex < byteLength) out[outIndex++] = triple & 0xff
  }
  return outIndex === byteLength ? out : out.subarray(0, outIndex)
}

/**
 * Decodes Base64 uint8 waveform peaks into normalized [0, 1] floats and
 * optionally downsamples/upsamples to `targetPoints` via max-pooling.
 */
export function decodeWaveformPeaks(
  waveformPeaksBase64: string | null | undefined,
  targetPoints = 160
): number[] {
  if (!waveformPeaksBase64 || typeof waveformPeaksBase64 !== 'string') return []
  const bytes = decodeBase64Bytes(waveformPeaksBase64)
  if (bytes.length === 0) return []
  const count = Math.max(1, Math.min(STATIC_WAVEFORM_BIN_COUNT, Math.trunc(targetPoints)))
  const result = new Array<number>(count)
  const n = bytes.length
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * n) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / count))
    let maxByte = 0
    for (let j = start; j < end && j < n; j += 1) {
      if (bytes[j]! > maxByte) maxByte = bytes[j]!
    }
    result[i] = Math.round((maxByte / 255) * 1000) / 1000
  }
  return result
}

export interface SilenceTrimBounds {
  trimStartSeconds: number
  trimEndSeconds: number
  trimmedLeadingMs: number
  trimmedTrailingMs: number
}

/**
 * Computes optional leading/trailing silence trim bounds ("second-layer gapless")
 * from offline `noiseStartMs` / `noiseEndMs` analysis when silence trimming is enabled.
 */
export function resolveSilenceTrimRange(
  durationSeconds: number,
  noiseStartMs?: number | null,
  noiseEndMs?: number | null,
  maxTrimMs = 15000
): SilenceTrimBounds | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 1) return null
  const durationMs = durationSeconds * 1000
  const startMs =
    typeof noiseStartMs === 'number' && Number.isFinite(noiseStartMs)
      ? Math.max(0, Math.min(maxTrimMs, noiseStartMs))
      : 0
  const rawEndMs =
    typeof noiseEndMs === 'number' && Number.isFinite(noiseEndMs) && noiseEndMs > 0
      ? noiseEndMs
      : durationMs
  const trailingSilenceMs = Math.max(0, Math.min(maxTrimMs, durationMs - rawEndMs))
  const effectiveEndMs = durationMs - trailingSilenceMs
  if (effectiveEndMs - startMs < 1000) return null
  return {
    trimStartSeconds: startMs / 1000,
    trimEndSeconds: effectiveEndMs / 1000,
    trimmedLeadingMs: Math.round(startMs),
    trimmedTrailingMs: Math.round(trailingSilenceMs)
  }
}
