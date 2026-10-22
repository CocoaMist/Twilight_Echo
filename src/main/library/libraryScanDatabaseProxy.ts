import { LIBRARY_SCAN_DATABASE_METHODS } from '../../shared/libraryDatabase.ts'
import type {
  LibraryScanDatabaseApi,
  LibraryScanDatabaseCall
} from '../../shared/libraryDatabase.ts'
import type {
  LocalLibraryScanWorkerRequest,
  LocalLibraryScanWorkerMessage
} from '../../shared/localLibraryScan.ts'

/** Scan-side RPC over the existing utility-process port. Outstanding requests
 * are bounded even when the database is slow or paused by a consistent backup. */
export function createScanDatabaseProxy(
  requestId: string,
  send: (message: LocalLibraryScanWorkerMessage) => void
) {
  let sequence = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const database = Object.fromEntries(
    LIBRARY_SCAN_DATABASE_METHODS.map((method) => [
      method,
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (pending.size >= 2) {
            reject(new Error('Scan database bridge is full'))
            return
          }
          const callId = ++sequence
          pending.set(callId, { resolve, reject })
          try {
            send({
              kind: 'database-call',
              requestId,
              callId,
              call: { method, args } as LibraryScanDatabaseCall
            })
          } catch (error) {
            pending.delete(callId)
            reject(error)
          }
        })
    ])
  ) as unknown as LibraryScanDatabaseApi
  return {
    database,
    handle(message: Extract<LocalLibraryScanWorkerRequest, { kind: 'database-response' }>) {
      const call = pending.get(message.callId)
      if (!call || message.requestId !== requestId) return
      pending.delete(message.callId)
      if (message.ok) call.resolve(message.value)
      else call.reject(new Error(message.error))
    },
    close() {
      for (const call of pending.values()) call.reject(new Error('Scan database bridge closed'))
      pending.clear()
    }
  }
}
