import { isAppLocale, type AppLocale } from './i18n/locale.ts'

export interface AudioDiagnosticEnvironment {
  appName: string
  appVersion: string
  packaged: boolean
  platform: NodeJS.Platform
  architecture: string
  osRelease: string
  locale: string
  processVersions: {
    electron?: string
    chrome?: string
    node: string
    modules: string
  }
}

export interface AudioDiagnosticBlocker {
  code: string
  value?: unknown
  origin: 'player' | 'processing' | 'dsp-scene' | 'output'
}

export interface AudioDiagnosticEvent {
  eventId?: string
  timestamp: string
  sessionId: string
  sequence: number
  level: 'info' | 'warning' | 'error'
  event: string
  details: unknown
}

export interface AudioDiagnosticSnapshot {
  playback: unknown
  outputState: unknown
  outputConfig: unknown
  effectiveOutputConfig: unknown
  outputConfigApplyStatus: unknown
  configuredProcessing: unknown
  effectiveProcessing: unknown
  engineProcessing: unknown
  headphoneCompensation: unknown
  dspSceneState: unknown
  dspGraphStatus: unknown
  diagnosis: unknown
}

export interface AudioDiagnosticReport {
  schemaVersion: 1
  generatedAt: string
  sessionId: string
  /** Locale the human-readable companion report was rendered in. */
  locale?: string
  privacy: {
    audioPayloadCaptured: false
    fullLocalPathsCaptured: false
    urlQueryCaptured: false
    note: string
  }
  environment: AudioDiagnosticEnvironment
  snapshot: AudioDiagnosticSnapshot
  events: AudioDiagnosticEvent[]
}

export interface CoreAudioDiagnosticsQuery {
  locale: AppLocale
}
export function validCoreAudioDiagnosticsPayload(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).length === 1 && isAppLocale(payload.locale)
}
