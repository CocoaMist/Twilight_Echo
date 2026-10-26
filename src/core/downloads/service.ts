import {
  ProviderDownloadManager,
  type ProviderDownloadManagerOptions
} from './providerDownloadManager.ts'
import type {
  CoreDownloadCreate,
  CoreDownloadTask,
  CoreDownloadsQuery,
  CoreDownloadsPage,
  CoreDownloadsState
} from '../../shared/coreDownloads.ts'
import { projectCoreError } from '../projections.ts'
import type { TrackData } from '../../shared/track.ts'

/** One owner outlives every UI attachment; public operations use task identities. */
export class CoreDownloadsService {
  private revision = 0
  private readonly manager: ProviderDownloadManager
  private readonly results: { indexed?(path: string): Promise<boolean>; reveal?(path: string): Promise<void> }
  constructor(options: Omit<ProviderDownloadManagerOptions, 'onChanged'> & {
    changed(): void
    indexed?(path: string): Promise<boolean>
    reveal?(path: string): Promise<void>
  }) {
    this.results = options
    this.manager = new ProviderDownloadManager({
      ...options,
      onChanged: () => {
        this.revision++
        options.changed()
      }
    })
  }
  state(): CoreDownloadsState {
    return {
      revision: this.revision,
      ...this.manager.counts()
    }
  }
  page(query: CoreDownloadsQuery): CoreDownloadsPage {
    if (query.revision !== this.revision)
      throw Object.assign(new Error('Download tasks changed; read a new page'), {
        code: 'STALE_REVISION'
      })
    const offset = query.offset ?? 0
    return {
      ...this.state(),
      offset,
      items: this.manager.page(offset, query.limit ?? 50).map(projectTask)
    }
  }
  async create(input: CoreDownloadCreate): Promise<CoreDownloadTask> {
    return projectTask(await this.manager.create(input))
  }
  cancel(id: string): Promise<void> {
    return this.manager.cancel(id)
  }
  async retry(id: string): Promise<CoreDownloadTask> {
    return projectTask(await this.manager.retry(id))
  }
  async result(id: string, addToLibrary: boolean): Promise<void> {
    await this.manager.completedResult(id, addToLibrary)
  }
  async indexed(id: string): Promise<{ indexed: boolean }> {
    if (!this.results.indexed) throw new Error('Library index lookup is unavailable')
    return { indexed: await this.results.indexed(await this.manager.completedResult(id)) }
  }
  async reveal(id: string): Promise<void> {
    if (!this.results.reveal) throw new Error('File reveal is unavailable')
    await this.results.reveal(await this.manager.completedResult(id))
  }
  /** Private playback source, never returned to a renderer or remote. */
  async playbackTrack(id: string): Promise<TrackData> {
    const task = this.manager.get(id)
    const path = await this.manager.completedResult(id)
    return {
      id: `download:${id}`,
      source: 'local',
      title: task.track.title,
      artist: task.track.artist,
      album: task.track.album ?? '',
      filePath: path,
      duration: 0,
      size: task.fileSize ?? 0,
      fileName: path.split(/[\\/]/).pop()!,
      cover: typeof task.track.cover === 'string' ? task.track.cover : null,
      lyrics: null
    }
  }
  shutdown(): Promise<void> {
    return this.manager.shutdown()
  }
}

function projectTask(task: ReturnType<ProviderDownloadManager['list']>[number]): CoreDownloadTask {
  const {
    id,
    providerId,
    requestedQuality,
    actualQuality,
    qualityVerified,
    status,
    progress,
    queuePosition,
    fileSize,
    createdAt,
    updatedAt
  } = task
  const track = task.track
  return {
    id,
    providerId,
    requestedQuality,
    actualQuality,
    qualityVerified,
    status,
    progress,
    queuePosition,
    fileSize,
    createdAt,
    updatedAt,
    error: task.error ? publicError(task.error) : null,
    warning: task.warning ? projectCoreError(task.warning) : null,
    track: {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: typeof track.album === 'string' ? track.album.slice(0, 300) : undefined,
      cover:
        typeof track.cover === 'string' && track.cover.startsWith('twilight-media://image/')
          ? track.cover
          : undefined
    }
  }
}

function publicError(error: string): string {
  return projectCoreError(error).replace(
    /(?:[a-z]:[\\/]|\\\\)[^\r\n"']+|(?:\/(?:[^\s/'"]+\/)+)[^\s'"\n]*/gi,
    '<file>'
  )
}
