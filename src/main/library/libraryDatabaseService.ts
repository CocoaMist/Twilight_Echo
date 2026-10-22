import {
  LibraryDatabase,
  LibraryDatabaseDurabilityError,
  openLibraryDatabase,
  type LibraryQueuePreparation,
  type LibrarySelectionPreparation
} from './libraryDatabase.ts'
import {
  DATABASE_METHODS,
  type LibraryDatabaseWorkerRequest,
  type LibraryDatabaseWorkerMessage
} from './libraryDatabaseProtocol.ts'
import { initializeUtilityDiagnostics } from '../diagnostics/utility.ts'
import type { LibraryQuery } from '../../shared/libraryDatabase.ts'
import type { LibrarySelectionRequest } from '../../shared/librarySelection.ts'
import { validateLibrarySelection } from './libraryDatabaseSelections.ts'

type Port = {
  postMessage(message: LibraryDatabaseWorkerMessage): void
  on(event: 'message', listener: (message: LibraryDatabaseWorkerRequest) => void): void
}
const electronPort = (
  process as unknown as {
    parentPort?: {
      postMessage(message: LibraryDatabaseWorkerMessage): void
      on(event: 'message', listener: (event: { data: LibraryDatabaseWorkerRequest }) => void): void
    }
  }
).parentPort
const port: Port | null = electronPort
  ? {
      postMessage: (message) => electronPort.postMessage(message),
      on: (_, listener) => electronPort.on('message', (event) => listener(event.data))
    }
  : process.send
    ? {
        postMessage: (message) => process.send?.(message),
        on: (_, listener) => process.on('message', listener)
      }
    : null
if (!port) throw new Error('Music library database requires a parent port')
const servicePort = port
initializeUtilityDiagnostics('twilight-library-database')
let database: LibraryDatabase | null = null
let closing = false
let serial = Promise.resolve()
let maintenanceScheduled = false
let maintenanceTimer: NodeJS.Timeout | undefined
type Work = {
  request: LibraryDatabaseWorkerRequest
  playlistToken?: symbol
  queue?: LibraryQueuePreparation
  selection?: LibrarySelectionPreparation
}

