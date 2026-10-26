import type { CoreQueueTrackInput } from '../../shared/coreQueueSubmission.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { LibraryQueueSeedItem } from '../../shared/libraryQueueBuild.ts'
import type { TrackData } from '../../shared/track.ts'
import type { CoreNetworkPlayback } from '../../shared/coreNetwork.ts'
import { libraryTrack } from './libraryTrack.ts'

export function createQueueInputResolver(options: {
  database: Pick<LibraryDatabaseApi, 'getTracksByIds' | 'readLibraryQueue'>
  authorizeLocal(source: string, signal: AbortSignal): Promise<string>
  providers(): ReadonlySet<string>
  network(request: CoreNetworkPlayback, signal: AbortSignal): Promise<TrackData>
  streams(): ReadonlyMap<string, TrackData>
}) {
  return async (
    inputs: readonly CoreQueueTrackInput[],
    signal: AbortSignal
  ): Promise<LibraryQueueSeedItem[]> => {
    signal.throwIfAborted()
    const ids = [
      ...new Set(inputs.filter((input) => input.kind === 'local').map((input) => input.id))
    ]
    const records = ids.length ? await options.database.getTracksByIds(ids) : null
    const local = new Map(records?.tracks.map((record) => [record.id, libraryTrack(record)]))
    const providers = options.providers()
    const streams = options.streams()
    const items: LibraryQueueSeedItem[] = []
    for (const input of inputs) {
      signal.throwIfAborted()
      let track: TrackData
      switch (input.kind) {
        case 'occurrence': {
          const page = await options.database.readLibraryQueue(input.queueId, 0, 1, {
            expectedRevision: input.revision, occurrenceId: input.occurrenceId
          })
          const record = page.items[0]?.track
          if (!record) throw new Error('队列中的曲目已不存在，请刷新队列')
          track = libraryTrack(record)
          if (track.source === 'local') {
            items.push({ id: track.id, localSnapshot: { ...track } })
            continue
          }
          break
        }
        case 'local': {
          const existing = local.get(input.id)
          if (existing) {
            items.push({ id: existing.id })
            continue
          }
          if (!input.fallback) throw new Error('本地曲目已不存在，请刷新曲库')
          const source = await options.authorizeLocal(input.fallback.filePath, signal)
          // Temporary file identity and CUE offsets remain independent of a library import.
          track = {
            ...input.fallback,
            id: input.id,
            source: 'local',
            filePath: source,
            fileName: input.fallback.title,
            size: 0,
            cover: null,
            lyrics: null
          }
          if (track.subTrack) track.subTrack = await options.authorizeLocal(track.subTrack, signal)
          items.push({ id: track.id, localSnapshot: { ...track } })
          continue
        }
        case 'provider':
          if (!providers.has(input.track.source)) throw new Error('音源未安装、未启用或不可用')
          track = {
            ...input.track,
            filePath: '',
            fileName: input.track.title,
            size: 0,
            cover: null,
            lyrics: null
          }
          break
        case 'network':
          track = await options.network(
            { revision: input.revision, profileId: input.profileId, entryId: input.entryId },
            signal
          )
          break
        case 'stream': {
          const saved = streams.get(`${input.source}:${input.id}`)
          if (!saved) throw new Error('电台或播客条目已移除')
          track = saved
          break
        }
      }
      items.push({ id: track.id, snapshot: { ...track } })
    }
    signal.throwIfAborted()
    return items
  }
}
