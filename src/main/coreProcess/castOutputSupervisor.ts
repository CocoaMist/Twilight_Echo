import type { CoreCastSafetyTarget } from '../../shared/coreCast.ts'

/** A stop-only lease, not a second Cast session owner. Main retains it before
 * remote LOAD so a lost Core process cannot leave an unsupervised output. */
export class CastOutputSupervisor {
  private target: CoreCastSafetyTarget | null = null
  private readonly stopTarget: (target: CoreCastSafetyTarget) => Promise<void>
  constructor(stopTarget: (target: CoreCastSafetyTarget) => Promise<void>) {
    this.stopTarget = stopTarget
  }
  arm(target: CoreCastSafetyTarget): void {
    if (this.target && this.target.deviceId !== target.deviceId)
      throw new Error('Previous Cast output has not confirmed Stop')
    this.target = structuredClone(target)
  }
  disarm(deviceId: string): void {
    if (this.target?.deviceId === deviceId) this.target = null
  }
  async stop(): Promise<void> {
    const target = this.target
    if (!target) return
    await this.stopTarget(target)
    if (this.target === target) this.target = null
  }
}
