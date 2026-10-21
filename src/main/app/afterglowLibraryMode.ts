import type { PlayMode, AudioEngineQueueItem } from '../../shared/audioEngineTypes.ts'
import type { LibraryQueueSnapshot } from '../../shared/libraryDatabase.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import type { LibraryDatabaseWorkerApi } from '../library/libraryDatabaseProtocol.ts'
import type { AudioEngineManager } from '../audioEngineManager.ts'
import type { playbackSessionService } from './playbackSessionService.ts'

/** One in-memory outcome checkpoint, owned by the Afterglow control owner.
 * The native queue is known to contain only this occurrence, held at repeat.
 * If a SQL acknowledgement/read is lost, a later control or restore reads the
 * outcome instead of repeating the order edit or assuming its old position. */
export interface AfterglowLibraryModePending {
  reference: LibraryPlaybackQueueReference
  before: LibraryQueueSnapshot
  previousMode: PlayMode
  mode: Exclude<PlayMode, 'heart'>
  token: string
  item: AudioEngineQueueItem
}

export interface AfterglowLibraryModeOptions {
  engine: Pick<
    AudioEngineManager,
    'getPlaybackInfo' | 'getQueueToken' | 'getQueueSnapshot' | 'rebindQueue'
  >
  database: Pick<
    LibraryDatabaseWorkerApi,
    'getLibraryQueue' | 'readLibraryQueue' | 'editLibraryQueue'
  >
  session: Pick<typeof playbackSessionService, 'getCachedSession' | 'adoptLibraryQueueMode'>
  isCurrent: () => boolean
  setMapping: (mapping: number[]) => void
  setPending: (pending: AfterglowLibraryModePending | null) => void
  mutate: (operation: () => Promise<void>) => Promise<void>
}

export async function reconcileAfterglowLibraryMode(
  pending: AfterglowLibraryModePending,
  options: Pick<
    AfterglowLibraryModeOptions,
    'engine' | 'database' | 'session' | 'setMapping' | 'setPending'
  >
): Promise<boolean> {
  const { engine, database, session } = options
  const nativeMatches = () => {
    const items = engine.getQueueSnapshot()
    return (
      engine.getQueueToken() === pending.token &&
      items.length === 1 &&
      items[0].queueEntryId === pending.item.queueEntryId &&
      items[0].id === pending.item.id &&
      items[0].source === pending.item.source
    )
  }
  if (!nativeMatches()) throw new Error('afterglow_library_queue_changed')
  const actual = await database.getLibraryQueue(pending.reference.id)
  const order = pending.mode === 'shuffle' ? 'shuffle' : 'original'
  const changed = order !== pending.before.order || pending.before.playMode !== pending.mode
  const applied =
    actual.order === order &&
    actual.playMode === pending.mode &&
    actual.revision === pending.reference.revision + (changed ? 1 : 0)
  const unchanged =
    actual.order === pending.before.order &&
    actual.playMode === pending.before.playMode &&
    actual.revision === pending.reference.revision &&
    actual.index === pending.reference.index
  if (
    (!applied && !unchanged) ||
    actual.id !== pending.reference.id ||
    actual.selectedEntryId !== pending.reference.entryId ||
    actual.total !== pending.before.total ||
    !Number.isSafeInteger(actual.index) ||
    actual.index < 0 ||
    actual.index >= actual.total
  )
    throw new Error('afterglow_library_queue_changed')
  const page = await database.readLibraryQueue(actual.id, actual.index, 1, {
    expectedRevision: actual.revision
  })
  const row = page.items[0]
  if (
    page.revision !== actual.revision ||
    page.offset !== actual.index ||
    page.total !== actual.total ||
    row?.position !== actual.index ||
    row.queueEntryId !== pending.item.queueEntryId ||
    row.track?.id !== pending.item.id
  )
    throw new Error('afterglow_requires_mappable_current_track')
  const info = await engine.getPlaybackInfo()
  if (
    !nativeMatches() ||
    info.queueIndex !== 0 ||
    (info.state !== 'stopped' && info.source !== pending.item.source)
  )
    throw new Error('afterglow_library_queue_changed')
  const mode = applied ? pending.mode : pending.previousMode
  // No await separates session adoption, the logical map and clearing the
  // checkpoint. Readers see either the old held state or the confirmed state.
  session.adoptLibraryQueueMode(pending.reference, actual, mode)
  options.setMapping([actual.index])
  options.setPending(null)
  const nativeMode =
    mode === 'repeat' || ((mode === 'listLoop' || mode === 'shuffle') && actual.total === 1)
      ? 'repeat'
      : 'sequential'
  const logicalQueueEnd =
    mode !== 'repeat' && actual.index === (page.lastPlayablePosition ?? actual.total - 1)
  if (info.playMode !== nativeMode || pending.item.logicalQueueEnd !== logicalQueueEnd) {
    const result = await engine.rebindQueue({
      expected: {
        queueToken: pending.token,
        index: 0,
        id: pending.item.id,
        source: pending.item.source
      },
      items: [{ ...pending.item, logicalQueueEnd }],
      startIndex: 0,
      playMode: nativeMode
    })
    if (!result) throw new Error('afterglow_library_queue_changed')
  }
  return applied
}

