export class NativeQueueRevisionFence {
  private revision = 0
  private mutationTail: Promise<unknown> = Promise.resolve()

  /** Queue commits, mode changes and explicit native starts share one lane.
   * A background resync must not supersede prepareAndLoad before play starts. */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.catch(() => {})
    return result
  }

  next(): number {
    this.revision += 1
    return this.revision
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision
  }

  async runLatest<T>(
    revision: number,
    operation: () => Promise<T>
  ): Promise<{
    applied: boolean
    value?: T
  }> {
    if (!this.isCurrent(revision)) return { applied: false }
    const value = await operation()
    return this.isCurrent(revision) ? { applied: true, value } : { applied: false }
  }

  get current(): number {
    return this.revision
  }
}

export interface RevisionedNativeQueueSync<T> {
  prepare: () => Promise<T | null>
  loadQueue: (prepared: T) => Promise<void>
  setPlayMode: (prepared: T) => Promise<void>
}

export interface RevisionedNativeQueueResult<T> {
  applied: boolean
  prepared: T | null
  /** Set when the loadQueue step was rejected by main rather than superseded. */
  loadQueueError?: unknown
}

/**
 * Runs the production prepare -> loadQueue -> setPlayMode chain under one
 * revision. Later revisions may not commit stale prepared state or settings.
 *
 * A rejected loadQueue resolves to `prepared: null` with the reason attached
 * instead of rejecting. Callers treat a null prepared queue as "leave the engine
 * as it is", and this path is reached from fire-and-forget resynchronization
 * (play-mode switches, queue edits), where a rejection would surface only as an
 * unhandled rejection while the caller kept believing the queue was delegated.
 */
export async function synchronizeLatestNativeQueue<T>(
  fence: NativeQueueRevisionFence,
  revision: number,
  sync: RevisionedNativeQueueSync<T>
): Promise<RevisionedNativeQueueResult<T>> {
  const preparedResult = await fence.runLatest(revision, sync.prepare)
  if (!preparedResult.applied) return { applied: false, prepared: null }
  const prepared = preparedResult.value ?? null
  if (!prepared) return { applied: true, prepared: null }

  let loadResult: { applied: boolean; value?: void }
  try {
    loadResult = await fence.runLatest(revision, () => sync.loadQueue(prepared))
  } catch (error) {
    return { applied: true, prepared: null, loadQueueError: error }
  }
  if (!loadResult.applied) return { applied: false, prepared: null }

  const modeResult = await fence.runLatest(revision, () => sync.setPlayMode(prepared))
  return modeResult.applied ? { applied: true, prepared } : { applied: false, prepared: null }
}
