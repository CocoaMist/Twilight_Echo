/**
 * Serializes mutating work for one plugin id without blocking unrelated
 * plugins. Settled entries are removed so the queue remains bounded by active
 * plugin operations rather than historical installs.
 */
export const MAX_PENDING_PLUGIN_OPERATIONS = 4

export class PluginOperationQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pendingCounts = new Map<string, number>()
  private readonly maxPendingOperations: number

  constructor(maxPendingOperations = MAX_PENDING_PLUGIN_OPERATIONS) {
    if (!Number.isInteger(maxPendingOperations) || maxPendingOperations < 1) {
      throw new Error('Plugin operation queue limit must be a positive integer.')
    }
    this.maxPendingOperations = maxPendingOperations
  }

  run<T>(pluginId: string, operation: () => Promise<T> | T): Promise<T> {
    const pendingCount = this.pendingCounts.get(pluginId) ?? 0
    if (pendingCount >= this.maxPendingOperations) {
      return Promise.reject(
        new Error(`Plugin ${pluginId} already has too many pending lifecycle operations.`)
      )
    }
    this.pendingCounts.set(pluginId, pendingCount + 1)
    const previous = this.tails.get(pluginId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(pluginId, tail)
    void tail.then(() => {
      if (this.tails.get(pluginId) === tail) this.tails.delete(pluginId)
      const remaining = (this.pendingCounts.get(pluginId) ?? 1) - 1
      if (remaining > 0) this.pendingCounts.set(pluginId, remaining)
      else this.pendingCounts.delete(pluginId)
    })
    return result
  }

  get activePluginCount(): number {
    return this.tails.size
  }
}
