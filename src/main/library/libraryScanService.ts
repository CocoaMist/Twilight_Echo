import { initializeUtilityDiagnostics } from '../diagnostics/utility.ts'
import { observeDiagnosticOperation } from '../diagnostics/observation.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'
import { createHash, randomUUID } from 'crypto'
import { type Dirent } from 'fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import { parseFromTokenizer, type IAudioMetadata } from 'music-metadata'
import { fromFile } from 'strtok3'
import {
  type LocalLibraryFileIdentity,
  type LocalLibraryReleaseDateUpdate,
  type LocalLibraryScanWorkerMessage,
  type LocalLibraryScanWorkerRequest,
  type LocalLibraryWorkerScanRequest,
  type LocalLibraryWorkerScanResult
} from '../../shared/localLibraryScan.ts'
import { SUPPORTED_EXTENSIONS } from './libraryFiles.ts'
import { CueDirectoryIndex } from './cueLibrary.ts'
import { readMp4AlacFormat } from './mp4AlacFormat.ts'
import { createLocalLibraryScanPlan } from './scanPlanner.ts'
import { chooseWaveText, readWaveMetadata, repairMojibakeText } from './wavMetadata.ts'
import { readLocalReleaseDate } from '../../shared/releaseDate.ts'
import { enumerateDatabaseDirectory, runDatabaseScan } from './libraryDatabaseScanner.ts'
import { createScanDatabaseProxy } from './libraryScanDatabaseProxy.ts'
import { runPlaylistRepairScan } from './playlistRepairScanner.ts'
import type { RepairScanCall } from '../../shared/localLibraryScan.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'

type ParentPort = {
  postMessage: (message: LocalLibraryScanWorkerMessage) => void
  on: (event: 'message', listener: (message: LocalLibraryScanWorkerRequest) => void) => void
}

type ElectronParentPort = {
  postMessage: ParentPort['postMessage']
  on: (event: 'message', listener: (event: { data: LocalLibraryScanWorkerRequest }) => void) => void
}

type NodeIpcProcess = {
  send?: ParentPort['postMessage']
  on?: (event: 'message', listener: (message: LocalLibraryScanWorkerRequest) => void) => void
}

type ScanControl = {
  paused: boolean
  cancelled: boolean
  resume: (() => void) | null
}

const workerParentPort = (process as unknown as { parentPort?: ElectronParentPort }).parentPort
const nodeIpc = process as unknown as NodeIpcProcess
const parentPort: ParentPort | null = workerParentPort
  ? {
      postMessage: (message) => workerParentPort.postMessage(message),
      on: (_event, listener) => workerParentPort.on('message', (event) => listener(event.data))
    }
  : typeof nodeIpc.send === 'function' && typeof nodeIpc.on === 'function'
    ? {
        postMessage: (message) => nodeIpc.send?.(message),
        on: (_event, listener) => nodeIpc.on?.('message', listener)
      }
    : null

if (!parentPort) {
  throw new Error('Twilight local library scan service requires an Electron or Node parent port')
}

const servicePort = parentPort
initializeUtilityDiagnostics('twilight-library-scan')
const activeScans = new Map<string, ScanControl>()
const databaseProxies = new Map<string, ReturnType<typeof createScanDatabaseProxy>>()
const repairReplies = new Map<
  string,
  { sequence: number; resolve(): void; reject(error: Error): void }
>()
const coverHandlesByDirectory = new Map<string, Promise<string | null>>()
const MAX_COVER_BYTES = 20 * 1024 * 1024
const SCAN_BATCH_SIZE = 256
const IDENTITY_BATCH_SIZE = 1_024
const PARSE_CONCURRENCY = 4
const PARSE_TIMEOUT_MS = 30_000
const COVER_LOOKUP_TIMEOUT_MS = 10_000
const PROGRESS_INTERVAL_MS = 250
const PROGRESS_FILE_INTERVAL = 256
const MAX_COVER_DIRECTORY_CACHE_ENTRIES = 2_048

servicePort.postMessage({ kind: 'ready' })
servicePort.on('message', (message) => {
  if (message.kind === 'repair-ack') {
    const reply = repairReplies.get(message.requestId)
    if (reply?.sequence === message.sequence) {
      repairReplies.delete(message.requestId)
      if (message.error) reply.reject(new Error(message.error))
      else reply.resolve()
    }
    return
  }
  if (message.kind === 'scan-repair') {
    void handleRepairScan(message.requestId, message.root, message.coverCacheDir)
    return
  }
  if (message.kind === 'database-response') {
    databaseProxies.get(message.requestId)?.handle(message)
    return
  }
  if (message.kind === 'scan-database') {
    void handleDatabaseScan(message.requestId, message.coverCacheDir, message.forceParse)
    return
  }
  if (message.kind === 'scan') {
    void observeDiagnosticOperation(
      'library.scan',
      'scan',
      () => handleScan(message.requestId, message.request),
      [message.request],
      { requestId: message.requestId, ...(message as any).diagnosticContext }
    )
    return
  }
  const control = activeScans.get(message.requestId)
  if (!control) return
  if (message.kind === 'pause') {
    control.paused = true
    return
  }
  if (message.kind === 'resume') {
    control.paused = false
    control.resume?.()
    control.resume = null
    return
  }
  control.cancelled = true
  control.paused = false
  control.resume?.()
  control.resume = null
})