async function dispatch(work: Work): Promise<void> {
  const { request } = work
  if (request.kind === 'open') {
    try {
      if (database || closing) throw new Error('Database service was already opened')
      database = await openLibraryDatabase(request.libraryFilePath, request.coverCacheDir)
      // Explicitly cancelled or paused jobs stay that way. A running job belongs
      // to the previous process and can only resume from its committed checkpoint.
      database.sql.exec(
        "UPDATE scan_jobs SET state='interrupted' WHERE state='running'; UPDATE scan_items SET state='pending' WHERE state='working'; UPDATE scan_directories SET state='pending' WHERE state='working';"
      )
      servicePort.postMessage({ kind: 'opened' })
    } catch (error) {
      servicePort.postMessage({ kind: 'open-error', error: String(error) })
    }
    return
  }
  try {
    if (request.kind === 'close') {
      closing = true
      clearTimeout(maintenanceTimer)
      database?.close()
      database = null
      servicePort.postMessage({
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: undefined
      })
      return
    }
    if (!database || closing) throw new Error('Music library database is not open')
    if (!DATABASE_METHODS.has(request.method) || !Array.isArray(request.args))
      throw new Error('Unknown database method')
    if (request.method === 'createTrackSelection') {
      const selection = request.args[0] as LibrarySelectionRequest
      validateLibrarySelection(selection)
      if (!work.selection) {
        const prepared = database.preparePlaylistQuery(selection.query, work.playlistToken)
        if (!prepared.ready) {
          work.playlistToken = prepared.token
          setImmediate(() => enqueue(work))
          return
        }
        work.selection = database.beginTrackSelectionBuild(selection, work.playlistToken)
      }
      const result = database.advanceTrackSelectionBuild(work.selection)
      if (!result.ready) {
        setImmediate(() => enqueue(work))
        return
      }
      servicePort.postMessage({
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: result.snapshot
      })
      work.selection = undefined
      return
    }
    if (
      request.method === 'queryTracks' ||
      request.method === 'createLibraryQueue' ||
      (request.method === 'queryCollections' && request.args[0] === 'playlists')
    ) {
      const queryIndex = request.method === 'queryCollections' ? 1 : 0
      const query = (
        request.args[queryIndex] === undefined && request.method !== 'createLibraryQueue'
          ? {}
          : request.args[queryIndex]
      ) as LibraryQuery
      if (!work.queue) {
        const prepared = database.preparePlaylistQuery(query, work.playlistToken)
        if (!prepared.ready) {
          work.playlistToken = prepared.token
          request.args[queryIndex] = {
            ...query,
            contentRevision: prepared.revision,
            ...(query.sort === 'lastPlayed' ? { historyRevision: prepared.historyRevision } : {})
          }
          // Rejoin the serial owner's tail, rather than awaiting inside it. This
          // lets messages received in the meantime read/play/commit scan batches.
          setImmediate(() => enqueue(work))
          return
        }
      }
      if (request.method === 'createLibraryQueue') {
        work.queue ??= database.beginLibraryQueueBuild(
          query,
          request.args[1] as string | undefined,
          work.playlistToken
        )
        const result = database.advanceLibraryQueueBuild(work.queue)
        if (!result.ready) {
          // Once construction starts, its own revision fence and view token
          // stay fixed. A newer scan or dropped view abandons the hidden rows.
          setImmediate(() => enqueue(work))
          return
        }
        servicePort.postMessage({
          kind: 'response',
          requestId: request.requestId,
          ok: true,
          value: result.queue
        })
        work.queue = undefined
        return
      }
    }
    const method = database[request.method] as (...args: unknown[]) => unknown
    const value = await method.apply(database, request.args)
    servicePort.postMessage({ kind: 'response', requestId: request.requestId, ok: true, value })
  } catch (error) {
    if (error instanceof LibraryDatabaseDurabilityError) {
      console.error('[library-db] Unsafe database connection closed:', error)
      // The client rejects every pending operation and reopens/recovers only
      // on a later request; no uncertain mutation is silently replayed.
      process.exit(1)
    }
    if (work.queue && database && !closing) {
      try {
        database.abandonLibraryQueueBuild(work.queue)
      } catch (cleanupError) {
        // Retain a cleanup intent and its capacity slot, even if marking the
        // state fails. Retry maintenance on later activity, not a busy loop.
        console.error('[library-db] Queue abandonment failed:', cleanupError)
      }
      work.queue = undefined
    }
    if (work.selection && database && !closing) {
      database.abandonTrackSelectionBuild(work.selection)
      work.selection = undefined
    }
    servicePort.postMessage({
      kind: 'response',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function scheduleMaintenance(): void {
  clearTimeout(maintenanceTimer)
  maintenanceTimer = undefined
  if (maintenanceScheduled || closing || !database) return
  if (!database.needsQueryMaintenance) {
    const expiry = database.nextQueueBuildExpiry
    if (expiry !== undefined) {
      // Expiry rejoins the serial SQL owner; no timer mutates the connection or
      // polls a healthy build. A new successful page moves this one deadline.
      maintenanceTimer = setTimeout(scheduleMaintenance, Math.max(1, expiry - Date.now()))
      maintenanceTimer.unref()
    }
    return
  }
  maintenanceScheduled = true
  setImmediate(() => {
    serial = serial
      .then(() => {
        maintenanceScheduled = false
        if (closing || !database) return
        database.maintainQueryState()
        scheduleMaintenance()
      })
      .catch((error) => {
        maintenanceScheduled = false
        if (error instanceof LibraryDatabaseDurabilityError) process.exit(1)
        // Keep the retiring slot reserved on failure; don't spin on a disk fault.
        console.error('[library-db] Background cleanup failed:', error)
      })
  })
}
function enqueue(work: Work): void {
  // Import, backup and writes share one owner. No async operation can interleave
  // another transaction while it is awaiting disk I/O. Cooperative preparation
  // returns with its transaction closed before rejoining this queue.
  serial = serial
    .then(() => dispatch(work))
    .then(scheduleMaintenance)
    .catch((error) => {
      console.error('[library-db] Request transport failed:', error)
      process.exitCode = 1
    })
}
servicePort.on('message', (request) => enqueue({ request }))
servicePort.postMessage({ kind: 'ready' })
