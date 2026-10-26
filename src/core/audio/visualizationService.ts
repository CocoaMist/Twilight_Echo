import type { VisualizationData, VisualizationOptions } from '../../shared/audioEngineTypes.ts'
import type {
  CoreVisualizationEvent,
  CoreVisualizationSubscribe
} from '../../shared/coreVisualization.ts'
import { normalizeVisualizationOptions } from './audioEngineHelpers.ts'
import { projectCoreError } from '../projections.ts'

interface Subscription {
  clientId: string
  id: string
  key: string
  sequence: number
}
interface Group {
  options: Required<VisualizationOptions>
}
interface Options {
  epoch: string
  engine: {
    setVisualizationDemand(enabled: boolean): Promise<void>
    readVisualizationDataAsync(options: VisualizationOptions): Promise<VisualizationData>
  }
  send(clientId: string, event: CoreVisualizationEvent): void
  schedule(callback: () => void, delayMs: number): () => void
}

/** One native read per option set; neither clients nor transport controls wait on FFT work. */
export class CoreVisualizationService {
  private readonly options: Options
  private readonly subscriptions = new Map<string, Map<string, Subscription>>()
  private readonly groups = new Map<string, Group>()
  private readonly reads = new Map<string, Promise<void>>()
  private stopTimer: (() => void) | null = null
  private gate: Promise<void> = Promise.resolve()
  private applied: boolean | null = null
  private stopped = false

  constructor(options: Options) {
    this.options = options
  }

  initialize(): Promise<void> {
    return this.updateDemand()
  }

  async subscribe(clientId: string, input: CoreVisualizationSubscribe): Promise<void> {
    if (this.stopped) throw new Error('Core visualization is shutting down')
    const normalized = normalizeVisualizationOptions(input.options)
    const key = JSON.stringify(normalized)
    let subscriptions = this.subscriptions.get(clientId)
    const previous = subscriptions?.get(input.subscriptionId)
    if (previous?.key === key) return this.updateDemand()
    if (!previous && (subscriptions?.size ?? 0) >= 8)
      throw new Error('At most eight visualization subscriptions are allowed per client')
    if (!this.groups.has(key) && this.groups.size >= 8)
      throw new Error('At most eight visualization option sets may be active')
    if (!subscriptions) {
      subscriptions = new Map()
      this.subscriptions.set(clientId, subscriptions)
    }
    const subscription = {
      clientId,
      id: input.subscriptionId,
      key,
      sequence: previous?.sequence ?? 0
    }
    subscriptions.set(input.subscriptionId, subscription)
    if (!this.groups.has(key)) this.groups.set(key, { options: normalized })
    if (previous) this.pruneGroup(previous.key)
    try {
      await this.updateDemand()
    } catch (error) {
      if (subscriptions.get(subscription.id) === subscription) {
        subscriptions.delete(subscription.id)
        if (!subscriptions.size) this.subscriptions.delete(clientId)
        this.pruneGroup(key)
      }
      throw error
    }
  }

  unsubscribe(clientId: string, id: string): Promise<void> {
    const subscriptions = this.subscriptions.get(clientId)
    const subscription = subscriptions?.get(id)
    if (subscription) {
      subscriptions!.delete(id)
      if (!subscriptions!.size) this.subscriptions.delete(clientId)
      this.pruneGroup(subscription.key)
    }
    return this.updateDemand()
  }

  disconnect(clientId: string): Promise<void> {
    const subscriptions = this.subscriptions.get(clientId)
    this.subscriptions.delete(clientId)
    for (const subscription of subscriptions?.values() ?? []) this.pruneGroup(subscription.key)
    return this.updateDemand()
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.subscriptions.clear()
    this.groups.clear()
    this.stopPolling()
    await this.updateDemand()
    await Promise.all(this.reads.values())
  }

  private pruneGroup(key: string): void {
    for (const subscriptions of this.subscriptions.values())
      for (const subscription of subscriptions.values()) if (subscription.key === key) return
    this.groups.delete(key)
    if (!this.groups.size) this.stopPolling()
  }

  private stopPolling(): void {
    this.stopTimer?.()
    this.stopTimer = null
  }

  private updateDemand(): Promise<void> {
    const work = this.gate
      .catch(() => {})
      .then(async () => {
        const wanted = !this.stopped && this.groups.size > 0
        if (this.applied !== wanted) {
          await this.options.engine.setVisualizationDemand(wanted)
          this.applied = wanted
        }
        if (wanted && !this.stopped && this.groups.size > 0 && !this.stopTimer)
          this.stopTimer = this.options.schedule(() => this.tick(), 60)
      })
    this.gate = work
    return work
  }

  private tick(): void {
    if (this.stopped || !this.applied) return
    for (const [key, group] of this.groups) {
      if (this.reads.has(key)) continue
      const readers = [...this.subscriptions.values()].flatMap((subscriptions) =>
        [...subscriptions.values()].filter((subscription) => subscription.key === key)
      )
      const read = this.options.engine
        .readVisualizationDataAsync(group.options)
        .then((data) => this.publish(readers, data))
        .catch((error) => this.publish(readers, null, projectCoreError(String(error))))
        .finally(() => {
          this.reads.delete(key)
        })
      this.reads.set(key, read)
    }
  }

  private publish(readers: Subscription[], data: VisualizationData | null, error?: string): void {
    if (this.stopped) return
    for (const reader of readers) {
      if (this.subscriptions.get(reader.clientId)?.get(reader.id) !== reader) continue
      this.options.send(reader.clientId, {
        kind: 'visualization',
        epoch: this.options.epoch,
        subscriptionId: reader.id,
        sequence: ++reader.sequence,
        data,
        ...(error ? { error } : {})
      })
    }
  }
}