async function handleRepairScan(
  requestId: string,
  root: string,
  coverCacheDir: string
): Promise<void> {
  if (activeScans.size) {
    servicePort.postMessage({
      kind: 'repair-result',
      requestId,
      error: 'Metadata process is already scanning'
    })
    return
  }
  activeScans.set(requestId, { paused: false, cancelled: false, resume: null })
  const cueIndex = new CueDirectoryIndex(SUPPORTED_EXTENSIONS)
  let sequence = 0
  try {
    await runPlaylistRepairScan({
      root,
      enumerate: (directory) =>
        enumerateDatabaseDirectory(directory, (path) => cueIndex.getSignatures(path)),
      parse: async (identity) =>
        (
          await withTimeout(
            parseTrack(identity, coverCacheDir, cueIndex),
            PARSE_TIMEOUT_MS + COVER_LOOKUP_TIMEOUT_MS,
            'repair file parsing'
          )
        ).tracks as LibraryTrackRecord[],
      call: (call: RepairScanCall) =>
        new Promise<void>((resolve, reject) => {
          repairReplies.set(requestId, { sequence: ++sequence, resolve, reject })
          servicePort.postMessage({ kind: 'repair-call', requestId, sequence, call })
        })
    })
    servicePort.postMessage({ kind: 'repair-result', requestId })
  } catch (error) {
    servicePort.postMessage({ kind: 'repair-result', requestId, error: String(error) })
  } finally {
    repairReplies.delete(requestId)
    activeScans.delete(requestId)
  }
}

async function handleDatabaseScan(
  requestId: string,
  coverCacheDir: string,
  forceParse: boolean
): Promise<void> {
  if (activeScans.size) {
    servicePort.postMessage({
      kind: 'database-result',
      requestId,
      ok: false,
      error: 'Metadata process is already scanning'
    })
    return
  }
  const control: ScanControl = { paused: false, cancelled: false, resume: null }
  const proxy = createScanDatabaseProxy(requestId, (message) => servicePort.postMessage(message))
  const cueIndex = new CueDirectoryIndex(SUPPORTED_EXTENSIONS, {
    get: (identity) => proxy.database.getScanCueDefinition(requestId, identity),
    put: (record) => proxy.database.putScanCueDefinition(requestId, record)
  })
  activeScans.set(requestId, control)
  databaseProxies.set(requestId, proxy)
  try {
    const value = await runDatabaseScan({
      jobId: requestId,
      database: proxy.database,
      enumerate: async function* (directory) {
        cueIndex.invalidateDirectory(directory)
        try {
          yield* enumerateDatabaseDirectory(directory, (directory) =>
            cueIndex.getSignatures(directory)
          )
        } finally {
          // runDatabaseScan drains each yielded page before requesting another.
          // Completed, failed or cancelled directories need no retained index.
          cueIndex.invalidateDirectory(directory)
        }
      },
      forceParse,
      parse: async (identity, audioMetadata) => {
        const parsed = await withTimeout(
          parseTrack(identity, coverCacheDir, cueIndex, audioMetadata),
          PARSE_TIMEOUT_MS + COVER_LOOKUP_TIMEOUT_MS,
          'file metadata parsing'
        )
        return {
          identity,
          ...parsed,
          tracks: parsed.tracks as LibraryTrackRecord[],
          dependencies: await cueIndex.getDependencies(identity.filePath)
        }
      },
      waitUntilRunnable: () => waitUntilRunnable(control),
      cancelled: () => control.cancelled,
      onActivity: (identities) =>
        servicePort.postMessage({
          kind: 'activity',
          requestId,
          activity: { filePaths: identities.map((file) => file.filePath) }
        }),
      onProgress: (progress, phase) =>
        servicePort.postMessage({ kind: 'database-progress', requestId, progress, phase })
    })
    servicePort.postMessage({ kind: 'database-result', requestId, ok: true, value })
  } catch (error) {
    writeDiagnostic('library.scan', 'database-scan.failed', { requestId, error }, 'error')
    servicePort.postMessage({ kind: 'database-result', requestId, ok: false, error: String(error) })
  } finally {
    proxy.close()
    databaseProxies.delete(requestId)
    activeScans.delete(requestId)
  }
}

