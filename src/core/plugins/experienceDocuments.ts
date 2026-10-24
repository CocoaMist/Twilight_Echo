import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { TwilightPluginManager } from './manager.ts'
import { normalizeExperiences } from '../../shared/pluginExperience.ts'
import type { createLegacyMusicAuthority } from './legacyMusicAuthority.ts'
import { legacyMusicDocumentValue } from '../../shared/legacyMusicMetadata.ts'
import type { LegacyMusicProvenanceOptions, LegacyMusicProvenanceReview } from '../../shared/legacyMusicMetadata.ts'

export interface ExperienceDocument {
  revision: number
  value: Record<string, unknown>
}
export function createExperienceDocuments(
  plugins: Pick<TwilightPluginManager, 'list'>,
  authority?: ReturnType<typeof createLegacyMusicAuthority>
) {
  const writes = new Map<string, Promise<unknown>>()

  /** Large, versioned music metadata is deliberately separate from UI preferences. */
  async function experienceDocument(
    pluginId: string,
    update?: ExperienceDocument,
    restoreRevision?: number,
    automatic = false
  ): Promise<ExperienceDocument> {
    const plugin = (await plugins.list())?.find((p) => p.id === pluginId && p.enabled)
    if (
      !plugin ||
      !normalizeExperiences(plugin).length ||
      !plugin.permissions.includes('library:write')
    )
      throw new Error('Music metadata access denied')
    const file = join(plugin.paths.dataDir, 'music-metadata.json')
    const read = async (): Promise<ExperienceDocument> => {
      try {
        const document = JSON.parse(await readFile(file, 'utf8')) as ExperienceDocument
        legacyMusicDocumentValue(document)
        return document
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, value: {} }
        throw error
      }
    }
    const backup = async (document: ExperienceDocument, name: string) => {
      await mkdir(plugin.paths.dataDir, { recursive: true })
      await writeFile(join(plugin.paths.dataDir, name), JSON.stringify(document), { flag: 'wx' }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        }
      )
    }
    const open = async () => {
      if (!authority) return null
      try {
        return await authority.open(pluginId, read, async (document) => {
          if (!document.revision && !Object.keys(document.value).length) return
          await backup(document, `music-metadata.before-main-library-${document.revision}.json`)
        })
      } catch (error) {
        // A failed staging import has not published a new authority. Keep the
        // old document usable and expose the migration error to the status API.
        // After publication a database read failure must not re-enable JSON.
        authority.failed(pluginId, error)
        if ((await authority.status(pluginId)).migration?.state === 'published') throw error
        return null
      }
    }
    if (!update) {
      await writes.get(file)
      // Reads can publish the first migration too, so use the same write lane.
      const operation = (writes.get(file) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => (await open()) ?? read())
      writes.set(file, operation)
      try {
        return await operation
      } finally {
        if (writes.get(file) === operation) writes.delete(file)
      }
    }
    const input = legacyMusicDocumentValue(update)
    const operation = (writes.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = await open()
        if (current) {
          if (current.revision !== update.revision)
            throw Object.assign(new Error('资料或曲库已发生变化，请重新读取并预览后再保存'), {
              code: 'STALE_REVISION'
            })
          // Keep the established import result's backup filename truthful. It is
          // a read-only recovery snapshot; SQLite remains the sole writer.
          await backup(current, `music-metadata.backup-${current.revision}.json`)
          return restoreRevision === undefined
            ? authority!.edit(pluginId, { revision: update.revision, value: JSON.parse(input) }, automatic)
            : authority!.restore(pluginId, restoreRevision, update.revision)
        }
        if (restoreRevision !== undefined) throw new Error('主库资料尚未迁移完成')
        const previous = await read()
        if (previous.revision !== update.revision)
          throw new Error('资料已发生变化，请重新读取并预览后再保存')
        await mkdir(plugin.paths.dataDir, { recursive: true })
        await backup(previous, `music-metadata.backup-${previous.revision}.json`)
        const next = { revision: previous.revision + 1, value: JSON.parse(input) }
        await writeFile(`${file}.tmp`, JSON.stringify(next), 'utf8')
        await rename(`${file}.tmp`, file)
        return next
      })
    writes.set(file, operation)
    try {
      return await operation
    } finally {
      if (writes.get(file) === operation) writes.delete(file)
    }
  }

  async function published(pluginId: string) {
    await experienceDocument(pluginId) // Same package authorization and migration lane.
    if (!authority || (await authority.status(pluginId)).migration?.state !== 'published')
      throw new Error('主库资料尚未迁移完成')
    return authority
  }
  return Object.assign(experienceDocument, {
    automatic: (pluginId: string, update: ExperienceDocument) =>
      experienceDocument(pluginId, update, undefined, true),
    inventory: async (pluginId: string, offset?: number, limit?: number) =>
      (await published(pluginId)).inventory(pluginId, offset, limit),
    history: async (pluginId: string, offset?: number, limit?: number) =>
      (await published(pluginId)).history(pluginId, offset, limit),
    historyRead: async (pluginId: string, revision: number) =>
      (await published(pluginId)).historyRead(pluginId, revision),
    provenanceList: async (pluginId: string, options?: LegacyMusicProvenanceOptions) =>
      (await published(pluginId)).provenanceList(pluginId, options),
    provenanceRead: async (pluginId: string, albumId: string, snapshotRevision: number) =>
      (await published(pluginId)).provenanceRead(pluginId, albumId, snapshotRevision),
    provenanceReview: async (pluginId: string, request: LegacyMusicProvenanceReview) =>
      (await published(pluginId)).provenanceReview(pluginId, request),
    restore: (pluginId: string, revision: number, expectedRevision: number) => {
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid history revision')
      return experienceDocument(pluginId, { revision: expectedRevision, value: {} }, revision)
    },
    migrationStatus: (pluginId: string) =>
      authority?.status(pluginId) ?? Promise.resolve({ migration: null, error: null }),
    flush: async () => {
      await Promise.all([...writes.values()])
    }
  })
}
