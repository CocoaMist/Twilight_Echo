import type {
  AudioCapabilitySupportState,
  AudioDeviceOption,
  OutputInfo,
  PlaybackInfo
} from './audioEngineTypes.ts'

// Device IDs identify candidates for probing; only reported capabilities can
// establish verified support. Both process layers use the same precedence.
export function normalizeAudioCapabilitySupportState(
  value: unknown
): AudioCapabilitySupportState | null {
  return value === 'verified' ||
    value === 'runtime-probed' ||
    value === 'unsupported' ||
    value === 'unknown'
    ? value
    : null
}

export function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

export function getDeviceBackend(option: Partial<AudioDeviceOption>): string {
  const id = String(option.id || '').toLowerCase()
  const raw =
    option.backend ||
    (id.startsWith('asio:')
      ? 'asio'
      : id.startsWith('wasapi:')
        ? 'wasapi'
        : id.startsWith('coreaudio:')
          ? 'coreaudio'
          : id.startsWith('alsa:') || id.startsWith('hw:') || id.startsWith('plughw:')
            ? 'alsa'
            : '')
  return String(raw || '').toLowerCase()
}

export function getDevicePathKind(option: Partial<AudioDeviceOption>): string {
  const explicit = String(option.pathKind || '').toLowerCase()
  if (explicit) return explicit
  const id = String(option.id || '').toLowerCase()
  if (id === 'auto' || id === 'default') return 'default'
  if (id.startsWith('hw:') || id.startsWith('alsa:hw:')) return 'hw'
  if (id.startsWith('plughw:') || id.startsWith('alsa:plughw:')) return 'plughw'
  if (id.startsWith('wasapi:')) return 'endpoint'
  if (id.startsWith('coreaudio:')) return 'hal'
  if (id.startsWith('asio:')) return 'asio'
  return ''
}

export function deriveDopSupportState(
  option: Partial<AudioDeviceOption>
): AudioCapabilitySupportState {
  const explicit = normalizeAudioCapabilitySupportState(option.dopSupportState)
  if (explicit) return explicit
  if (
    option.supportsDop === true ||
    hasNonEmptyArray(option.dopCarrierSampleRates) ||
    hasNonEmptyArray(option.dopCarrierFormats)
  ) {
    return 'verified'
  }
  if (option.supportsDop === false) return 'unsupported'

  const backend = getDeviceBackend(option)
  const pathKind = getDevicePathKind(option)
  if (
    option.isDefault === true ||
    backend === 'wasapi' ||
    backend === 'coreaudio' ||
    pathKind === 'default' ||
    pathKind === 'endpoint' ||
    pathKind === 'hal'
  ) {
    return 'runtime-probed'
  }
  if (backend === 'asio' || pathKind === 'asio') return 'unknown'
  return 'unknown'
}

export function deriveNativeDsdSupportState(
  option: Partial<AudioDeviceOption>
): AudioCapabilitySupportState {
  const explicit = normalizeAudioCapabilitySupportState(option.nativeDsdSupportState)
  if (explicit) return explicit
  if (
    option.supportsNativeDsd === true ||
    hasNonEmptyArray(option.nativeDsdSampleRates) ||
    hasNonEmptyArray(option.nativeDsdSampleFormats) ||
    hasNonEmptyArray(option.supportedDsdRates)
  ) {
    return 'verified'
  }
  if (option.supportsNativeDsd === false) return 'unsupported'

  const backend = getDeviceBackend(option)
  const pathKind = getDevicePathKind(option)
  if (
    backend === 'wasapi' ||
    backend === 'coreaudio' ||
    pathKind === 'endpoint' ||
    pathKind === 'hal'
  ) {
    return 'unsupported'
  }
  if (backend === 'alsa' && pathKind === 'hw') return 'runtime-probed'
  if (backend === 'asio' || pathKind === 'asio') return 'unknown'
  if (option.isDefault === true || pathKind === 'default') return 'unsupported'
  return 'unknown'
}

export function normalizeDsdState(
  canonicalOutput?: Partial<OutputInfo> | null,
  mirror?: Partial<PlaybackInfo> | null
): { isDsd: boolean; dsdMode: string; dsdRate: number } {
  const canonicalMode =
    typeof canonicalOutput?.dsdMode === 'string' ? canonicalOutput.dsdMode.trim() : ''
  const mirrorMode = typeof mirror?.dsdMode === 'string' ? mirror.dsdMode.trim() : ''
  const canonicalHasMode = canonicalMode.length > 0
  const modeIndicatesDsd = (mode: string): boolean =>
    mode === 'native' || mode === 'dop' || mode === 'unsupported'
  const canonicalIsDsd =
    typeof canonicalOutput?.isDsd === 'boolean'
      ? canonicalOutput.isDsd
      : canonicalHasMode
        ? modeIndicatesDsd(canonicalMode)
        : undefined
  const isDsd = canonicalIsDsd ?? (mirror?.isDsd === true || modeIndicatesDsd(mirrorMode))
  const rawMode = canonicalHasMode ? canonicalMode : mirrorMode
  const dsdMode = isDsd ? rawMode || 'unsupported' : 'pcm'
  const dsdRate = isDsd ? (canonicalOutput?.dsdRate ?? mirror?.dsdRate ?? 0) : 0
  return { isDsd, dsdMode, dsdRate }
}