async function handleScan(
  requestId: string,
  request: LocalLibraryWorkerScanRequest
): Promise<void> {
  const control: ScanControl = { paused: false, cancelled: false, resume: null }
  activeScans.set(requestId, control)
  try {
    const value = await runScan(requestId, request, control)
    servicePort.postMessage({ kind: 'response', requestId, ok: true, value })
  } catch (error) {
    writeDiagnostic('library.scan', 'scan.failed', { error }, 'error')
    servicePort.postMessage({
      kind: 'response',
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    activeScans.delete(requestId)
  }
}

async function runScan(
  requestId: string,
  request: LocalLibraryWorkerScanRequest,
  control: ScanControl
): Promise<LocalLibraryWorkerScanResult> {
  const checkpoint = request.resumeCheckpoint
  const cueIndex = new CueDirectoryIndex(SUPPORTED_EXTENSIONS)
  const collected = checkpoint
    ? {
        identities: checkpoint.identities,
        byPath: new Map(checkpoint.identities.map((file) => [normalizePath(file.filePath), file])),
        completeIdentitySnapshot: checkpoint.completeIdentitySnapshot,
        disappearedFilePaths: []
      }
    : await collectIdentities(requestId, request, control)
  if (control.cancelled) return cancelledResult(request.mode, collected.completeIdentitySnapshot)

  const plan = createLocalLibraryScanPlan({
    mode: request.mode,
    identities: collected.identities,
    knownIdentities: request.knownIdentities,
    knownTrackPaths: request.knownTrackPaths,
    excludedPaths: request.excludedPaths,
    forceParse: request.forceParse,
    changes: request.changes,
    completeIdentitySnapshot: collected.completeIdentitySnapshot
  })
  const streamResults = request.streamResults === true
  const parsedTracks: unknown[] = []
  const parsedFilePaths: string[] = []
  const metadataParsedFilePaths: string[] = []
  const releaseDateUpdates: LocalLibraryReleaseDateUpdate[] = []
  let pendingTracks: unknown[] = []
  let pendingFilePaths: string[] = []
  let pendingMetadataPaths: string[] = []
  let pendingDateUpdates: LocalLibraryReleaseDateUpdate[] = []
  const dateOnlyPaths = new Set(plan.releaseDateFilePaths.map(normalizePath))
  let parsedFileCount = checkpoint?.parsedFileCount ?? 0
  const completedPaths = new Set((checkpoint?.completedFilePaths ?? []).map(normalizePath))
  const skipParsePaths = new Set((request.skipParsePaths ?? []).map(normalizePath))
  const parseFilePaths = plan.parseFilePaths.filter(
    (filePath) =>
      !skipParsePaths.has(normalizePath(filePath)) && !completedPaths.has(normalizePath(filePath))
  )
  const skippedFilePaths = plan.parseFilePaths.filter((filePath) =>
    skipParsePaths.has(normalizePath(filePath))
  )
  const completedCount = completedPaths.size
  const total = parseFilePaths.length + completedCount
  const report = createProgressReporter(requestId)

  if (streamResults && !checkpoint) {
    for (let index = 0; index < collected.identities.length; index += IDENTITY_BATCH_SIZE) {
      await waitUntilRunnable(control)
      if (control.cancelled)
        return cancelledResult(request.mode, collected.completeIdentitySnapshot)
      servicePort.postMessage({
        kind: 'identity-batch',
        requestId,
        batch: { identities: collected.identities.slice(index, index + IDENTITY_BATCH_SIZE) }
      })
    }
  }

  for (let index = 0; index < parseFilePaths.length; index += PARSE_CONCURRENCY) {
    await waitUntilRunnable(control)
    if (control.cancelled) return cancelledResult(request.mode, collected.completeIdentitySnapshot)

    const paths = parseFilePaths.slice(index, index + PARSE_CONCURRENCY)
    servicePort.postMessage({ kind: 'activity', requestId, activity: { filePaths: paths } })
    report(
      {
        phase: 'parsing',
        current: index + completedCount,
        total,
        parsedFileCount,
        skippedUnchanged: plan.skippedUnchanged
      },
      index === 0
    )
    const results = await Promise.all(
      paths.map(async (filePath) => {
        const identity = collected.byPath.get(normalizePath(filePath))
        const dateOnly = dateOnlyPaths.has(normalizePath(filePath))
        if (dateOnly) {
          // ISO tags are read by the existing native reader in the coordinator.
          if (filePath.toLowerCase().endsWith('.iso')) {
            return {
              filePath,
              dateOnly,
              tracks: [],
              metadataRead: false,
              dateUpdate: { filePath, releaseDate: undefined }
            }
          }
          try {
            const metadata = await parseAudioMetadata(filePath, true)
            const waveMetadata = await readWaveMetadata(filePath).catch(() => null)
            return {
              filePath,
              dateOnly,
              tracks: [],
              metadataRead: true,
              dateUpdate: {
                filePath,
                releaseDate: readLocalReleaseDate({
                  ...metadata.common,
                  year: waveMetadata?.year ?? metadata.common.year
                })
              }
            }
          } catch {
            return { filePath, dateOnly, tracks: [], metadataRead: false, dateUpdate: undefined }
          }
        }
        const parsed = identity
          ? await parseTrack(identity, request.coverCacheDir, cueIndex)
          : { tracks: [], metadataRead: false }
        return {
          filePath,
          dateOnly,
          ...parsed,
          dateUpdate: undefined
        }
      })
    )
    if (control.cancelled) return cancelledResult(request.mode, collected.completeIdentitySnapshot)

    for (const result of results) {
      if (result.tracks.length > 0 || result.metadataRead) parsedFileCount += 1
      if (streamResults) {
        pendingTracks.push(...result.tracks)
        if (!result.dateOnly) pendingFilePaths.push(result.filePath)
        if (result.metadataRead) pendingMetadataPaths.push(result.filePath)
        if (result.dateUpdate) pendingDateUpdates.push(result.dateUpdate)
        if (pendingFilePaths.length + pendingDateUpdates.length >= SCAN_BATCH_SIZE) {
          servicePort.postMessage({
            kind: 'batch',
            requestId,
            batch: {
              parsedTracks: pendingTracks,
              parsedFilePaths: pendingFilePaths,
              metadataParsedFilePaths: pendingMetadataPaths,
              releaseDateUpdates: pendingDateUpdates
            }
          })
          pendingTracks = []
          pendingFilePaths = []
          pendingMetadataPaths = []
          pendingDateUpdates = []
        }
      } else {
        parsedTracks.push(...result.tracks)
        if (!result.dateOnly) parsedFilePaths.push(result.filePath)
        if (result.metadataRead) metadataParsedFilePaths.push(result.filePath)
        if (result.dateUpdate) releaseDateUpdates.push(result.dateUpdate)
      }
    }

    const current = Math.min(index + paths.length + completedCount, total)
    report(
      {
        phase: 'parsing',
        current,
        total,
        parsedFileCount,
        skippedUnchanged: plan.skippedUnchanged
      },
      index === 0 || current === total
    )
    await yieldToEventLoop()
  }

  if (streamResults && (pendingFilePaths.length > 0 || pendingDateUpdates.length > 0)) {
    servicePort.postMessage({
      kind: 'batch',
      requestId,
      batch: {
        parsedTracks: pendingTracks,
        parsedFilePaths: pendingFilePaths,
        metadataParsedFilePaths: pendingMetadataPaths,
        releaseDateUpdates: pendingDateUpdates
      }
    })
  }
  if (parseFilePaths.length === 0) {
    report(
      {
        phase: 'parsing',
        current: completedCount,
        total,
        parsedFileCount,
        skippedUnchanged: plan.skippedUnchanged
      },
      true
    )
  }

  return {
    mode: request.mode,
    completeIdentitySnapshot: collected.completeIdentitySnapshot,
    identities: streamResults ? [] : collected.identities,
    parsedTracks: streamResults ? [] : parsedTracks,
    parsedFilePaths: streamResults ? [] : parsedFilePaths,
    metadataParsedFilePaths: streamResults ? [] : metadataParsedFilePaths,
    releaseDateUpdates: streamResults ? [] : releaseDateUpdates,
    removedFilePaths: Array.from(
      new Set([...plan.removedFilePaths, ...collected.disappearedFilePaths])
    ),
    skippedUnchanged: plan.skippedUnchanged,
    parsedFileCount,
    cancelled: false,
    ...(skippedFilePaths.length > 0 ? { skippedFilePaths } : {})
  }
}

async function collectIdentities(
  requestId: string,
  request: LocalLibraryWorkerScanRequest,
  control: ScanControl
): Promise<{
  identities: LocalLibraryFileIdentity[]
  byPath: Map<string, LocalLibraryFileIdentity>
  completeIdentitySnapshot: boolean
  disappearedFilePaths: string[]
}> {
  const byPath = new Map<string, LocalLibraryFileIdentity>()
  const cueSignatureCache = new Map<string, Promise<string | undefined>>()
  const hasReconcileChange = (request.changes ?? []).some((change) => change.kind === 'reconcile')
  const completeIdentitySnapshot =
    request.mode !== 'watch' || !request.changes?.length || hasReconcileChange
  let unreadableCount = 0
  const report = createProgressReporter(requestId)
  const reportEnumeration = (current: number, force = false): void => {
    report(
      {
        phase: 'enumerating',
        current,
        total: 0,
        parsedFileCount: 0,
        skippedUnchanged: 0
      },
      force
    )
  }

  if (!completeIdentitySnapshot) {
    let current = 0
    const disappearedFilePaths: string[] = []
    for (const change of request.changes ?? []) {
      await waitUntilRunnable(control)
      if (control.cancelled) break
      if (change.kind === 'remove' && extname(change.path).toLowerCase() !== '.cue') {
        current += 1
        reportEnumeration(current)
        continue
      }
      try {
        if (extname(change.path).toLowerCase() === '.cue') {
          const directory = dirname(resolve(change.path))
          cueSignatureCache.delete(normalizePath(directory))
          const entries = await readdir(directory, { withFileTypes: true })
          for (const entry of entries) {
            if (
              !entry.isFile() ||
              !SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase())
            ) {
              continue
            }
            const identity = await readSupportedFileIdentity(
              join(directory, entry.name),
              cueSignatureCache
            )
            if (identity) byPath.set(normalizePath(identity.filePath), identity)
          }
        } else {
          const identity = await readSupportedFileIdentity(change.path, cueSignatureCache)
          if (identity) byPath.set(normalizePath(identity.filePath), identity)
        }
      } catch (error) {
        if (isMissingPathError(error)) disappearedFilePaths.push(change.path)
        else unreadableCount += 1
      }
      current += 1
      reportEnumeration(current)
    }
    if (unreadableCount > 0) {
      throw new Error(`Local library watcher could not inspect ${unreadableCount} changed path(s)`)
    }
    return {
      identities: Array.from(byPath.values()),
      byPath,
      completeIdentitySnapshot,
      disappearedFilePaths
    }
  }

  const queue = Array.from(new Set(request.roots.map((root) => resolve(root))))
  let queueIndex = 0
  let current = 0
  while (queueIndex < queue.length) {
    await waitUntilRunnable(control)
    if (control.cancelled) break
    const directory = queue[queueIndex++]!
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      unreadableCount += 1
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      await waitUntilRunnable(control)
      if (control.cancelled) break
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
      } else if (entry.isFile()) {
        try {
          const identity = await readSupportedFileIdentity(fullPath, cueSignatureCache)
          if (identity) byPath.set(normalizePath(identity.filePath), identity)
        } catch {
          unreadableCount += 1
        }
      }
      current += 1
      if (current % 32 === 0) reportEnumeration(current)
    }
  }
  reportEnumeration(current, true)
  if (unreadableCount > 0) {
    throw new Error(
      `Local library enumeration was incomplete (${unreadableCount} unreadable path(s))`
    )
  }
  return {
    identities: Array.from(byPath.values()),
    byPath,
    completeIdentitySnapshot,
    disappearedFilePaths: []
  }
}

