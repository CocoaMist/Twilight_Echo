import type { AudioEngineManager } from '../audioEngineManager.ts'
import type { LibraryDatabaseWorkerApi } from '../library/libraryDatabaseProtocol.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import {
  authorizeAfterglowNativeSource,
  isAfterglowSourceCurrent,
  type AfterglowSourceResolver
} from './afterglowSourceResolver.ts'
import type { playbackSessionService } from './playbackSessionService.ts'
import { afterglowNativeQueueItem } from './afterglowQueueCore.ts'

export interface AfterglowLibraryNavigation {
  engine: Pick<
    AudioEngineManager,
    | 'getPlaybackInfo'
    | 'getQueueToken'
    | 'getQueueSnapshot'
    | 'loadQueue'
    | 'setPlayMode'
    | 'play'
    | 'stop'
    | 'rebindQueue'
  >
  database: Pick<LibraryDatabaseWorkerApi, 'getLibraryQueue' | 'readLibraryQueueNeighbor'>
  session: Pick<typeof playbackSessionService, 'getCachedSession' | 'applyEngineState'>
  resolver: AfterglowSourceResolver
  authorize: (source: string) => Promise<string>
  isCurrent: () => boolean
  /** Releases the command lane on cancellation; no dispatched mutation is raced. */
  previewSignal?: AbortSignal
  setMapping: (mapping: number[]) => void
  /** Once a native mutation is dispatched, drain the complete guard/load/play/cursor handoff.
   * Slow preview/provider/authorization reads remain cancellable. */
  mutate: (operation: () => Promise<void>) => Promise<void>
}

/** Called inside the existing transport lane with presentation/core suspended.
 * Looks up one target occurrence without hydrating the intervening holes. */
