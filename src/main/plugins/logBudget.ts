import { UtilityProcessLogBudget } from '../security/utilityProcessSafety.ts'

export const PLUGIN_LOG_LINE_BYTES = 4096
export const PLUGIN_LOG_WINDOW_BYTES = 256 * 1024
export const PLUGIN_LOG_PENDING_BYTES = 256 * 1024
export const PLUGIN_LOG_PENDING_LINES = 64

/** Bound text before redaction, IPC cloning, or stdout conversion. */
export class PluginLogBudget {
  private windowStarted = 0
  private capturedLines = 0
  private lineLimitNotified = false
  private readonly now: () => number
  private readonly budget = new UtilityProcessLogBudget(
    PLUGIN_LOG_WINDOW_BYTES,
    PLUGIN_LOG_LINE_BYTES
  )

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  capture(value: string | Buffer): { text: string | null; notice: string | null } {
    const now = this.now()
    if (now - this.windowStarted >= 1000) {
      this.windowStarted = now
      this.budget.reset()
      this.capturedLines = 0
      this.lineLimitNotified = false
    }
    if (++this.capturedLines > 256) {
      const notice = this.lineLimitNotified ? null : '[plugin log rate limit reached]'
      this.lineLimitNotified = true
      return { text: null, notice }
    }
    // Slicing first prevents allocating/converting an arbitrary multi-MiB log.
    const chunk = Buffer.isBuffer(value)
      ? value.subarray(0, PLUGIN_LOG_LINE_BYTES + 1)
      : Buffer.from(value.slice(0, PLUGIN_LOG_LINE_BYTES + 1), 'utf8')
    return this.budget.capture(chunk)
  }
}

type PendingLog = { line: string; bytes: number }
type WriteState = {
  queue: PendingLog[]
  bytes: number
  count: number
  dropped: number
  done: Promise<void>
}

/** Includes the active disk write in the admission budget. */
export class BoundedPluginLogQueue {
  private readonly states = new Map<string, WriteState>()
  private readonly write: (path: string, line: string) => Promise<void>

  constructor(write: (path: string, line: string) => Promise<void>) {
    this.write = write
  }

  append(path: string, line: string): boolean {
    const bytes = Buffer.byteLength(line)
    if (bytes > PLUGIN_LOG_PENDING_BYTES) return false
    let state = this.states.get(path)
    if (!state) {
      state = { queue: [], bytes: 0, count: 0, dropped: 0, done: Promise.resolve() }
      this.states.set(path, state)
    }
    if (state.count >= PLUGIN_LOG_PENDING_LINES || state.bytes + bytes > PLUGIN_LOG_PENDING_BYTES) {
      state.dropped++
      return false
    }
    state.queue.push({ line, bytes })
    state.bytes += bytes
    state.count++
    if (state.count === 1) state.done = this.drain(path, state)
    return true
  }

  async flush(path: string): Promise<void> {
    await this.states.get(path)?.done
  }

  pending(path: string): { bytes: number; count: number } {
    const state = this.states.get(path)
    return { bytes: state?.bytes ?? 0, count: state?.count ?? 0 }
  }

  private async drain(path: string, state: WriteState): Promise<void> {
    while (state.queue.length) {
      const entry = state.queue.shift()!
      await this.write(path, entry.line).catch(() => undefined)
      state.bytes -= entry.bytes
      state.count--
      if (state.dropped > 0) {
        const line = `[${new Date().toISOString()}] [warn] Plugin log backlog: dropped ${state.dropped} lines\n`
        const bytes = Buffer.byteLength(line)
        if (
          state.count < PLUGIN_LOG_PENDING_LINES &&
          state.bytes + bytes <= PLUGIN_LOG_PENDING_BYTES
        ) {
          state.dropped = 0
          state.queue.push({ line, bytes })
          state.bytes += bytes
          state.count++
        }
      }
    }
    this.states.delete(path)
  }
}
