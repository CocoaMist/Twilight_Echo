/**
 * Ceiling for a single native queue request.
 *
 * The renderer playback queue is virtualized for far larger lists (see
 * `docs/playback-queue-virtualization.md`, benchmarked at 20,000 entries), so a
 * whole-library queue can be much bigger than what one `audioEngine:loadQueue`
 * IPC call is willing to normalize and authorize. Both sides read this same
 * constant: the main process rejects a larger request, and the renderer degrades
 * to a current-only native queue before issuing one. Keeping the value here is
 * what stops the two layers from drifting apart — a renderer that sends more
 * than main accepts fails playback outright, on every output device, because the
 * rejection happens before `audioEngine:play` is ever reached.
 */
export const MAX_NATIVE_QUEUE_ITEMS = 5000

export interface NativeQueueCommit {
  queueToken: string
}

export interface NativeQueueSelection {
  queueToken: string
  index: number
  id: string
  source: string
}
