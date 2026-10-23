import {
  AFTERGLOW_RESTORE_ACCELERATOR,
  type AfterglowModeStatus,
  type AfterglowModePhase
} from '../../shared/afterglowMode.ts'

export type CoreAfterglowEntry = 'manual' | 'minimize' | 'hide'
export interface CoreAfterglowOptions {
  ready(): boolean
  persistView(): Promise<void>
  unload(mode: CoreAfterglowEntry): void
  restoreWindow(): Promise<void>
  registerRestore(restore: () => void): string | null
  unregisterRestore(): void
  changed(): void
}

/** Afterglow owns presentation windows only. Core playback never transfers owners. */
export class CoreAfterglow {
  private phase: AfterglowModePhase = 'inactive'
  private error: string | null = null
  private accelerator: string | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly options: CoreAfterglowOptions
  constructor(options: CoreAfterglowOptions) {
    this.options = options
  }
  getStatus(): AfterglowModeStatus {
    return {
      phase: this.phase,
      active: this.phase !== 'inactive',
      restoreAccelerator: this.accelerator ?? AFTERGLOW_RESTORE_ACCELERATOR,
      error: this.error
    }
  }
  private enqueue(action: () => Promise<AfterglowModeStatus>): Promise<AfterglowModeStatus> {
    const work = this.tail.catch(() => undefined).then(action)
    this.tail = work
    return work
  }
  enter(mode: CoreAfterglowEntry): Promise<AfterglowModeStatus> {
    return this.enqueue(async () => {
      if (this.stopped || this.phase !== 'inactive') return this.getStatus()
      if (!this.options.ready()) return { ...this.getStatus(), error: 'Music Core 尚未就绪' }
      this.phase = 'entering'
      this.error = null
      this.options.changed()
      try {
        await this.options.persistView()
        if (this.stopped) return this.getStatus()
        this.accelerator = this.options.registerRestore(() => {
          void this.restore()
        })
        if (!this.accelerator && mode === 'manual')
          throw Error('afterglow_restore_shortcut_unavailable')
        this.options.unload(mode)
        this.phase = 'active'
      } catch (error) {
        this.options.unregisterRestore()
        this.accelerator = null
        this.phase = 'inactive'
        this.error = error instanceof Error ? error.message : String(error)
      }
      this.options.changed()
      return this.getStatus()
    })
  }
  restore(): Promise<AfterglowModeStatus> {
    return this.enqueue(async () => {
      if (this.stopped) return this.getStatus()
      const active = this.phase !== 'inactive'
      if (active) this.phase = 'restoring'
      this.options.changed()
      try {
        await this.options.restoreWindow()
        if (this.stopped) return this.getStatus()
        this.options.unregisterRestore()
        this.accelerator = null
        this.phase = 'inactive'
        this.error = null
      } catch (error) {
        this.phase = active ? 'active' : 'inactive'
        this.error = error instanceof Error ? error.message : String(error)
      }
      this.options.changed()
      return this.getStatus()
    })
  }
  reassertShortcuts(): void {
    if (this.phase === 'inactive' || this.stopped) return
    this.options.unregisterRestore()
    this.accelerator = this.options.registerRestore(() => {
      void this.restore()
    })
  }
  shutdown(): void {
    this.stopped = true
    this.options.unregisterRestore()
    this.phase = 'inactive'
    this.accelerator = null
  }
}
