import type { ListeningStats } from './useListeningStatsStore.ts'

/** Incremental, asynchronous storage. Normal playback writes only changed rows. */
export class ListeningStatsDatabase {
  private database: Promise<IDBDatabase>
  private changed = new Map<string, number>()
  private generation = 0
  private replace = true
  private replacementGeneration = 0
  private savedIds = new Set<string>()
  private loaded = false

  constructor(factory: IDBFactory, name = 'twilight-echo:listening-stats:v2') {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('tracks')
        request.result.createObjectStore('meta')
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Listening history database upgrade is blocked'))
    })
    // Initialization errors are reported by load/save, including when the
    // store has not yet recorded any listening events.
    void this.database.catch(() => {})
  }

  markTrack(id: string): void {
    this.changed.set(id, ++this.generation)
  }

  invalidate(): void {
    this.replace = true
    ++this.replacementGeneration
  }

  async load(): Promise<ListeningStats | null> {
    const database = await this.database
    const meta = database.transaction('meta').objectStore('meta')
    const days = await this.result(meta.get('days'))
    if (!days) return null
    const tracks: ListeningStats['tracks'] = {}
    // Page large histories so startup does not clone all rows in one task.
    let after: IDBValidKey | undefined
    for (;;) {
      const store = database.transaction('tracks').objectStore('tracks')
      const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
      const [keys, values] = await Promise.all([
        this.result(store.getAllKeys(range, 128)),
        this.result(store.getAll(range, 128))
      ])
      for (let i = 0; i < keys.length; ++i) tracks[String(keys[i])] = values[i]
      if (keys.length < 128) break
      after = keys.at(-1)
    }
    this.savedIds = new Set(Object.keys(tracks))
    if (!this.loaded && this.replacementGeneration === 0) this.replace = false
    this.loaded = true
    return { days, tracks }
  }

  async save(snapshot: ListeningStats): Promise<void> {
    const database = await this.database
    const replacementGeneration = this.replacementGeneration
    const changed = new Map(this.changed)
    const replace = this.replace
    const writtenIds = new Set<string>()
    const ids = replace ? Object.keys(snapshot.tracks) : [...changed.keys()]
    const deletions = replace
      ? [...this.savedIds].filter((id) => !Object.hasOwn(snapshot.tracks, id))
      : ids.filter((id) => !Object.hasOwn(snapshot.tracks, id))
    const transaction = database.transaction(['tracks', 'meta'], 'readwrite')
    const completion = this.completed(transaction)
    const tracks = transaction.objectStore('tracks')
    const meta = transaction.objectStore('meta')
    const days = { ...snapshot.days }
    const operations = [...deletions, ...ids]
    let offset = 0
    let writeError: unknown
    const writePage = (): void => {
      try {
        const end = Math.min(offset + 128, operations.length)
        for (; offset < end; ++offset) {
          const id = operations[offset]
          if (offset < deletions.length || !Object.hasOwn(snapshot.tracks, id)) tracks.delete(id)
          else {
            tracks.put(snapshot.tracks[id], id)
            writtenIds.add(id)
          }
        }
        if (offset < operations.length) {
          // The next request callback runs in an active transaction. Yield
          // between pages while retaining one atomic commit for rows + days.
          meta.get('days').onsuccess = writePage
        } else meta.put(days, 'days')
      } catch (error) {
        writeError = error
        transaction.abort()
      }
    }
    writePage()
    try {
      await completion
    } catch (error) {
      throw writeError ?? error
    }
    this.loaded = true
    for (const id of deletions) this.savedIds.delete(id)
    for (const id of writtenIds) this.savedIds.add(id)
    for (const [id, version] of changed)
      if (this.changed.get(id) === version) this.changed.delete(id)
    if (this.replacementGeneration === replacementGeneration) this.replace = false
  }

  async close(): Promise<void> {
    ;(await this.database).close()
  }

  private result<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  private completed(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Listening history transaction aborted'))
      transaction.onerror = () => {} // onabort reports the final transaction failure
    })
  }
}
