export interface VolumePersistenceScheduler {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

export interface DebouncedVolumePersistence {
  schedule: (value: number) => void
  flush: (value: number) => Promise<void>
}

export function createDebouncedVolumePersistence(
  persist: (value: number) => Promise<void>,
  // Browser timers reject the scheduler object as their `this` receiver.
  scheduler: VolumePersistenceScheduler = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer)
  },
  delayMs = 280
): DebouncedVolumePersistence {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingValue: number | null = null
  let writes = Promise.resolve()

  const enqueue = (value: number): Promise<void> => {
    writes = writes.catch(() => undefined).then(() => persist(value))
    return writes
  }

  return {
    schedule(value: number): void {
      pendingValue = value
      if (timer != null) scheduler.clearTimeout(timer)
      timer = scheduler.setTimeout(() => {
        timer = null
        const next = pendingValue
        pendingValue = null
        if (next != null) void enqueue(next).catch(() => {})
      }, delayMs)
    },
    async flush(value: number): Promise<void> {
      if (timer != null) {
        scheduler.clearTimeout(timer)
        timer = null
      }
      pendingValue = null
      await enqueue(value)
    }
  }
}