export async function navigateAfterglowLibraryQueue(
  direction: 1 | -1,
  options: AfterglowLibraryNavigation
): Promise<void> {
  const { engine, database, session, isCurrent } = options
  const preview = <T>(read: () => Promise<T>) => readNavigationPreview(read, options.previewSignal)
  const reference = session.getCachedSession()?.libraryQueue
  if (!reference || !isCurrent()) return
  const expected: LibraryPlaybackQueueReference = { ...reference }
  const before = await preview(() => engine.getPlaybackInfo())
  if (!isCurrent()) return
  const token = engine.getQueueToken()
  const native = engine.getQueueSnapshot()[before.queueIndex]
  if (!token || native?.queueEntryId !== expected.entryId)
    throw new Error('afterglow_requires_mappable_current_track')
  // Manual previous/next wraps, including in sequential/repeat mode, just like
  // the renderer's SQL navigation. EOF policy is a separate queue operation.
  const target = await preview(() =>
    database.readLibraryQueueNeighbor(
      expected.id,
      expected.revision,
      expected.index,
      direction,
      true
    )
  )
  if (!isCurrent()) return
  if (!target?.track) throw new Error('afterglow_no_resumable_track')
  const track = { ...target.track, queueEntryId: target.queueEntryId }
  const resolved = await preview(() => options.resolver.resolve(track, options.previewSignal))
  if (!isCurrent()) return
  if (!resolved) throw new Error('afterglow_no_resumable_track')
  const requireFreshSource = () => {
    if (!isAfterglowSourceCurrent(resolved)) throw new Error('afterglow_no_resumable_track')
  }
  // SACD's native target appends a program/track selector to the physical ISO.
  // Authorize that exact container, then retain only the validated selector;
  // neither feed a virtual filename to realpath nor silently play the ISO's
  // default track. Other schemes still use the established source authorizer.
  const source = await preview(() =>
    authorizeAfterglowNativeSource(resolved.source, options.authorize)
  )
  if (!isCurrent()) return
  // A provider read can span an automatic EOF or an external SQL edit. Never
  // navigate from a cursor that stopped being current while it was resolving.
  const actual = await preview(() => database.getLibraryQueue(expected.id))
  if (!isCurrent()) return
  const latest = await preview(() => engine.getPlaybackInfo())
  if (!isCurrent()) return
  if (
    actual.revision !== expected.revision ||
    actual.index !== expected.index ||
    actual.selectedEntryId !== expected.entryId ||
    engine.getQueueToken() !== token ||
    latest.queueIndex !== before.queueIndex ||
    latest.source !== before.source
  )
    throw new Error('afterglow_library_queue_changed')
  const item = afterglowNativeQueueItem(
    track,
    source,
    target.position,
    session.getCachedSession()?.playMode !== 'repeat' &&
      (target.logicalQueueEnd ?? target.position === actual.total - 1)
  )
  await options.mutate(async () => {
    requireFreshSource()
    // Atomically check the actual native cursor and remove its old successor.
    // Repeat holds this same occurrence at EOF until the manual load below;
    // a boundary crossing between the preview and this guard rejects instead
    // of resetting a successor that already started. No reload fallback.
    const guard = await engine.rebindQueue({
      expected: {
        queueToken: token,
        index: before.queueIndex,
        id: native.id,
        source: native.source
      },
      items: [{ ...native, logicalQueueEnd: false }],
      startIndex: 0,
      playMode: 'repeat'
    })
    if (!guard) throw new Error('afterglow_library_queue_changed')
    options.setMapping([expected.index])
    requireFreshSource()
    await engine.loadQueue([item], 0)
    // A confirmed load changes native authority even if restore was requested
    // while its reply was in flight. Keep the final map before draining play.
    options.setMapping([target.position])
    const loadedToken = engine.getQueueToken()
    if (!loadedToken) throw new Error('afterglow_library_queue_changed')
    let failure: unknown
    let superseded = false
    try {
      const mode = session.getCachedSession()?.playMode
      await engine.setPlayMode(mode === 'repeat' ? 'repeat' : 'sequential')
      requireFreshSource()
      const result = await engine.play(source, 0, () => {
        // Recheck after async loudnorm/output fallback, before each native Play.
        // Expiry is a failed selected target, not a newer transport action;
        // let the existing stopped-selection recovery handle it. Once Play is
        // dispatched, its ACK must drain even if the URL expires meanwhile.
        requireFreshSource()
        return true
      })
      superseded = result.superseded === true
      if (!result.nativeStarted || result.superseded)
        throw new Error('afterglow_requires_native_playback')
    } catch (error) {
      // A newer native action owns its transport. Never stop it as recovery
      // for the command it deliberately superseded.
      if (superseded || engine.getQueueToken() !== loadedToken) throw error
      // A confirmed load selected the target, but its decoder could not start.
      // Leave a stopped, resumable selection rather than reporting old media
      // under the new occurrence. Stop failures remain explicit/uncertain.
      await engine.stop()
      failure = error
    }
    const live = await engine.getPlaybackInfo()
    if (engine.getQueueToken() !== loadedToken) throw new Error('afterglow_library_queue_changed')
    const info = failure ? { ...live, state: 'stopped' as const, position: 0, source } : live
    if (info.queueIndex !== 0 || engine.getQueueSnapshot()[0]?.queueEntryId !== target.queueEntryId)
      throw new Error('afterglow_requires_mappable_current_track')
    // Commit only after native selected this occurrence. An unknown SQL reply
    // is not replayed; the explicit restore reconciliation reads its outcome.
    await session.applyEngineState(info, {
      force: true,
      logicalIndex: target.position,
      entryId: target.queueEntryId,
      nativeEntries: [{ id: item.id, queueEntryId: target.queueEntryId, index: target.position }]
    })
    if (failure) throw failure
  })
}

/** The provider/authorization operation may not support abort. Consume its late
 * reply, but remove our listener and release the lane as soon as the user cancels.
 * Only the read-only preview uses this helper; guard/load/play/cursor must drain. */
function readNavigationPreview<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read()
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(signal.reason))
    const finish = (settle: () => void) => {
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return read()
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )
  })
}
