// Legacy callers retain platform defaults; portable audio owners receive a platform explicitly.
import { readFileSync } from 'node:fs'
import {
  getAudioOutputOptions as outputOptions,
  getDefaultAudioOutput as defaultOutput,
  normalizeAudioOutput as normalizeOutput,
  supportsAudioExclusive as supportsExclusive
} from '../../core/audio/audioEngineHelpers.ts'
import type { AudioOutputId } from '../../shared/audioEngineTypes.ts'
export * from '../../core/audio/audioEngineHelpers.ts'
export const getAudioOutputOptions = (platform: NodeJS.Platform = process.platform) =>
  outputOptions(platform)
export const getDefaultAudioOutput = (platform: NodeJS.Platform = process.platform) =>
  defaultOutput(platform)
export const normalizeAudioOutput = (
  output: unknown,
  platform: NodeJS.Platform = process.platform
): AudioOutputId => normalizeOutput(output, platform)
export const supportsAudioExclusive = (
  output: AudioOutputId,
  platform: NodeJS.Platform = process.platform
) => supportsExclusive(output, platform)

export function getAlsaPlaybackDeviceCandidates(): string[] {
  if (process.platform !== 'linux') return []
  try {
    const entries = readFileSync('/proc/asound/pcm', 'utf8')
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^(\d+)-(\d+):\s*(.*):\s*playback\b/)
        if (!match) return null
        const description = match[3].toLowerCase()
        const score = description.includes('usb') ? 0 : description.includes('hdmi') ? 2 : 1
        return {
          card: Number(match[1]),
          device: Number(match[2]),
          score
        }
      })
      .filter((entry): entry is { card: number; device: number; score: number } => Boolean(entry))
      .sort(
        (left, right) =>
          left.score - right.score || left.card - right.card || left.device - right.device
      )

    const candidates: string[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      for (const prefix of ['plughw', 'hw']) {
        const id = `${prefix}:${entry.card},${entry.device}`
        if (!seen.has(id)) {
          seen.add(id)
          candidates.push(id)
        }
      }
    }
    return candidates
  } catch {
    return []
  }
}
