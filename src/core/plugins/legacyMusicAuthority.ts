import { createHash } from 'node:crypto'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { CatalogDatabaseApi } from '../../shared/musicCatalog.ts'
import type {
  LegacyMusicMetadataDatabaseApi,
  LegacyMusicDocument,
  LegacyMusicProvenanceOptions,
  LegacyMusicProvenanceReview
} from '../../shared/legacyMusicMetadata.ts'
import { legacyMusicDocumentValue } from '../../shared/legacyMusicMetadata.ts'

export type LegacyMusicAuthorityDatabase = LegacyMusicMetadataDatabaseApi &
  Pick<LibraryDatabaseApi, 'queryCollections'> &
  Pick<CatalogDatabaseApi, 'catalogStatus'>

/** The SHA here is the established Rhine album identity, not a file integrity
 * check. Retaining it preserves exported tasks, proofs and existing navigation. */
export function legacyExperienceAlbumId(collectionId: string): string {
  return `album-${createHash('sha256').update(collectionId).digest('hex')}`
}

export function createLegacyMusicAuthority(
  database: LegacyMusicAuthorityDatabase,
  isScanning: () => boolean
) {
  const failures = new Map<string, string>()
  return {
    async open(
      pluginId: string,
      readLegacy: () => Promise<LegacyMusicDocument>,
      backup: (document: LegacyMusicDocument) => Promise<void>
    ) {
      const published = await database.legacyMusicRead(pluginId)
      if (published) {
        failures.delete(pluginId)
        return published
      }
      if (isScanning() || (await database.catalogStatus()).localPending) return null
      const document = await readLegacy()
      legacyMusicDocumentValue(document)
      const { albums, ...other } = document.value
      if (albums !== undefined && (!albums || typeof albums !== 'object' || Array.isArray(albums)))
        throw new Error('Invalid legacy albums document')
      const entries = Object.entries((albums ?? {}) as Record<string, unknown>)
      const collections = new Map<string, string>()
      let offset = 0,
        revision: number | undefined
      for (;;) {
        const page = await database.queryCollections('albums', {
          offset,
          limit: 200,
          contentRevision: revision
        })
        revision = page.revision
        for (const album of page.items) collections.set(legacyExperienceAlbumId(album.id), album.id)
        offset += page.items.length
        if (offset >= page.total) break
        if (!page.items.length) throw new Error('专辑迁移分页中断')
      }
      // Source is retained read-only. The backup remains usable by the old app;
      // committed post-migration edits live only in the library database.
      await backup(document)
      await database.legacyMusicBegin(
        pluginId,
        document.revision,
        albums === undefined ? other : { ...other, albums: {} },
        entries.length,
        revision!
      )
      for (let start = 0; start < entries.length; start += 100) {
        await database.legacyMusicStage({
          pluginId,
          sourceRevision: document.revision,
          contentRevision: revision!,
          entries: entries
            .slice(start, start + 100)
            .map(([id, value]) => ({ id, value, collectionId: collections.get(id) }))
        })
      }
      const current = await readLegacy()
      if (JSON.stringify(current) !== JSON.stringify(document))
        throw new Error('旧资料在迁移期间变化，请重新读取')
      await database.legacyMusicPublish(pluginId, document.revision, revision!)
      failures.delete(pluginId)
      return (await database.legacyMusicRead(pluginId))!
    },
    async edit(pluginId: string, document: LegacyMusicDocument, automatic = false) {
      const previous = await database.legacyMusicRead(pluginId)
      const original = previous?.value.albums ?? {}
      const newIds = new Set(
        Object.keys(document.value.albums ?? {}).filter(
          (id) => !Object.hasOwn(original as object, id)
        )
      )
      if (!newIds.size) {
        if (!automatic) return database.legacyMusicEdit(pluginId, document)
        const page = await database.queryCollections('albums', { limit: 1 })
        return database.legacyMusicEdit(pluginId, document, {
          contentRevision: page.revision, collections: [], descriptionOrigin: 'provider'
        })
      }
      const collections: Array<{ id: string; collectionId: string }> = []
      let offset = 0,
        revision: number | undefined
      for (;;) {
        const page = await database.queryCollections('albums', {
          offset,
          limit: 200,
          contentRevision: revision
        })
        revision = page.revision
        for (const album of page.items) {
          const id = legacyExperienceAlbumId(album.id)
          if (newIds.delete(id)) collections.push({ id, collectionId: album.id })
        }
        offset += page.items.length
        if (!newIds.size || offset >= page.total) break
        if (!page.items.length) throw new Error('专辑迁移分页中断')
      }
      return database.legacyMusicEdit(pluginId, document, {
        contentRevision: revision!,
        collections,
        ...(automatic ? { descriptionOrigin: 'provider' as const } : {})
      })
    },
    inventory: (pluginId: string, offset?: number, limit?: number) =>
      database.legacyMusicInventory(pluginId, offset, limit),
    history: (pluginId: string, offset?: number, limit?: number) =>
      database.legacyMusicHistory(pluginId, offset, limit),
    historyRead: (pluginId: string, revision: number) =>
      database.legacyMusicHistoryRead(pluginId, revision),
    restore: (pluginId: string, revision: number, expectedRevision: number) =>
      database.legacyMusicRestore(pluginId, revision, expectedRevision),
    provenanceList: (pluginId: string, options?: LegacyMusicProvenanceOptions) =>
      database.legacyMusicProvenanceList(pluginId, options),
    provenanceRead: (pluginId: string, albumId: string, snapshotRevision: number) =>
      database.legacyMusicProvenanceRead(pluginId, albumId, snapshotRevision),
    provenanceReview: (pluginId: string, request: LegacyMusicProvenanceReview) =>
      database.legacyMusicProvenanceReview(pluginId, request),
    async status(pluginId: string) {
      return {
        migration: await database.legacyMusicStatus(pluginId),
        error: failures.get(pluginId) ?? null
      }
    },
    failed(pluginId: string, error: unknown) {
      failures.set(pluginId, String(error))
    }
  }
}
