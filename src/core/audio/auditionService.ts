import type { CoreAuditionMeasure, CoreAuditionState } from '../../shared/coreDsp.ts'
import type { DspAuditionResult } from '../../shared/dspAudition.ts'
import type { DspAuditionManager, DspAuditionContext } from './dspAuditionManager.ts'
import type { CoreAudioOutputService } from './outputService.ts'

export class CoreAuditionService {
  private readonly measurements = new Set<Promise<DspAuditionResult>>()
  private readonly options: {
    manager: DspAuditionManager
    configuration: CoreAudioOutputService
    context(): Promise<DspAuditionContext>
  }
  constructor(options: CoreAuditionService['options']) {
    this.options = options
  }
  async state(): Promise<CoreAuditionState> {
    const result = await this.options.manager.status()
    return {
      revision: this.options.configuration.getRevision(),
      measuring: this.measurements.size > 0,
      result
    }
  }
  async measure(request: CoreAuditionMeasure, signal: AbortSignal): Promise<DspAuditionResult> {
    let task!: Promise<DspAuditionResult>
    await this.options.configuration.run(request.revision, signal, async () => {
      const { revision: _revision, ...input } = request
      const context = await this.options.context()
      task = this.options.manager.measure({ ...input, source: context.info.source })
      this.measurements.add(task)
      void task.then(
        () => this.settled(task),
        () => this.settled(task)
      )
    })
    return task
  }
  private settled(task: Promise<DspAuditionResult>): void {
    this.measurements.delete(task)
    this.options.configuration.changed()
  }
  select(
    revision: number,
    id: string,
    side: 'a' | 'b',
    signal: AbortSignal
  ): Promise<DspAuditionResult> {
    return this.options.configuration.run(revision, signal, () =>
      this.options.manager.select(id, side)
    )
  }
  end(revision: number, signal: AbortSignal): Promise<void> {
    return this.options.configuration.run(revision, signal, () => this.options.manager.end())
  }
  async shutdown(): Promise<void> {
    await this.options.configuration.serialize(() => this.options.manager.end())
    await Promise.allSettled([...this.measurements])
  }
}