/** Called on the existing transport lane with core/presentation suspended. */
export async function changeAfterglowLibraryMode(
  mode: PlayMode,
  options: AfterglowLibraryModeOptions
): Promise<void> {
  const { engine, database, session, isCurrent } = options
  if (mode === 'heart') throw new Error('afterglow_requires_renderer_play_mode')
  const saved = session.getCachedSession()
  if (!saved?.libraryQueue || !isCurrent()) return
  const reference = { ...saved.libraryQueue }
  const info = await engine.getPlaybackInfo()
  if (!isCurrent()) return
  const token = engine.getQueueToken()
  const item = engine.getQueueSnapshot()[info.queueIndex]
  if (
    !token ||
    item?.queueEntryId !== reference.entryId ||
    (info.state !== 'stopped' && info.source !== item.source)
  )
    throw new Error('afterglow_requires_mappable_current_track')
  const before = await database.getLibraryQueue(reference.id)
  if (!isCurrent()) return
  if (
    before.revision !== reference.revision ||
    before.index !== reference.index ||
    before.selectedEntryId !== reference.entryId ||
    (before.playMode !== undefined && before.playMode !== saved.playMode) ||
    engine.getQueueToken() !== token
  )
    throw new Error('afterglow_library_queue_changed')
  if (mode === before.playMode && before.order === (mode === 'shuffle' ? 'shuffle' : 'original'))
    return
  await options.mutate(async () => {
    const guard = await engine.rebindQueue({
      expected: { queueToken: token, index: info.queueIndex, id: item.id, source: item.source },
      items: [{ ...item, logicalQueueEnd: false }],
      startIndex: 0,
      playMode: 'repeat'
    })
    if (!guard) throw new Error('afterglow_library_queue_changed')
    const cached = session.getCachedSession()?.libraryQueue
    if (
      engine.getQueueToken() !== guard.queueToken ||
      cached?.id !== reference.id ||
      cached.revision !== reference.revision ||
      cached.entryId !== reference.entryId ||
      cached.index !== reference.index
    )
      throw new Error('afterglow_library_queue_changed')
    options.setMapping([reference.index])
    const pending: AfterglowLibraryModePending = {
      reference,
      before,
      previousMode: saved.playMode ?? 'sequential',
      mode,
      token: guard.queueToken,
      item: { ...item, logicalQueueEnd: false }
    }
    options.setPending(pending)
    const order = mode === 'shuffle' ? 'shuffle' : 'original'
    let failure: unknown
    if (before.order !== order || before.playMode !== mode) {
      try {
        await database.editLibraryQueue(reference.id, reference.revision, { kind: 'mode', mode })
      } catch (error) {
        failure = error
      }
    }
    // A lost reply can still mean SQLite committed. Read once; never replay.
    const applied = await reconcileAfterglowLibraryMode(pending, options)
    if (!applied) throw failure ?? new Error('afterglow_library_queue_changed')
  })
}
