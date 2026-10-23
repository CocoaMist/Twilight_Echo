import type { Playlist } from '../../shared/playlists.ts'
import type { TrackData } from '../../shared/track.ts'
import { toPlaylistTrackSnapshot } from './data.ts'
import {
  reconcileImportEntries,
  type ImportedPlaylistData,
  type ImportResolution,
  type PlaylistImportDocument
} from '../../shared/externalPlaylist.ts'
import { mapImportTable } from '../../shared/playlistImportTable.ts'
import type {
  CoreImportPreview,
  CoreImportPreviewChoices,
  CoreImportPreviewPage,
  CoreImportPreviewConfigure,
  CoreImportPreviewSave,
  PlaylistReadCredentials
} from '../../shared/coreImports.ts'
import type { createPlaylistReader } from './reader.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'

interface Preview {
  playlist: Playlist & { imported: ImportedPlaylistData }
  document: PlaylistImportDocument
  revision: number
  reading: boolean
  saving: boolean
  error: string | null
}
export interface CorePlaylistPreviewsOptions {
  now(): number
  newId(): string
  reader: ReturnType<typeof createPlaylistReader>
  chooseFile(signal: AbortSignal): Promise<string | null>
  readFile(path: string, signal: AbortSignal): Promise<PlaylistImportDocument>
  save(
    playlist: Playlist,
    command: CoreImportPreviewSave,
    signal?: AbortSignal
  ): Promise<{ id: string; revision: number }>
  changed(): void
  reconcile(id?: string): void
}

/** Transient read/matching sessions survive clients, but never enter playlists.json
 * until Save. Page queries expose no credential or private playback URL. */
