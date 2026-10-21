import type { AudioEngineManager } from '../audioEngineManager.ts'
import type { PlayMode, AudioEngineQueueItem } from '../../shared/audioEngineTypes.ts'
import type { LibraryQueuePlaybackWindow } from '../../shared/libraryDatabase.ts'
import type { AfterglowSourceResolver, ResolvedAfterglowSource } from './afterglowSourceResolver.ts'
import {
  authorizeAfterglowNativeSource,
  isAfterglowSourceCurrent
} from './afterglowSourceResolver.ts'
import { afterglowNativeQueueItem } from './afterglowQueueCore.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'

const END_RECOVERY_BUDGET_MS = 30_000

export interface AfterglowLibraryWindowPlan {
  window: LibraryQueuePlaybackWindow
  mode: PlayMode
}

export interface AfterglowLibraryQueueCoreOptions {
  engine: Pick<
    AudioEngineManager,
    | 'getPlaybackInfo'
    | 'getQueueSnapshot'
    | 'getQueueToken'
    | 'rebindQueue'
    | 'getPlaybackEnd'
    | 'continueAfterPlaybackEnd'
  >
  nativeQueueIndices: readonly number[]
  /** Synchronizes the actual occurrence before reading at most current + next. */
  readWindow: (
    index: number,
    entryId: string,
    isCurrent: () => boolean
  ) => Promise<AfterglowLibraryWindowPlan | null>
  validateWindow: (plan: AfterglowLibraryWindowPlan) => Promise<boolean>
  resolver: AfterglowSourceResolver
  authorize: (source: string) => Promise<string>
  /** Only the short commit stage enters the shared transport lane. */
  commit: (operation: () => Promise<void>, isCurrent: () => boolean) => Promise<void>
  onMappingChanged: (mapping: number[]) => void
  onPlaybackAdvanced: (info: PlaybackInfo, index: number, entryId: string) => Promise<void>
  mayContinueAfterEnd?: () => boolean
  onError: (message: string) => void
  onHealthy?: () => void
  now?: () => number
}

/** SQL owns order and EOF policy. Native owns only current + successor.
 * Rebind preserves the open decoder. Only a guarded natural-end continuation
 * may open the SQL successor after a slow source missed native EOF.
 * Provider reads stay outside the transport lane and are cancelled by epoch.
 */
export class AfterglowLibraryQueueCore {
  private readonly options: AfterglowLibraryQueueCoreOptions
  private mapping: number[]
  private active = false
  private generation = 0
  private pending: Promise<void> | null = null
  private requested = false
  private engineDrain: Promise<void> = Promise.resolve()
  // One successor cache and one retry slot, independent of traversal length.
  private source: { key: string; resolved: ResolvedAfterglowSource; refreshAfter: number } | null =
    null
  private retry: { key: string; after: number } | null = null
  private rejected: string | null = null
  private hasEndTarget = false
  private endRecovery: { key: string; deadline: number } | null = null
  private sourceReads = new AbortController()

  constructor(options: AfterglowLibraryQueueCoreOptions) {
    this.options = options
    this.mapping = [...options.nativeQueueIndices]
  }

  getMapping(): number[] {
    return [...this.mapping]
  }
  isActive(): boolean {
    return this.active
  }

  getPlaybackEndRecoveryDeadline(): number | null {
    const end = this.options.engine.getPlaybackEnd()
    if (
      !this.active ||
      !this.hasEndTarget ||
      !end ||
      this.options.mayContinueAfterEnd?.() === false
    )
      return null
    const key = `${end.intent}:${end.selection.queueToken}:${end.selection.index}`
    if (this.endRecovery?.key !== key)
      this.endRecovery = {
        key,
        deadline: (this.options.now ?? Date.now)() + END_RECOVERY_BUDGET_MS
      }
    return this.endRecovery.deadline
  }

  start(): Promise<void> {
    if (!this.active) {
      this.active = true
      this.generation++
      this.sourceReads = new AbortController()
    }
    return this.tick()
  }

  stop(): Promise<void> {
    this.active = false
    this.generation++
    this.sourceReads.abort()
    this.pending = null
    this.requested = false
    return this.engineDrain
  }