async function readSupportedFileIdentity(
  filePath: string,
  cueSignatureCache: Map<string, Promise<string | undefined>>
): Promise<LocalLibraryFileIdentity | null> {
  if (!SUPPORTED_EXTENSIONS.includes(extname(filePath).toLowerCase())) return null
  const info = await stat(filePath)
  if (!info.isFile()) return null
  const resolvedPath = resolve(filePath)
  const identity: LocalLibraryFileIdentity = {
    filePath: resolvedPath,
    size: info.size,
    mtimeMs: info.mtimeMs
  }
  const directory = dirname(resolvedPath)
  const cacheKey = normalizePath(directory)
  let pendingSignature = cueSignatureCache.get(cacheKey)
  if (!pendingSignature) {
    pendingSignature = readCueDependencySignature(directory)
    cueSignatureCache.set(cacheKey, pendingSignature)
  }
  const cueSignature = await pendingSignature
  if (cueSignature) identity.cueSignature = cueSignature
  return identity
}

async function readCueDependencySignature(directory: string): Promise<string | undefined> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.cue')
    .sort((left, right) => left.name.localeCompare(right.name))
  if (entries.length === 0) return undefined

  const hash = createHash('sha256')
  let retained = 0
  for (const entry of entries) {
    try {
      const info = await stat(join(directory, entry.name))
      if (!info.isFile()) continue
      retained += 1
      hash.update(entry.name)
      hash.update('\0')
      hash.update(String(info.size))
      hash.update('\0')
      hash.update(String(info.mtimeMs))
      hash.update('\0')
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }
  }
  return retained > 0 ? hash.digest('hex') : undefined
}