export class CorePlaylistPreviews {
  private readonly options: CorePlaylistPreviewsOptions
  private readonly previews = new Map<string, Preview>()
  private readonly reads = new Map<string, { controller: AbortController; work: Promise<void> }>()
  private stopped = false
  constructor(options: CorePlaylistPreviewsOptions) {
    this.options = options
  }
  ids(): string[] {
    return [...this.previews.keys()]
  }
  read(id: string): ImportedPlaylistData | undefined {
    return this.previews.get(id)?.playlist.imported
  }
  has(id: string): boolean {
    return this.previews.has(id)
  }
  private get(id: string, revision?: number): Preview {
    const preview = this.previews.get(id)
    if (!preview) throw new Error('暂存歌单已不存在')
    if (revision !== undefined && revision !== preview.revision)
      throw Object.assign(new Error('暂存歌单已更新，请重新读取'), { code: 'STALE_REVISION' })
    return preview
  }
  private changed(preview: Preview): void {
    preview.revision++
    this.options.changed()
  }
  private create(document: PlaylistImportDocument): Preview {
    if (this.stopped) throw new Error('Playlist previews are shutting down')
    const now = new Date(this.options.now()).toISOString()
    const preview: Preview = {
      playlist: {
        id: `pl_${this.options.newId()}`,
        name: document.name,
        trackIds: [],
        transient: true,
        createdAt: now,
        imported: {
          version: 1,
          source: document.source,
          entries: reconcileImportEntries([], document.songs, this.options.newId),
          complete: document.complete,
          expectedTotal: document.total,
          importedAt: now,
          generation: this.options.newId(),
          membershipRevision: 0
        }
      },
      document,
      revision: 0,
      reading: false,
      saving: false,
      error: null
    }
    this.previews.set(preview.playlist.id, preview)
    return preview
  }
  list(offset = 0, limit = 200): { total: number; items: CoreImportPreview[] } {
    return {
      total: this.previews.size,
      items: this.ids()
        .slice(offset, offset + limit)
        .map((id) => this.status(id))
    }
  }
  status(id: string): CoreImportPreview {
    const p = this.get(id),
      data = p.playlist.imported
    return structuredClone({
      id,
      revision: p.revision,
      name: p.playlist.name,
      source: data.source,
      reading: p.reading,
      saving: p.saving,
      complete: data.complete,
      count: data.entries.length,
      total: data.expectedTotal ?? null,
      error: p.error,
      warnings: p.document.warnings,
      columnCount: p.document.columns?.length ?? 0,
      playlistCount: p.document.playlists?.length ?? 0
    })
  }
  choices(
    id: string,
    revision: number,
    kind: 'columns' | 'playlists',
    offset = 0,
    limit = 200
  ): CoreImportPreviewChoices {
    const p = this.get(id, revision)
    const lists = p.document.playlists ?? [],
      columns = p.document.columns ?? []
    return {
      revision,
      offset,
      total: kind === 'columns' ? columns.length : lists.length,
      items:
        kind === 'columns'
          ? columns
              .slice(offset, offset + limit)
              .map((name, index) => ({ index: offset + index, name }))
          : lists
              .slice(offset, offset + limit)
              .map((list, index) => ({
                index: offset + index,
                name: list.name,
                count: list.songs.length
              }))
    }
  }
  page(id: string, revision: number, offset = 0, limit = 200): CoreImportPreviewPage {
    const p = this.get(id, revision),
      entries = p.playlist.imported.entries
    return structuredClone({
      revision,
      offset,
      total: entries.length,
      items: entries.slice(offset, offset + limit).map((entry) => {
        const { locations: _locations, ...original } = entry.original
        return {
          id: entry.entryId,
          original,
          state: entry.resolution.state,
          ...(entry.resolution.message
            ? { message: projectCoreError(entry.resolution.message) }
            : {}),
          track: entry.resolution.track
            ? projectCoreTrack(entry.resolution.track, entry.entryId)
            : null
        }
      })
    })
  }
  start(input: string, credentials?: PlaylistReadCredentials): CoreImportPreview {
    const p = this.create({
      name: '读取中的歌单',
      songs: [],
      source: { kind: 'platform', label: '平台歌单' },
      complete: false,
      warnings: []
    })
    p.reading = true
    const id = p.playlist.id,
      controller = new AbortController()
    const work = this.options
      .reader(input, {
        signal: controller.signal,
        credentials,
        onLink: (link) => {
          p.playlist.imported.source = {
            kind: 'platform',
            label: link.platform,
            platform: link.platform,
            playlistId: link.id,
            url: link.url
          }
          this.changed(p)
        },
        onPage: (page) => {
          const data = p.playlist.imported,
            offset = data.entries.length
          data.entries.push(
            ...reconcileImportEntries([], page.songs, this.options.newId).map((entry) => ({
              ...entry,
              position: entry.position + offset
            }))
          )
          data.membershipRevision++
          data.expectedTotal = page.total
          p.playlist.name = page.name || p.playlist.name
          this.changed(p)
          this.options.reconcile()
        }
      })
      .then((document) => {
        p.document = document
        p.playlist.name = document.name
        p.playlist.imported.complete = true
      })
      .catch((error) => {
        p.error = controller.signal.aborted
          ? '读取已取消，已读条目保留为“不完整”，可重新读取'
          : projectCoreError(error)
        p.playlist.imported.readError = p.error
      })
      .finally(() => {
        p.reading = false
        this.reads.delete(id)
        this.changed(p)
        this.options.reconcile()
      })
    this.reads.set(id, { controller, work })
    this.options.changed()
    return this.status(id)
  }
  async file(signal: AbortSignal): Promise<CoreImportPreview | null> {
    const path = await this.options.chooseFile(signal)
    signal.throwIfAborted()
    if (!path) return null
    const document = await this.options.readFile(path, signal)
    signal.throwIfAborted()
    const p = this.create(document)
    this.changed(p)
    this.options.reconcile()
    return this.status(p.playlist.id)
  }
  configure(command: CoreImportPreviewConfigure): CoreImportPreview {
    const p = this.get(command.id, command.revision)
    if (p.reading || p.saving)
      throw Object.assign(new Error('请等待读取或保存完成'), { code: 'BUSY' })
    let songs = p.playlist.imported.entries.map((e) => e.original),
      name = p.playlist.name
    if (command.playlistIndex !== undefined) {
      const list = p.document.playlists?.[command.playlistIndex]
      if (!list) throw new Error('文件中不存在此歌单')
      songs = list.songs
      name = list.name
    }
    if (command.columns) {
      if (!p.document.table) throw new Error('此文件没有可映射的列')
      for (const index of Object.values(command.columns))
        if (index !== undefined && index >= p.document.table.columns.length)
          throw new Error('列编号超出文件范围')
      songs = mapImportTable(p.document.table, command.columns)
    }
    const data = p.playlist.imported
    if (command.columns || command.playlistIndex !== undefined) {
      data.entries = reconcileImportEntries(data.entries, songs, this.options.newId)
      data.generation = this.options.newId()
      data.membershipRevision++
    }
    p.playlist.name = command.name?.trim() || name
    this.changed(p)
    this.options.reconcile(
      command.columns || command.playlistIndex !== undefined ? command.id : undefined
    )
    return this.status(command.id)
  }
  bind(id: string, revision: number, entryId: string, track: TrackData | null): CoreImportPreview {
    const p = this.get(id, revision)
    if (p.saving) throw Object.assign(new Error('歌单正在保存'), { code: 'BUSY' })
    const entry = p.playlist.imported.entries.find((e) => e.entryId === entryId)
    if (!entry) throw new Error('暂存条目已不存在')
    entry.manualBinding = track ? toPlaylistTrackSnapshot(track) : undefined
    entry.resolution = { state: 'pending' }
    entry.revision++
    this.changed(p)
    this.options.reconcile(id)
    return this.status(id)
  }
  apply(
    id: string,
    generation: string,
    updates: Array<{ entryId: string; revision: number; resolution: ImportResolution }>
  ): Promise<void> {
    const p = this.previews.get(id)
    if (!p || p.playlist.imported.generation !== generation) return Promise.resolve()
    const byId = new Map(updates.map((update) => [update.entryId, update]))
    let changed = false
    for (const entry of p.playlist.imported.entries) {
      const update = byId.get(entry.entryId)
      if (update?.revision === entry.revision) {
        entry.resolution = {
          ...structuredClone(update.resolution),
          ...(update.resolution.track
            ? { track: toPlaylistTrackSnapshot(update.resolution.track) }
            : {})
        }
        changed = true
      }
    }
    if (changed) this.changed(p)
    return Promise.resolve()
  }
  async cancel(id: string): Promise<void> {
    const read = this.reads.get(id)
    read?.controller.abort()
    await read?.work
  }
  async discard(id: string, revision: number): Promise<void> {
    const p = this.get(id, revision)
    if (p.saving) throw Object.assign(new Error('歌单正在保存'), { code: 'BUSY' })
    this.previews.delete(id)
    this.options.reconcile()
    this.options.changed()
    await this.cancel(id)
  }
  async save(
    command: CoreImportPreviewSave,
    signal?: AbortSignal
  ): Promise<{ id: string; revision: number }> {
    const p = this.get(command.id, command.revision)
    if (p.reading || !p.playlist.imported.complete)
      throw new Error('歌单尚未完整读取，完成后才能保存')
    if (p.saving) throw Object.assign(new Error('歌单正在保存'), { code: 'BUSY' })
    p.saving = true
    this.changed(p)
    try {
      const result = await this.options.save(structuredClone(p.playlist), command, signal)
      this.previews.delete(command.id)
      this.options.reconcile()
      return result
    } finally {
      p.saving = false
      this.changed(p)
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    for (const read of this.reads.values()) read.controller.abort()
    await Promise.all([...this.reads.values()].map((read) => read.work))
  }
}
