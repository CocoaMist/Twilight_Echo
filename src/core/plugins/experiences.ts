import { realpathSync } from 'node:fs'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { MusicAlbum } from '../../shared/rhineMusic.ts'
import { normalizeExperiences, type InstalledExperience } from '../../shared/pluginExperience.ts'
import { resolvePluginFile } from './packageSecurity.ts'
import type { TwilightPluginManager } from './manager.ts'
import { createExperienceDocuments } from './experienceDocuments.ts'
import { createExperienceMusic, type ExperienceMusicAlbum } from './experienceMusic.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import {
  createLegacyMusicAuthority,
  legacyExperienceAlbumId,
  type LegacyMusicAuthorityDatabase
} from './legacyMusicAuthority.ts'
import type { LegacyMusicTaskClient } from '../../shared/legacyMusicTasks.ts'

/** Package authorization and long-running metadata jobs survive every UI window. */
export class CorePluginExperiences {
  readonly document: ReturnType<typeof createExperienceDocuments>
  private readonly operate: ReturnType<typeof createExperienceMusic>
  private readonly writes = new Map<string, Promise<void>>()
  private readonly plugins: Pick<TwilightPluginManager, 'list' | 'listExtensions'>
  private readonly database: Pick<LibraryDatabaseApi, 'queryCollections' | 'queryTracks'>
  private readonly isScanning: () => boolean
  private readonly exportFile: (name: string, content: string) => Promise<{ saved: boolean }>
  constructor(
    plugins: Pick<TwilightPluginManager, 'list' | 'listExtensions'>,
    database: Pick<LibraryDatabaseApi, 'queryCollections' | 'queryTracks'>,
    isScanning: () => boolean,
    exportFile: (name: string, content: string) => Promise<{ saved: boolean }>,
    metadataDatabase?: LegacyMusicAuthorityDatabase,
    tasks?: LegacyMusicTaskClient
  ) {
    this.plugins = plugins
    this.database = database
    this.isScanning = isScanning
    this.exportFile = exportFile
    this.document = createExperienceDocuments(
      plugins,
      metadataDatabase
        ? createLegacyMusicAuthority(metadataDatabase, () => isScanning() || this.operate?.running())
        : undefined
    )
    this.operate = createExperienceMusic(plugins, this.document, tasks)
  }
  async list(): Promise<InstalledExperience[]> {
    return (await this.plugins.list())
      .filter((plugin) => plugin.enabled && plugin.status !== 'invalid')
      .flatMap((plugin) =>
        normalizeExperiences(plugin).map((item) => ({
          ...item,
          pluginId: plugin.id,
          version: plugin.version,
          url: `plugin-ui://${plugin.id}/${plugin.version}/${item.entry}`,
          permissions: [...plugin.permissions]
        }))
      )
  }
  async resource(rawUrl: string): Promise<{ path: string } | null> {
    const url = new URL(rawUrl)
    if (url.protocol !== 'plugin-ui:') return null
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    const version = parts.shift()
    if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)))
      return null
    const plugin = (await this.plugins.list()).find(
      (item) => item.id === url.hostname && item.version === version && item.enabled
    )
    if (!plugin) return null
    const file = resolvePluginFile(
      resolve(plugin.paths.versionRoot, ...parts),
      plugin.paths.versionRoot
    )
    if (
      !file ||
      !normalizeExperiences(plugin).some((entry) => {
        const child = relative(resolve(plugin.paths.versionRoot, dirname(entry.entry)), file)
        return child && !child.startsWith('..') && !child.includes(':')
      })
    )
      return null
    return { path: file }
  }
  async stylesheet(pluginId: string, themeId: string): Promise<string> {
    const theme = (await this.plugins.listExtensions())
      .find((entry) => entry.pluginId === pluginId)
      ?.themes.find((entry) => entry.id === themeId)
    if (!theme?.stylesheet) return ''
    const plugin = (await this.plugins.list()).find(
      (entry) => entry.id === pluginId && entry.enabled
    )
    if (!plugin) throw new Error('主题插件尚未启用')
    const file = resolvePluginFile(realpathSync(theme.stylesheet), plugin.paths.versionRoot)
    if (!file) throw new Error('主题 stylesheet 超出插件目录')
    return readFile(file, 'utf8')
  }
  async preferences(pluginId: string, value?: Record<string, unknown>): Promise<unknown> {
    const plugin = (await this.plugins.list()).find((item) => item.id === pluginId && item.enabled)
    if (!plugin || !normalizeExperiences(plugin).length || !plugin.permissions.includes('settings'))
      throw new Error('Experience unavailable')
    const file = resolve(plugin.paths.dataDir, 'experience-preferences.json')
    if (value === undefined) {
      await this.writes.get(pluginId)
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return {}
      }
    }
    const text = JSON.stringify(value)
    if (text.length > 64 * 1024) throw new Error('Invalid preferences')
    const work = (this.writes.get(pluginId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(plugin.paths.dataDir, { recursive: true })
        await writeFile(`${file}.tmp`, text, 'utf8')
        await rename(`${file}.tmp`, file)
      })
    this.writes.set(pluginId, work)
    try {
      await work
    } finally {
      if (this.writes.get(pluginId) === work) this.writes.delete(pluginId)
    }
    return value
  }
  async export(pluginId: string, name: string, content: string) {
    await this.document(pluginId)
    return this.exportFile(name, content)
  }
  async flush() {
    await Promise.all([...this.writes.values()])
    await this.document.flush()
  }
  async shutdown() {
    await this.operate.shutdown()
    await this.flush()
  }
  async music(pluginId: string, operation: string, args: Record<string, unknown>) {
    if (operation !== 'status' && operation !== 'cancel' && this.isScanning())
      throw new Error('曲库正在扫描，请完成后重试资料操作')
    const albums = ['status', 'inventory', 'history', 'history.read', 'restore', 'cancel', 'provenance.list', 'provenance.read', 'provenance.review'].includes(operation) ? [] : await this.albums()
    return this.operate(pluginId, operation, albums, args)
  }
  private async albums(): Promise<ExperienceMusicAlbum[]> {
    const albums: ExperienceMusicAlbum[] = []
    let offset = 0,
      revision: number | undefined
    for (;;) {
      const page = await this.database.queryCollections('albums', {
        offset,
        limit: 200,
        contentRevision: revision
      })
      revision = page.revision
      for (const summary of page.items) {
        const id = legacyExperienceAlbumId(summary.id)
        const tracks: MusicAlbum['tracks'] = []
        let firstGenre: string | undefined
        let trackOffset = 0
        for (;;) {
          const members = await this.database.queryTracks({
            albumId: summary.id,
            sort: 'trackNumber',
            contentRevision: revision,
            offset: trackOffset,
            limit: 200
          })
          tracks.push(
            ...members.tracks.map((record, index) => {
              const track = libraryTrack(record)
              if (trackOffset === 0 && index === 0) firstGenre = track.genre ?? undefined
              return {
                id: track.id,
                albumId: id,
                title: track.title,
                artist: track.artist,
                duration: track.duration,
                format: track.format ?? '',
                trackNumber: track.trackNumber,
                discNumber: track.discNumber,
                sampleRate: track.sampleRate,
                bitsPerSample: track.bitDepth,
                bitrate: track.bitrate,
                browserPlayable: true,
                audioUrl: '',
                relativePath: ''
              }
            })
          )
          trackOffset += members.tracks.length
          if (trackOffset >= members.total) break
          if (!members.tracks.length) throw new Error('专辑曲目分页中断')
        }
        albums.push({
          id,
          collectionId: summary.id,
          contentRevision: revision,
          title: summary.name,
          artist: summary.artist ?? '',
          year: summary.releaseDate ? Number(summary.releaseDate.slice(0, 4)) : undefined,
          genreId: firstGenre || summary.genre || '未分类',
          rawGenres: [],
          folder: '',
          coverUrl:
            summary.cover?.startsWith('cover://') || summary.cover?.startsWith('data:image/')
              ? summary.cover
              : undefined,
          tracks,
          producers: [],
          offline: false
        })
      }
      offset += page.items.length
      if (offset >= page.total) return albums
      if (!page.items.length) throw new Error('曲库专辑分页中断')
    }
  }
}