  tick(): Promise<void> {
    if (!this.active) return Promise.resolve()
    this.requested = true
    if (this.pending) return this.pending
    const generation = this.generation
    const current = () => this.active && generation === this.generation
    const run = Promise.resolve().then(async () => {
      try {
        while (current() && this.requested) {
          this.requested = false
          await this.maintain(current)
        }
      } catch (error) {
        if (current()) this.options.onError(error instanceof Error ? error.message : String(error))
      }
    })
    this.pending = run
    void run.finally(() => {
      if (this.pending === run) this.pending = null
    })
    return run
  }

  private async maintain(current: () => boolean): Promise<void> {
    const { engine } = this.options
    const info = await engine.getPlaybackInfo()
    if (!current()) return
    const token = engine.getQueueToken()
    const native = engine.getQueueSnapshot()
    const item = native[info.queueIndex]
    const index = this.mapping[info.queueIndex]
    if (
      !token ||
      !item?.queueEntryId ||
      native.length !== this.mapping.length ||
      !Number.isSafeInteger(index) ||
      index < 0
    )
      throw new Error('afterglow_requires_mappable_current_track')
    if (info.state !== 'stopped' && info.source !== item.source)
      throw new Error('afterglow_requires_mappable_current_track')
    const plan = await this.options.readWindow(index, item.queueEntryId, current)
    if (!current() || !plan) return
    const { window, mode } = plan
    const lastPlayablePosition = window.lastPlayablePosition ?? window.queue.total - 1
    const row = window.items[0]
    if (
      window.queue.index !== index ||
      window.queue.selectedEntryId !== item.queueEntryId ||
      row?.position !== index ||
      row.queueEntryId !== item.queueEntryId ||
      (row.track && row.track.id !== item.id)
    )
      throw new Error('afterglow_library_queue_changed')
    if (mode === 'heart') throw new Error('afterglow_requires_renderer_play_mode')
    const next = mode === 'repeat' ? undefined : window.items[1]
    const repeat =
      mode === 'repeat' || ((mode === 'shuffle' || mode === 'listLoop') && !next && !!row.track)
    const nativeMode = repeat ? 'repeat' : 'sequential'
    const endTarget = repeat ? row : next
    this.hasEndTarget = !!endTarget?.track
    // A refused lookahead handoff may still be recovered once the exact
    // occurrence naturally stops. Never use a reload fallback while playing.
    const end = engine.getPlaybackEnd()
    if (info.state === 'stopped' && end && !endTarget?.track) return
    if (info.state === 'stopped' && end && endTarget?.track) {
      const deadline = this.getPlaybackEndRecoveryDeadline()
      if (!deadline || (this.options.now ?? Date.now)() >= deadline) return
      const key = `${endTarget.queueEntryId}:${window.libraryRevision}`
      if (this.retry?.key === key && (this.options.now ?? Date.now)() < this.retry.after) return
      const cached = this.source?.key === key ? this.source.resolved : null
      let resolved: ResolvedAfterglowSource | null
      try {
        resolved =
          cached &&
          (cached.expiresAt === null || cached.expiresAt > (this.options.now ?? Date.now)())
            ? cached
            : await this.options.resolver.resolve(
                { ...endTarget.track, queueEntryId: endTarget.queueEntryId },
                this.sourceReads.signal
              )
        if (!current()) return
        if (!resolved) throw new Error(`afterglow_core_source_unavailable:${endTarget.position}`)
        resolved = {
          ...resolved,
          source: await authorizeAfterglowNativeSource(resolved.source, this.options.authorize)
        }
      } catch (error) {
        if (!current()) return
        this.retry = { key, after: (this.options.now ?? Date.now)() + 30_000 }
        throw error
      }
      if (!current()) return
      const target = afterglowNativeQueueItem(
        { ...endTarget.track, queueEntryId: endTarget.queueEntryId },
        resolved.source,
        endTarget.position,
        mode !== 'repeat' && endTarget.position === lastPlayablePosition
      )
      await this.options.commit(async () => {
        if (!current() || !(await this.options.validateWindow(plan)) || !current()) return
        if ((this.options.now ?? Date.now)() >= deadline) return
        this.requireFreshSource(key, resolved, endTarget.position)
        let selected = false
        const mutation = (async () => {
          try {
            const advanced = await engine.continueAfterPlaybackEnd({
              expected: end,
              item: target,
              playMode: nativeMode,
              isCurrent: () =>
                current() &&
                this.options.mayContinueAfterEnd?.() !== false &&
                (this.options.now ?? Date.now)() < deadline &&
                isAfterglowSourceCurrent(resolved, (this.options.now ?? Date.now)()),
              onSelected: () => {
                selected = true
                this.mapping = [endTarget.position]
                if (current()) this.options.onMappingChanged(this.getMapping())
              }
            })
            if (advanced && current()) {
              this.source = null
              this.retry = null
              this.rejected = null
              this.endRecovery = null
              this.requested = true
            } else if (
              current() &&
              !isAfterglowSourceCurrent(resolved, (this.options.now ?? Date.now)())
            ) {
              this.options.onError(this.expiredSourceError(key, endTarget.position).message)
            }
          } finally {
            if (selected && engine.getQueueToken()) {
              const actual = await engine.getPlaybackInfo()
              if (
                actual.queueIndex === 0 &&
                engine.getQueueSnapshot()[0]?.queueEntryId === endTarget.queueEntryId
              )
                await this.options.onPlaybackAdvanced(
                  actual,
                  endTarget.position,
                  endTarget.queueEntryId
                )
            }
          }
        })().catch((error) => {
          // Includes lost native/SQL replies. An explicit restore must reconcile
          // authority; a timer must not replay a possibly completed handoff.
          if (current()) {
            this.options.onError(error instanceof Error ? error.message : String(error))
            this.active = false
          }
          throw error
        })
        this.engineDrain = mutation.catch(() => {})
        await mutation
      }, current)
      return
    }
    const attemptKey = `${token}:${info.queueIndex}:${window.queue.revision}:${window.libraryRevision}:${nativeMode}`
    // A refused/unsupported conditional handoff is not a reason to replay the
    // same request every timer tick. A new cursor/revision can try again.
    if (this.rejected === attemptKey) return
    const nextKey = next ? `${next.queueEntryId}:${window.libraryRevision}` : ''
    if (this.source?.key !== nextKey) this.source = null
    if (this.retry?.key !== nextKey) this.retry = null

    const apply = async (
      items: AudioEngineQueueItem[],
      mapping: number[],
      resolved?: ResolvedAfterglowSource
    ): Promise<boolean> => {
      let changed = false
      await this.options.commit(async () => {
        if (!current()) return
        const valid = await this.options.validateWindow(plan)
        if (!current() || !valid || engine.getQueueToken() !== token) return
        const latest = await engine.getPlaybackInfo()
        if (
          !current() ||
          engine.getQueueToken() !== token ||
          latest.queueIndex !== info.queueIndex ||
          latest.source !== info.source
        )
          return
        // Source resolution can finish after EOF. Let the next pass use the
        // explicit end authority instead of rebinding an already stopped window.
        if (latest.state === 'stopped' && engine.getPlaybackEnd()) {
          this.requested = true
          return
        }
        if (resolved) this.requireFreshSource(nextKey, resolved, next!.position)
        // A dispatched rebind must be drained even if stop/restore arrives now.
        const mutation = engine
          .rebindQueue({
            expected: {
              queueToken: token,
              index: info.queueIndex,
              id: item.id,
              source: item.source
            },
            items,
            startIndex: 0,
            playMode: nativeMode
          })
          .then((result) => {
            if (!result) {
              if (current()) {
                this.rejected = attemptKey
                this.options.onError('afterglow_library_queue_changed')
              }
              return
            }
            this.rejected = null
            this.mapping = mapping
            changed = true
            if (current()) this.options.onMappingChanged(this.getMapping())
          })
          .catch((error) => {
            // Unknown native outcomes must not be replayed by a later tick.
            if (current()) {
              this.active = false
              this.options.onError(error instanceof Error ? error.message : String(error))
            }
            throw error
          })
        this.engineDrain = mutation.catch(() => {})
        await mutation
      }, current)
      return changed
    }

    // Prune consumed rows and revoke a wrong successor/mode before slow URL
    // resolution. A looping native sub-window must never stand in for SQL EOF.
    const residentNext = native[info.queueIndex + 1]
    const expectedNext =
      next?.track && residentNext
        ? afterglowNativeQueueItem(
            { ...next.track, queueEntryId: next.queueEntryId },
            residentNext.source,
            next.position,
            next.position === lastPlayablePosition
          )
        : null
    const reusable =
      !!expectedNext &&
      (!this.source ||
        isAfterglowSourceCurrent(this.source.resolved, (this.options.now ?? Date.now)())) &&
      residentNext.queueEntryId === next!.queueEntryId &&
      this.mapping[info.queueIndex + 1] === next!.position &&
      JSON.stringify(
        afterglowNativeQueueItem(
          residentNext,
          residentNext.source,
          next!.position,
          residentNext.logicalQueueEnd
        )
      ) === JSON.stringify(expectedNext)
    const base = [
      { ...item, logicalQueueEnd: mode !== 'repeat' && index === lastPlayablePosition },
      ...(reusable ? [residentNext] : [])
    ]
    const baseMap = [index, ...(reusable ? [next!.position] : [])]
    if (
      info.queueIndex !== 0 ||
      native.length !== base.length ||
      info.playMode !== nativeMode ||
      native.some(
        (entry, i) =>
          entry.queueEntryId !== base[i]?.queueEntryId ||
          entry.logicalQueueEnd !== base[i]?.logicalQueueEnd
      )
    ) {
      if (await apply(base, baseMap, reusable ? this.source?.resolved : undefined))
        this.requested = true
      return
    }
    if (!next?.track) {
      this.options.onHealthy?.()
      return
    }
    const now = (this.options.now ?? Date.now)()
    const cached = this.source
    if (
      cached &&
      isAfterglowSourceCurrent(cached.resolved, now) &&
      (cached.resolved.expiresAt === null ||
        cached.resolved.expiresAt - now > 120_000 ||
        now < cached.refreshAfter)
    ) {
      this.options.onHealthy?.()
      return
    }
    if (this.retry && now < this.retry.after) return
    const track = { ...next.track, queueEntryId: next.queueEntryId }
    let resolved: ResolvedAfterglowSource | null
    try {
      resolved = await this.options.resolver.resolve(track, this.sourceReads.signal)
      if (!current()) return
      if (resolved)
        resolved = {
          ...resolved,
          source: await authorizeAfterglowNativeSource(resolved.source, this.options.authorize)
        }
    } catch (error) {
      if (!current()) return
      this.retry = { key: nextKey, after: (this.options.now ?? Date.now)() + 30_000 }
      throw error
    }
    if (!current()) return
    if (!resolved) {
      this.retry = { key: nextKey, after: (this.options.now ?? Date.now)() + 30_000 }
      throw new Error(`afterglow_core_source_unavailable:${next.position}`)
    }
    this.requireFreshSource(nextKey, resolved, next.position)
    const target = afterglowNativeQueueItem(
      track,
      resolved.source,
      next.position,
      next.position === lastPlayablePosition
    )
    if (!reusable || JSON.stringify(expectedNext) !== JSON.stringify(target)) {
      if (!(await apply([base[0], target], [index, next.position], resolved)) || !current()) {
        if (current() && this.requested) this.rememberSource(nextKey, resolved)
        return
      }
    }
    this.retry = null
    this.rememberSource(nextKey, resolved)
    this.options.onHealthy?.()
  }

  private expiredSourceError(key: string, position: number): Error {
    this.retry = { key, after: (this.options.now ?? Date.now)() + 30_000 }
    return new Error(`afterglow_core_source_expired:${position}`)
  }

  private requireFreshSource(
    key: string,
    resolved: ResolvedAfterglowSource,
    position: number
  ): void {
    if (isAfterglowSourceCurrent(resolved, (this.options.now ?? Date.now)())) return
    throw this.expiredSourceError(key, position)
  }

  private rememberSource(key: string, resolved: ResolvedAfterglowSource): void {
    const resolvedAt = (this.options.now ?? Date.now)()
    this.source = {
      key,
      resolved,
      refreshAfter:
        resolvedAt +
        Math.min(30_000, Math.max(1_000, ((resolved.expiresAt ?? Infinity) - resolvedAt) / 2))
    }
  }
}
