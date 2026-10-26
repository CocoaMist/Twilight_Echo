import type { AppSettings } from '../../shared/appSettings.ts'
import type {
  AudioOutputState,
  AudioProcessingSettings,
  OutputConfig,
  OutputConfigApplyStatus,
  PlaybackInfo
} from '../../shared/audioEngineTypes.ts'
import type { DspGraphStatus, DspSceneState } from '../../shared/dspGraph.ts'
import type { AppLocale } from '../../shared/i18n/locale.ts'
import type {
  AudioDiagnosticEnvironment,
  AudioDiagnosticSnapshot,
  AudioDiagnosticReport
} from '../../shared/coreAudioDiagnostics.ts'
import { parseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { buildEffectiveAudioProcessingSettings } from './audioProcessingEffective.ts'
import {
  AudioDiagnosticRecorder,
  collectDsdPcmBlockers,
  createPlaybackDiagnosticEvent
} from './audioDiagnostics.ts'

export interface CoreAudioDiagnosticsEngine {
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
  getPlaybackInfo(): Promise<PlaybackInfo>
  getAudioOutputState(): Promise<AudioOutputState>
  getOutputConfig(): OutputConfig
  getEffectiveOutputConfig(): OutputConfig
  getOutputConfigApplyStatus(): OutputConfigApplyStatus
  getAudioProcessing(): AudioProcessingSettings
  getDspSceneState(): DspSceneState
  getDspGraphStatus(): Promise<DspGraphStatus>
  getNativeRuntimeIdentity(): Record<string, string> | null
  readEngineDiagnosticLog(cursor: number): Promise<string | null>
}
export interface CoreAudioDiagnosticsOptions {
  engine: CoreAudioDiagnosticsEngine
  settings(): AppSettings
  directory: string
  environment: AudioDiagnosticEnvironment
  failed(error: unknown): void
}

/** Durable audio evidence belongs to Core, not to the presence of a settings page. */
export class CoreAudioDiagnosticsService {
  private readonly options: CoreAudioDiagnosticsOptions
  private readonly recorder: AudioDiagnosticRecorder
  private signature = ''
  private cursor = 0
  private generation = 0
  private drainWork: Promise<void> | null = null
  private readonly eventListeners: [string, (event: unknown) => void][] = []
  constructor(options: CoreAudioDiagnosticsOptions) {
    this.options = options
    this.recorder = new AudioDiagnosticRecorder(options)
    options.engine.on('playback-info', this.observe)
    options.engine.on('audio-service-crash', this.crash)
    options.engine.on('audio-service-ready', this.recovered)
    options.engine.on('error', this.error)
    options.engine.on('audio-service-rpc-timeout', this.timeout)
    for (const [name, event, level] of [
      ['end-file', 'end-file', 'info'],
      ['start-file', 'start-file', 'info'],
      ['ready', 'engine-ready', 'info'],
      ['config-applied', 'output-config-applied', 'info'],
      ['loudnorm-status', 'loudnorm-status', 'info'],
      ['audio-device-options-changed', 'device-options-changed', 'info'],
      ['audio-service-stderr', 'audio-service-stderr', 'warning'],
      ['audio-service-stdout', 'audio-service-stdout', 'info']
    ] as const) {
      const listener = (details: unknown = {}) => this.recorder.record(event, details, level)
      this.eventListeners.push([name, listener])
      options.engine.on(name, listener)
    }
    this.recorder.record('session-start', {
      nativeRuntime: options.engine.getNativeRuntimeIdentity(),
      selectedOutput: this.selectedOutput(),
      outputConfig: options.settings().audioOutputConfig,
      configuredProcessing: options.settings().audioProcessing,
      effectiveProcessing: this.processing(),
      headphoneCompensation: this.compensation()
    })
  }
  private selectedOutput() {
    const settings = this.options.settings()
    return {
      output: settings.audioOutput,
      device: settings.audioDevice,
      exclusiveMode: settings.audioExclusiveMode
    }
  }
  private processing(): AudioProcessingSettings {
    const settings = this.options.settings()
    return buildEffectiveAudioProcessingSettings(
      settings.audioProcessing,
      settings.headphoneCompensation
    )
  }
  private compensation() {
    const value = this.options.settings().headphoneCompensation
    return {
      enabled: value.enabled,
      productId: value.productId,
      productName: value.productName,
      vendorName: value.vendorName,
      eqId: value.eqId,
      preampDb: value.preampDb,
      bandCount: value.bands.length
    }
  }
  private readonly observe = (info: PlaybackInfo): void => {
    try {
      const details = createPlaybackDiagnosticEvent({
        playback: info,
        processing: this.processing(),
        outputConfig: this.options.engine.getEffectiveOutputConfig(),
        sceneState: this.options.engine.getDspSceneState(),
        selectedOutput: this.selectedOutput()
      })
      const diagnostics = { ...(details.diagnostics as Record<string, unknown>) }
      for (const key of [
        'decodeBufferedFrames',
        'decodeProducedFrames',
        'decodeLastProgressAgeMs',
        'decodeStage',
        'liveRenderedFrames',
        'liveRenderCallbackCount'
      ])
        delete diagnostics[key]
      const signature = JSON.stringify({ ...details, position: 0, diagnostics })
      if (signature === this.signature) return
      this.signature = signature
      this.recorder.record(
        'playback-state',
        details,
        info.isDsd && info.dsdMode === 'pcm' ? 'warning' : 'info'
      )
      void this.drain('playback-state').catch(this.options.failed)
    } catch (error) {
      this.recorder.record(
        'diagnostic-collection-failed',
        { phase: 'playback-state', message: String(error) },
        'error'
      )
    }
  }
  private readonly crash = (event: unknown): void => {
    this.generation++
    this.cursor = 0
    this.signature = ''
    this.recorder.record('audio-service-crash', event, 'error')
  }
  private readonly recovered = (event: unknown): void => {
    this.generation++
    this.cursor = 0
    this.signature = ''
    this.recorder.record('audio-service-ready', event)
  }
  private readonly error = (event: unknown): void => {
    this.recorder.record('engine-error', event, 'error')
    void this.drain('engine-error').catch(this.options.failed)
  }
  private readonly timeout = (event: unknown): void => {
    this.recorder.record('audio-service-rpc-timeout', event, 'warning')
  }
  private drain(trigger: string): Promise<void> {
    if (this.drainWork) return this.drainWork
    const generation = this.generation
    const work = (async () => {
      const raw = await this.options.engine.readEngineDiagnosticLog(this.cursor)
      if (!raw || generation !== this.generation) return
      const entries = parseJsonWithNestingLimit(raw)
      if (!Array.isArray(entries)) return
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string') continue
        this.recorder.record(
          entry.event,
          {
            source: 'engine',
            trigger,
            engineSequence: entry.sequence ?? null,
            engineTimestamp: entry.timestamp ?? '',
            message: entry.message ?? '',
            ...(entry.details && typeof entry.details === 'object' ? entry.details : {})
          },
          entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info'
        )
        if (typeof entry.sequence === 'number') this.cursor = Math.max(this.cursor, entry.sequence)
      }
    })().finally(() => {
      if (this.drainWork === work) this.drainWork = null
    })
    this.drainWork = work
    return work
  }
  async report(locale: AppLocale): Promise<AudioDiagnosticReport> {
    this.recorder.record('diagnostic-export-requested', { locale })
    await this.drain('export')
    return this.recorder.buildReport(await this.snapshot(), locale)
  }
  private async snapshot(): Promise<AudioDiagnosticSnapshot> {
    const engine = this.options.engine
    const processing = this.processing(),
      sceneState = engine.getDspSceneState()
    const outputConfig = engine.getEffectiveOutputConfig()
    const capture = async <T>(read: () => Promise<T>) => {
      try {
        return await read()
      } catch (error) {
        return { error: String(error) }
      }
    }
    const rawPlayback = await capture(() => engine.getPlaybackInfo())
    // The report carries diagnosis, not native plugin internals or arbitrary native DTOs.
    const { nativeDsp: _nativeDsp, ...outputInfo } =
      'outputInfo' in rawPlayback ? rawPlayback.outputInfo : {}
    const playback =
      'outputInfo' in rawPlayback ? ({ ...rawPlayback, outputInfo } as PlaybackInfo) : rawPlayback
    return {
      playback,
      outputState: await capture(() => engine.getAudioOutputState()),
      outputConfig: engine.getOutputConfig(),
      effectiveOutputConfig: outputConfig,
      outputConfigApplyStatus: engine.getOutputConfigApplyStatus(),
      configuredProcessing: this.options.settings().audioProcessing,
      effectiveProcessing: processing,
      engineProcessing: engine.getAudioProcessing(),
      headphoneCompensation: this.compensation(),
      dspSceneState: sceneState,
      dspGraphStatus: await capture(() => engine.getDspGraphStatus()),
      diagnosis:
        'outputInfo' in playback
          ? {
              dsdPcmFallback: playback.isDsd && playback.dsdMode === 'pcm',
              perfectReasonCode: playback.perfectReasonCode,
              perfectReason: playback.perfectReason,
              blockers: collectDsdPcmBlockers({ playback, processing, outputConfig, sceneState }),
              nativeDsdRuntimeState: playback.outputInfo.nativeDsdRuntimeState,
              nativeDsdRuntimeReason: playback.outputInfo.nativeDsdRuntimeReason,
              nativeDsdNegotiation: playback.outputInfo.diagnostics.nativeDsdNegotiation ?? '',
              dopRuntimeEvidence: playback.outputInfo.diagnostics.dopRuntimeEvidence ?? ''
            }
          : { unavailable: true }
    }
  }
  async shutdown(): Promise<void> {
    const engine = this.options.engine
    engine.off('playback-info', this.observe)
    engine.off('audio-service-crash', this.crash)
    engine.off('audio-service-ready', this.recovered)
    engine.off('error', this.error)
    engine.off('audio-service-rpc-timeout', this.timeout)
    for (const [name, listener] of this.eventListeners) engine.off(name, listener)
    await this.drainWork
    await this.recorder.flush()
  }
}