function isMissingPathError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

type ScanProgressPayload = {
  phase: 'enumerating' | 'parsing'
  current: number
  total: number
  parsedFileCount: number
  skippedUnchanged: number
}

function createProgressReporter(
  requestId: string
): (progress: ScanProgressPayload, force?: boolean) => void {
  let lastPhase: ScanProgressPayload['phase'] | null = null
  let lastCurrent = -1
  let lastReportedAt = 0
  return (progress, force = false) => {
    const now = Date.now()
    const samePhase = lastPhase === progress.phase
    if (
      !force &&
      samePhase &&
      progress.current - lastCurrent < PROGRESS_FILE_INTERVAL &&
      now - lastReportedAt < PROGRESS_INTERVAL_MS
    ) {
      return
    }
    lastPhase = progress.phase
    lastCurrent = progress.current
    lastReportedAt = now
    servicePort.postMessage({ kind: 'progress', requestId, progress })
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function parseAudioMetadata(filePath: string, skipCovers = false): Promise<IAudioMetadata> {
  const tokenizer = await fromFile(filePath)
  try {
    const metadata = await withTimeout(
      parseFromTokenizer(tokenizer, { skipCovers }),
      PARSE_TIMEOUT_MS,
      'metadata parsing'
    )
    if (!metadata.format.container && metadata.format.tagTypes.length === 0) {
      throw new Error('No readable audio metadata')
    }
    return metadata
  } finally {
    await tokenizer.close()
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function parseTrack(
  file: LocalLibraryFileIdentity,
  coverCacheDir: string,
  cueIndex: CueDirectoryIndex,
  cachedAudio?: LibraryTrackRecord
): Promise<{
  tracks: Record<string, unknown>[]
  metadataRead: boolean
  error?: string
  audioMetadata?: LibraryTrackRecord
  metadataReused?: boolean
}> {
  const filePath = file.filePath
  if (cachedAudio) {
    const duration = Number(cachedAudio.duration ?? 0)
    const cueTracks = file.cueSignature
      ? await cueIndex.derive(filePath, duration, cachedAudio)
      : null
    return {
      tracks: cueTracks ?? [{ ...cachedAudio, duration: Math.round(duration) }],
      metadataRead: true,
      audioMetadata: cachedAudio,
      metadataReused: true
    }
  }
  const fileName = basename(filePath)
  const dir = dirname(filePath)
  const fallback = getNameFromFile(filePath)
  const folderCover = await findCoverInDir(dir, coverCacheDir)
  const baseTrack: LibraryTrackRecord = {
    id: randomUUID(),
    title: fallback.title,
    artist: fallback.artist,
    album: 'Unknown Album',
    filePath,
    fileName,
    dir,
    duration: 0,
    size: file.size,
    addedAt: Date.now(),
    cover: folderCover,
    lyrics: null
  }

  // RIFF INFO/BEXT text is frequently stored as legacy GBK/Shift-JIS or UTF-16 without
  // an encoding marker. Read it independently of music-metadata so a lossy parser result
  // cannot overwrite the original bytes' best decoding.
  const waveMetadata = await readWaveMetadata(filePath).catch(() => null)

  try {
    const metadata = await parseAudioMetadata(filePath)
    const picture = metadata.common.picture?.[0]
    const embeddedCover = picture
      ? await cacheCoverFromBuffer(Buffer.from(picture.data), coverCacheDir)
      : null
    const replayGainTags = extractReplayGainTags({
      common: {
        replaygain_track_gain: metadata.common.replaygain_track_gain,
        replaygain_album_gain: metadata.common.replaygain_album_gain,
        replaygain_track_peak: metadata.common.replaygain_track_peak,
        replaygain_album_peak: metadata.common.replaygain_album_peak
      },
      format: {
        trackGain: metadata.format.trackGain,
        albumGain: metadata.format.albumGain,
        trackPeakLevel: metadata.format.trackPeakLevel
      },
      native: metadata.native
    })
    const audioFingerprint = extractAcousticFingerprint(metadata.native)
    const alacFormat = metadata.format.codec === 'ALAC' ? await readMp4AlacFormat(filePath) : null
    const bpm = normalizeBpm(metadata.common.bpm)
    const discNumber = normalizeTrackIndex(metadata.common.disk)
    const title = chooseWaveText(metadata.common.title, waveMetadata?.title) ?? fallback.title
    const artist =
      chooseWaveText(metadata.common.artist, waveMetadata?.artist) ??
      (typeof metadata.common.albumartist === 'string'
        ? repairMojibakeText(metadata.common.albumartist)
        : undefined) ??
      fallback.artist
    const album = chooseWaveText(metadata.common.album, waveMetadata?.album) ?? 'Unknown Album'
    const genre = chooseWaveText(extractGenre(metadata.common.genre), waveMetadata?.genre)
    const trackNumber = waveMetadata?.trackNumber ?? normalizeTrackIndex(metadata.common.track)
    const releaseDate = readLocalReleaseDate({
      ...metadata.common,
      year: waveMetadata?.year ?? metadata.common.year
    })
    const track: LibraryTrackRecord = {
      ...baseTrack,
      title,
      artist,
      album,
      releaseDate,
      // Only persist a real ALBUMARTIST tag. Inventing it from track artist
      // fragmented multi-artist albums in the local library album grid.
      ...(typeof metadata.common.albumartist === 'string'
        ? { albumArtist: repairMojibakeText(metadata.common.albumartist) }
        : {}),
      genre,
      duration: Math.round(metadata.format.duration || waveMetadata?.duration || 0),
      cover: embeddedCover ?? baseTrack.cover,
      format: alacFormat ? 'ALAC' : (metadata.format.container ?? waveMetadata?.codec),
      sampleRate: alacFormat?.sampleRate ?? metadata.format.sampleRate ?? waveMetadata?.sampleRate,
      bitrate: metadata.format.bitrate ?? waveMetadata?.bitrate,
      bitDepth: alacFormat?.bitDepth ?? metadata.format.bitsPerSample ?? waveMetadata?.bitDepth,
      ...replayGainTags
    }
    if (bpm !== undefined) track.bpm = bpm
    if (trackNumber !== undefined) track.trackNumber = trackNumber
    if (discNumber !== undefined) track.discNumber = discNumber
    if (audioFingerprint) track.audioFingerprint = audioFingerprint
    const audioMetadata = {
      ...track,
      duration: Number(metadata.format.duration ?? waveMetadata?.duration ?? 0)
    }
    const cueTracks = file.cueSignature
      ? await cueIndex.derive(filePath, Number(audioMetadata.duration), track)
      : null
    if (cueTracks) return { tracks: cueTracks, metadataRead: true, audioMetadata }
    return { tracks: [track], metadataRead: true, audioMetadata }
  } catch (error) {
    if (waveMetadata) {
      const track: LibraryTrackRecord = {
        ...baseTrack,
        title: waveMetadata.title ?? fallback.title,
        artist: waveMetadata.artist ?? fallback.artist,
        album: waveMetadata.album ?? 'Unknown Album',
        genre: waveMetadata.genre,
        releaseDate: readLocalReleaseDate({ year: waveMetadata.year }),
        duration: Math.round(waveMetadata.duration ?? 0),
        format: waveMetadata.codec ?? 'WAV',
        sampleRate: waveMetadata.sampleRate,
        bitrate: waveMetadata.bitrate,
        bitDepth: waveMetadata.bitDepth,
        ...(waveMetadata.trackNumber !== undefined ? { trackNumber: waveMetadata.trackNumber } : {})
      }
      const audioMetadata = {
        ...track,
        duration: Number(waveMetadata.duration ?? 0)
      }
      const cueTracks = file.cueSignature
        ? await cueIndex.derive(filePath, Number(audioMetadata.duration), track)
        : null
      return { tracks: cueTracks ?? [track], metadataRead: true, audioMetadata }
    }
    return {
      tracks: [baseTrack],
      metadataRead: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function findCoverInDir(dir: string, coverCacheDir: string): Promise<string | null> {
  const cached = coverHandlesByDirectory.get(dir)
  if (cached) return await cached

  const lookup = (async () => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
    for (const name of COVER_NAMES) {
      if (!names.has(name)) continue
      try {
        const handle = await cacheCoverFromBuffer(await readFile(join(dir, name)), coverCacheDir)
        if (handle) return handle
      } catch {
        // Try the next conventional folder cover name.
      }
    }
    return null
  })()
  const pending = withTimeout(lookup, COVER_LOOKUP_TIMEOUT_MS, 'folder cover lookup').catch(
    () => null
  )
  const cachedPending = pending.then(
    (handle) => {
      rememberCoverHandle(dir, handle)
      return handle
    },
    () => {
      rememberCoverHandle(dir, null)
      return null
    }
  )
  coverHandlesByDirectory.set(dir, cachedPending)
  return await cachedPending
}

function rememberCoverHandle(dir: string, handle: string | null): void {
  coverHandlesByDirectory.delete(dir)
  coverHandlesByDirectory.set(dir, Promise.resolve(handle))
  while (coverHandlesByDirectory.size > MAX_COVER_DIRECTORY_CACHE_ENTRIES) {
    const oldest = coverHandlesByDirectory.keys().next().value
    if (oldest === undefined) break
    coverHandlesByDirectory.delete(oldest)
  }
}

async function cacheCoverFromBuffer(data: Buffer, coverCacheDir: string): Promise<string | null> {
  try {
    if (data.byteLength === 0 || data.byteLength > MAX_COVER_BYTES) return null
    const extension = detectCoverExtension(data)
    if (!extension) return null
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 24)
    const fileName = `${hash}.${extension}`
    await mkdir(coverCacheDir, { recursive: true })
    await writeIfMissing(join(coverCacheDir, fileName), data)
    return `cover://${fileName}`
  } catch {
    return null
  }
}

function detectCoverExtension(data: Buffer): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png'
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1'))) return 'gif'
  return null
}

async function writeIfMissing(filePath: string, data: Buffer): Promise<void> {
  try {
    await stat(filePath)
  } catch {
    await writeFile(filePath, data)
  }
}

async function waitUntilRunnable(control: ScanControl): Promise<void> {
  while (control.paused && !control.cancelled) {
    await new Promise<void>((resolve) => {
      control.resume = resolve
    })
  }
}

function cancelledResult(
  mode: LocalLibraryWorkerScanRequest['mode'],
  completeIdentitySnapshot: boolean
): LocalLibraryWorkerScanResult {
  return {
    mode,
    completeIdentitySnapshot,
    identities: [],
    parsedTracks: [],
    parsedFilePaths: [],
    removedFilePaths: [],
    skippedUnchanged: 0,
    parsedFileCount: 0,
    cancelled: true
  }
}

function normalizePath(filePath: string): string {
  const normalized = resolve(filePath)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function getNameFromFile(filePath: string): { artist: string; title: string } {
  const name = basename(filePath, extname(filePath))
  const divider = name.indexOf(' - ')
  if (divider > 0) {
    return {
      artist: name.slice(0, divider).trim(),
      title: name.slice(divider + 3).trim()
    }
  }
  return { artist: 'Unknown Artist', title: name }
}

function normalizeBpm(value: unknown): number | undefined {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(numeric) || numeric < 30 || numeric > 300) return undefined
  return Math.round(numeric * 10) / 10
}

/** music-metadata track/disk shape is `{ no, of }`; also accept bare numbers / "3/12". */
function normalizeTrackIndex(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'object' && !Array.isArray(value) && 'no' in value) {
    return normalizeTrackIndex((value as { no?: unknown }).no)
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)/)
    if (!match) return undefined
    value = Number(match[1])
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 9999) return undefined
  return Math.trunc(numeric)
}

/** music-metadata exposes genre as string | string[]; keep the first non-empty value. */
function extractGenre(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

function extractReplayGainTags(meta: {
  common?: Record<string, unknown>
  format?: Record<string, unknown>
  native?: Record<string, Array<{ id?: string; value?: unknown }> | undefined>
}): Record<string, number> {
  const common = meta.common ?? {}
  const format = meta.format ?? {}
  const result: Record<string, number> = {}
  const native = (ids: string[]): unknown => extractNativeTagValue(meta.native, ids)
  assign(
    result,
    'replayGainTrackGainDb',
    normalizeGainDb(common.replaygain_track_gain) ??
      normalizeGainDb(format.trackGain) ??
      normalizeGainDb(native(['REPLAYGAIN_TRACK_GAIN']))
  )
  assign(
    result,
    'replayGainAlbumGainDb',
    normalizeGainDb(common.replaygain_album_gain) ??
      normalizeGainDb(format.albumGain) ??
      normalizeGainDb(native(['REPLAYGAIN_ALBUM_GAIN']))
  )
  assign(
    result,
    'replayGainTrackPeak',
    normalizePeak(common.replaygain_track_peak) ??
      normalizePeak(format.trackPeakLevel) ??
      normalizePeak(native(['REPLAYGAIN_TRACK_PEAK']))
  )
  assign(
    result,
    'replayGainAlbumPeak',
    normalizePeak(common.replaygain_album_peak) ?? normalizePeak(native(['REPLAYGAIN_ALBUM_PEAK']))
  )
  assign(result, 'r128TrackGainDb', normalizeR128GainDb(native(['R128_TRACK_GAIN'])))
  assign(result, 'r128AlbumGainDb', normalizeR128GainDb(native(['R128_ALBUM_GAIN'])))
  return result
}

function assign(target: Record<string, number>, key: string, value: number | undefined): void {
  if (value !== undefined) target[key] = value
}

function extractNativeTagValue(
  native: Record<string, Array<{ id?: string; value?: unknown }> | undefined> | undefined,
  ids: string[]
): unknown {
  if (!native) return undefined
  const wanted = new Set(ids.map((id) => id.toUpperCase()))
  for (const tags of Object.values(native)) {
    if (!Array.isArray(tags)) continue
    for (const tag of tags) {
      if (typeof tag?.id === 'string' && wanted.has(tag.id.toUpperCase())) return tag.value
    }
  }
  return undefined
}

/**
 * Reads an existing Chromaprint/AcoustID tag. The scanner does not decode samples to validate the
 * tag, so persisted tag data remains a review-only candidate rather than trusted acoustic proof.
 */
function extractAcousticFingerprint(
  native: Record<string, Array<{ id?: string; value?: unknown }> | undefined> | undefined
): { algorithm: 'chromaprint-v1'; value: string; evidence: 'metadataCandidate' } | undefined {
  const value = extractNativeTagValue(native, ['ACOUSTID_FINGERPRINT', 'CHROMAPRINT_FINGERPRINT'])
  if (typeof value !== 'string') return undefined
  const fingerprint = value.trim()
  if (!fingerprint || fingerprint.length > 16_384) return undefined
  return { algorithm: 'chromaprint-v1', value: fingerprint, evidence: 'metadataCandidate' }
}

function normalizeGainDb(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100) / 100
  if (typeof value === 'object' && value !== null && 'dB' in value) {
    const db = Number((value as { dB?: unknown }).dB)
    return Number.isFinite(db) ? Math.round(db * 100) / 100 : undefined
  }
  return parseNumericValue(value, (numeric) => Math.round(numeric * 100) / 100)
}

function normalizePeak(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.round(value * 1_000_000) / 1_000_000
  if (typeof value === 'object' && value !== null && 'ratio' in value) {
    const ratio = Number((value as { ratio?: unknown }).ratio)
    return Number.isFinite(ratio) ? Math.round(ratio * 1_000_000) / 1_000_000 : undefined
  }
  return parseNumericValue(value, (numeric) => Math.round(numeric * 1_000_000) / 1_000_000)
}

function normalizeR128GainDb(value: unknown): number | undefined {
  return parseNumericValue(value, (numeric) => {
    const db = Math.abs(numeric) > 64 ? numeric / 256 : numeric
    return Math.round(db * 100) / 100
  })
}

function parseNumericValue(
  value: unknown,
  normalize: (value: number) => number
): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/(-?\d+(?:\.\d+)?)/)
  if (!match) return undefined
  const numeric = Number(match[1])
  return Number.isFinite(numeric) ? normalize(numeric) : undefined
}

const COVER_NAMES = [
  'cover.jpg',
  'cover.png',
  'cover.webp',
  'folder.jpg',
  'folder.png',
  'album.jpg',
  'album.png',
  'front.jpg',
  'front.png',
  'artwork.jpg',
  'artwork.png',
  'cover.gif',
  'folder.gif',
  'album.gif',
  'front.gif',
  'artwork.gif'
]
