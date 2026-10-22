import type {
  LocalLibraryScanWorkerMessage,
  LocalLibraryScanWorkerRequest,
  RepairScanCall
} from '../../shared/localLibraryScan.ts'
import { PLAYLIST_REPAIR_BATCH_SIZE, validateRepairTracks } from '../../shared/playlistRepair.ts'

export class PlaylistRepairScanSession {
  readonly result: Promise<void>
  private resolve!: () => void
  private reject!: (error: Error) => void
  private timer?: NodeJS.Timeout
  private operation: Promise<void> | null = null
  private sequence = 0
  private stopped = false
  readonly id: string
  private readonly send: (message: LocalLibraryScanWorkerRequest) => void
  private readonly stopWorker: () => void
  private readonly processCall: (call: RepairScanCall) => Promise<void>
  private readonly watchdogMs: number
  constructor(
    id: string,
    send: (message: LocalLibraryScanWorkerRequest) => void,
    stopWorker: () => void,
    processCall: (call: RepairScanCall) => Promise<void>,
    watchdogMs: number
  ) {
    this.id = id
    this.send = send
    this.stopWorker = stopWorker
    this.processCall = processCall
    this.watchdogMs = watchdogMs
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.touch()
  }
  private touch(): void {
    clearTimeout(this.timer)
    if (!this.stopped && !this.operation)
      this.timer = setTimeout(
        () => this.fail(new Error('歌单候选扫描超时，请重新修复')),
        this.watchdogMs
      )
  }
  handle(message: LocalLibraryScanWorkerMessage): void {
    if (message.kind === 'ready' || message.requestId !== this.id || this.stopped) return
    if (message.kind === 'repair-result') {
      if (this.operation) {
        this.fail(new Error('候选扫描在批次确认前结束'))
        return
      }
      this.stopped = true
      clearTimeout(this.timer)
      if (message.error) this.reject(new Error(message.error))
      else this.resolve()
      return
    }
    if (message.kind !== 'repair-call') return
    if (this.operation || message.sequence !== this.sequence + 1) {
      this.fail(new Error('无效或无界的歌单候选扫描批次'))
      return
    }
    try {
      if (message.call.kind === 'append') validateRepairTracks(message.call.tracks)
      else if (
        message.call.kind !== 'authorize' ||
        !Array.isArray(message.call.paths) ||
        message.call.paths.length > PLAYLIST_REPAIR_BATCH_SIZE ||
        message.call.paths.some((path) => typeof path !== 'string' || !path || path.length > 32_768)
      )
        throw new Error('无效的候选路径授权请求')
    } catch (error) {
      this.fail(error)
      return
    }
    clearTimeout(this.timer)
    this.sequence = message.sequence
    const operation = Promise.resolve().then(() => this.processCall(message.call))
    this.operation = operation
    void operation
      .then(() => {
        if (!this.stopped)
          this.send({ kind: 'repair-ack', requestId: this.id, sequence: message.sequence })
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        if (this.operation === operation) this.operation = null
        this.touch()
      })
  }
  fail(error: unknown): void {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    this.stopWorker()
    // Finish any dispatched SQL append before the owner discards this index.
    void Promise.allSettled(this.operation ? [this.operation] : []).then(() =>
      this.reject(error instanceof Error ? error : new Error(String(error)))
    )
  }
}
