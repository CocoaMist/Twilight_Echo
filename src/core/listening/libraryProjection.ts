import {
  LIBRARY_MAX_PAGE_SIZE,
  type LibraryDatabaseApi,
  type LibraryHistorySyncResult
} from '../../shared/libraryDatabase.ts'

export interface LibraryListeningProjectionState {
  mode: 'json' | 'sqlite' | null
  ready: boolean
  pending: boolean
  revision: number | null
  error: string
}

/** Upload only lightweight identities/timestamps. One RPC at a time and one
 * newest demand; never replay a commit whose reply was lost. A new replacement
 * reconciles the derived index with the authoritative, hydrated history. */
export interface LibraryListeningProjectionOptions {
  getStorageMode(): Promise<'json' | 'sqlite'>
  ready(): Promise<void>
  snapshot(): ReadonlyMap<string, number>
  sync: LibraryDatabaseApi['syncListeningHistory']
  identity?(): string
  state?: { value: LibraryListeningProjectionState }
}
export function createLibraryListeningProjection(options: LibraryListeningProjectionOptions) {
  const state = options.state ?? {
    value: {
      mode: null,
      ready: false,
      pending: false,
      revision: null,
      error: ''
    } as LibraryListeningProjectionState
  }
  let task: Promise<void> | null = null
  let started = false,
    dirty = true,
    disposed = false,
    generation = 0
  let confirmed: Map<string, number> | null = null

  function check(
    result: LibraryHistorySyncResult,
    id: string,
    sequence: number,
    committed: boolean
  ): void {
    if (
      result.id !== id ||
      result.sequence !== sequence ||
      result.committed !== committed ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 0
    )
      throw new Error('曲库返回了无效的历史索引确认')
  }
  function run(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (task) return task
    if (!dirty && state.value.ready) return Promise.resolve()
    state.value = { ...state.value, pending: true, error: '' }
    task = (async () => {
      try {
        if (state.value.mode === null) {
          const mode = await options.getStorageMode()
          if (mode !== 'json' && mode !== 'sqlite') throw new Error('曲库存储模式无效')
          if (disposed) return
          state.value = { ...state.value, mode }
        }
        if (state.value.mode === 'json') {
          dirty = false
          state.value = { ...state.value, ready: true }
          return
        }
        await options.ready()
        while (!disposed && dirty) {
          dirty = false
          const version = generation
          const snapshot = new Map(
            [...options.snapshot()].filter(([, value]) => Number.isFinite(value) && value > 0)
          )
          const entries = [...snapshot]
            .filter(([id, value]) => !confirmed || confirmed.get(id) !== value)
            .map(([id, lastPlayed]) => ({ id, lastPlayed }))
          if (confirmed)
            for (const id of confirmed.keys())
              if (!snapshot.has(id)) entries.push({ id, lastPlayed: 0 })
          if (confirmed && entries.length === 0) {
            state.value = { ...state.value, ready: true }
            continue
          }
          const id = options.identity?.() ?? crypto.randomUUID()
          const begin = await options.sync({
            kind: 'begin',
            id,
            mode: confirmed ? 'patch' : 'replace',
            ...(confirmed ? { expectedRevision: state.value.revision! } : {})
          })
          check(begin, id, 0, false)
          let sequence = 0
          for (
            let offset = 0;
            offset < entries.length && !disposed && version === generation;
            offset += LIBRARY_MAX_PAGE_SIZE
          ) {
            const result = await options.sync({
              kind: 'append',
              id,
              sequence: ++sequence,
              entries: entries.slice(offset, offset + LIBRARY_MAX_PAGE_SIZE)
            })
            check(result, id, sequence, false)
          }
          if (disposed) return
          if (version !== generation) continue
          const committed = await options.sync({ kind: 'commit', id, sequence: ++sequence })
          check(committed, id, sequence, true)
          if (disposed) return
          confirmed = snapshot
          state.value = {
            ...state.value,
            revision: committed.revision,
            ready: !dirty || state.value.ready
          }
        }
      } catch (error) {
        if (!disposed) {
          confirmed = null
          dirty = true
          state.value = {
            ...state.value,
            ready: false,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      } finally {
        if (!disposed) state.value = { ...state.value, pending: false }
      }
    })().finally(() => {
      task = null
      if (dirty && started && !disposed && !state.value.error) void run()
    })
    return task
  }
  return {
    state,
    ensure() {
      started = true
      return run()
    },
    refresh() {
      generation++
      dirty = true
      if (started && !disposed) void run()
    },
    retry() {
      confirmed = null
      dirty = true
      started = true
      return run()
    },
    drain() {
      return task ?? Promise.resolve()
    },
    dispose() {
      disposed = true
      generation++
    }
  }
}
