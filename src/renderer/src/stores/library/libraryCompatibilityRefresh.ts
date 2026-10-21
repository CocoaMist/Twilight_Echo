/** Transitional full-document readers share one refresh. Database notifications
 * are committed revisions, never requests to run another filesystem scan.
 * Query windows refresh independently while a scan is running. */
export function createLibraryCompatibilityRefresh(options: {
  getRevision(): number
  isScanning(): boolean
  refresh(minimumRevision: number): Promise<number>
  onError(error: string): void
}) {
  let target = -1
  let pending: Promise<void> | null = null

  function flush(): Promise<void> {
    if (pending) return pending
    if (options.isScanning() || options.getRevision() >= target) return Promise.resolve()
    pending = Promise.resolve().then(async () => {
      try {
        while (!options.isScanning() && options.getRevision() < target) {
          const required = target
          const revision = await options.refresh(required)
          if (!Number.isSafeInteger(revision) || revision < required)
            throw new Error('兼容曲库快照版本过旧，请重试读取')
        }
        options.onError('')
      } catch (error: unknown) {
        options.onError(error instanceof Error ? error.message : String(error))
        throw error
      } finally {
        pending = null
      }
    })
    return pending
  }

  return {
    notify(revision: number): Promise<void> {
      if (!Number.isSafeInteger(revision) || revision < 0)
        return Promise.reject(new Error('无效的曲库版本通知'))
      target = Math.max(target, revision)
      return flush()
    },
    flush
  }
}
