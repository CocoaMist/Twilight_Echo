import {
  createNetworkLibraryPersistence,
  type NetworkLibraryDocument,
  type NetworkLibraryPersistence
} from './networkLibraryPersistence.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'

export interface NetworkLibraryIndex {
  addEntries(
    profileId: string,
    root: string,
    entries: NetworkEntry[]
  ): Promise<{ added: number; total: number }>
  listEntries(profileId: string, query?: string): Promise<NetworkEntry[]>
  searchEntries(
    profileIds: readonly string[],
    query?: string
  ): Promise<Array<{ profileId: string; entry: NetworkEntry }>>
  updateEntries(profileId: string, entries: NetworkEntry[]): Promise<void>
  removeEntry(profileId: string, entryId: string): Promise<void>
  removeProfile(profileId: string): Promise<void>
}

/**
 * 网络源虚拟媒体库索引：只记录远程条目（不拷贝文件），支持根目录重扫替换。
 * 条目 id 为协议+profile+路径的稳定哈希，重扫不会产生重复。
 */
export function createNetworkLibrary(deps: {
  filePath: string
  persistence?: NetworkLibraryPersistence
}): NetworkLibraryIndex {
  const persistence = deps.persistence ?? createNetworkLibraryPersistence(deps.filePath)
  let writes: Promise<unknown> = Promise.resolve()

  function mutate<T>(apply: (document: NetworkLibraryDocument) => Promise<T>): Promise<T> {
    const operation = writes.then(async () => apply(await persistence.load()))
    // A failed write rejects its caller, but does not poison later transactions.
    writes = operation.catch(() => undefined)
    return operation
  }

  async function read(): Promise<NetworkLibraryDocument> {
    await writes
    return persistence.load()
  }

  const save = (document: NetworkLibraryDocument): Promise<void> => persistence.save(document)

  function matchingEntries(document: NetworkLibraryDocument, profileId: string, query: string) {
    const entries = document[profileId]?.entries ?? []
    return query ? entries.filter((entry) => entry.name.toLowerCase().includes(query)) : entries
  }

  function belongsToRoot(entry: NetworkEntry, root: string): boolean {
    if (root === '/') return true
    const prefix = root.endsWith('/') ? root : `${root}/`
    return entry.path.startsWith(prefix)
  }

  return {
    addEntries(profileId, root, entries) {
      const incoming = structuredClone(entries)
      return mutate(async (document) => {
        const profile = document[profileId] ?? { roots: [], entries: [] }
        const kept = profile.entries.filter((entry) => !belongsToRoot(entry, root))
        const seen = new Set(kept.map((entry) => entry.id))
        let added = 0
        for (const entry of incoming) {
          if (!seen.has(entry.id)) {
            kept.push(entry)
            seen.add(entry.id)
            added += 1
          }
        }
        const roots = [...new Set([...profile.roots, root])]
        document[profileId] = { roots, entries: kept }
        await save(document)
        return { added, total: kept.length }
      })
    },
    async listEntries(profileId, query) {
      const document = await read()
      const normalized = query?.trim().toLowerCase() ?? ''
      return structuredClone(matchingEntries(document, profileId, normalized))
    },
    async searchEntries(profileIds, query) {
      const document = await read()
      const normalized = query?.trim().toLowerCase() ?? ''
      const result: Array<{ profileId: string; entry: NetworkEntry }> = []
      for (const profileId of profileIds) {
        for (const entry of matchingEntries(document, profileId, normalized)) {
          result.push({ profileId, entry })
        }
      }
      return structuredClone(result)
    },
    updateEntries(profileId, entries) {
      const incoming = structuredClone(entries)
      return mutate(async (document) => {
        const profile = document[profileId]
        if (!profile || incoming.length === 0) return
        const byId = new Map(profile.entries.map((entry) => [entry.id, entry]))
        let changed = false
        for (const entry of incoming) {
          const existing = byId.get(entry.id)
          // Late metadata must not re-add music removed during enrichment.
          if (!existing) continue
          byId.set(entry.id, { ...existing, ...entry })
          changed = true
        }
        if (!changed) return
        document[profileId] = { ...profile, entries: [...byId.values()] }
        await save(document)
      })
    },
    removeEntry(profileId, entryId) {
      return mutate(async (document) => {
        const profile = document[profileId]
        if (!profile) return
        const next = profile.entries.filter((entry) => entry.id !== entryId)
        if (next.length === profile.entries.length) return
        document[profileId] = { ...profile, entries: next }
        await save(document)
      })
    },
    removeProfile(profileId) {
      return mutate(async (document) => {
        if (!document[profileId]) return
        delete document[profileId]
        await save(document)
      })
    }
  }
}
