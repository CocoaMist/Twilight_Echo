interface IdentificationQuery {
  provider: string
  context: string
  method: string
  parameters: readonly unknown[]
}
export interface IdentificationResponse<T> {
  value: T
  retrievedAt: number
}
interface LoadedResponse<T> {
  value: T
  retention: 'positive' | 'negative' | false
}
interface Pending {
  provider: string
  controller: AbortController
  consumers: number
  promise: Promise<IdentificationResponse<unknown>>
}
interface Cached {
  provider: string
  response: IdentificationResponse<unknown>
  bytes: number
  expiresAt: number
}
interface CacheOptions {
  now?: () => number
  positiveTtlMs?: number
  negativeTtlMs?: number
  maxEntries?: number
  maxBytes?: number
  maxResponseBytes?: number
}

/** Session-only raw identity responses. Evidence and decisions never enter this cache. */
export class IdentificationResponseCache {
  private readonly pending = new Map<string, Pending>()
  private readonly cached = new Map<string, Cached>()
  private bytes = 0
  private readonly options: Required<CacheOptions>

  constructor(options: CacheOptions = {}) {
    this.options = {
      now: Date.now,
      positiveTtlMs: 5 * 60_000,
      negativeTtlMs: 60_000,
      maxEntries: 128,
      maxBytes: 8 * 1024 * 1024,
      maxResponseBytes: 2 * 1024 * 1024,
      ...options
    }
  }

  read<T>(
    query: IdentificationQuery,
    signal: AbortSignal,
    load: (signal: AbortSignal) => Promise<LoadedResponse<T>>
  ): Promise<IdentificationResponse<T>> {
    if (signal.aborted) return Promise.reject(signal.reason)
    this.prune()
    const key = JSON.stringify([query.provider, query.context, query.method, query.parameters])
    const cached = this.cached.get(key)
    if (cached) {
      this.cached.delete(key)
      this.cached.set(key, cached)
      return Promise.resolve(structuredClone(cached.response) as IdentificationResponse<T>)
    }
    let entry = this.pending.get(key)
    if (!entry) {
      const controller = new AbortController()
      const shared: Pending = {
        provider: query.provider,
        controller,
        consumers: 0,
        promise: Promise.resolve().then(async () => {
          controller.signal.throwIfAborted()
          const loaded = await load(controller.signal)
          controller.signal.throwIfAborted()
          const response = { value: structuredClone(loaded.value), retrievedAt: this.options.now() }
          if (loaded.retention) {
            const bytes = Buffer.byteLength(JSON.stringify(response))
            if (bytes <= this.options.maxResponseBytes && bytes <= this.options.maxBytes) {
              this.prune()
              this.cached.set(key, {
                provider: query.provider,
                response,
                bytes,
                expiresAt:
                  response.retrievedAt +
                  (loaded.retention === 'negative'
                    ? this.options.negativeTtlMs
                    : this.options.positiveTtlMs)
              })
              this.bytes += bytes
              while (
                this.cached.size > this.options.maxEntries ||
                this.bytes > this.options.maxBytes
              )
                this.remove(this.cached.keys().next().value!)
            }
          }
          return response
        })
      }
      this.pending.set(key, shared)
      void shared.promise
        .finally(() => {
          if (this.pending.get(key) === shared) this.pending.delete(key)
        })
        .catch(() => {})
      entry = shared
    }
    const shared = entry
    shared.consumers++
    const current = AbortSignal.any([signal, shared.controller.signal])
    return new Promise((resolve, reject) => {
      let done = false
      const finish = () => {
        if (done) return false
        done = true
        current.removeEventListener('abort', abort)
        if (--shared.consumers === 0 && this.pending.get(key) === shared) {
          this.pending.delete(key)
          shared.controller.abort(new Error('No identification response consumers'))
        }
        return true
      }
      const abort = () => {
        if (finish()) reject(current.reason)
      }
      current.addEventListener('abort', abort, { once: true })
      shared.promise.then(
        (response) => {
          if (finish()) resolve(structuredClone(response) as IdentificationResponse<T>)
        },
        (error) => {
          if (finish()) reject(error)
        }
      )
    })
  }

  invalidate(provider: string): void {
    for (const [key, entry] of this.cached) if (entry.provider === provider) this.remove(key)
    for (const [key, entry] of this.pending) {
      if (entry.provider !== provider) continue
      this.pending.delete(key)
      entry.controller.abort(new Error('Identification provider context changed'))
    }
  }

  private remove(key: string): void {
    this.bytes -= this.cached.get(key)!.bytes
    this.cached.delete(key)
  }
  private prune(): void {
    const now = this.options.now()
    for (const [key, entry] of this.cached) if (entry.expiresAt <= now) this.remove(key)
  }
}
