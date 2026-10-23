import { shallowRef } from 'vue'
import type { TestContext } from 'node:test'
import type {
  CoreSnapshot,
  CoreQueries,
  CoreQueryName,
  CoreCommands,
  CoreCommandName,
  CoreClientMessage
} from '../../../shared/coreProtocol.ts'
import type { Playlist } from '../../../shared/playlists.ts'
import type { LibraryTrackRecord } from '../../../shared/libraryDatabase.ts'
import type { PlaylistRuntime } from '../../../core/playlists/ports.ts'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import { CoreStateDatabase } from '../../../main/library/coreStateDatabase.ts'
import { CoreRecordingVersions } from '../../../core/playlists/recordingVersions.ts'
import { CorePlaylistService } from '../../../core/playlists/service.ts'
import {
  CorePlaylistSubmission,
  createPlaylistInputResolver
} from '../../../core/playlists/submission.ts'
import { createQueueInputResolver } from '../../../core/playback/queueInputResolver.ts'
import { CoreMusicSearchService } from '../../../core/search/service.ts'
import { emptyCoreStateCounts } from '../../../shared/coreState.ts'
import { emptyMusicVersions } from '../../../shared/musicVersions.ts'
import { coreSnapshot, coreLibraryPage, playlistRuntime } from './coreTestFixtures.ts'
import type { createCoreConnectionStore } from './coreConnection.ts'

/** Real Core repositories and domain services, with only the process transport replaced. */
export async function coreLibraryFixture(
  t: TestContext,
  options: {
    tracks?: LibraryTrackRecord[]
    playlists?: Playlist[]
    repository?: PlaylistRuntime['repository']
  } = {}
) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: options.tracks ?? []
  })
  const stateDb = new CoreStateDatabase(':memory:')
  stateDb.begin('fixture', { version: 1, counts: emptyCoreStateCounts() })
  stateDb.commit('fixture')
  const versions = new CoreRecordingVersions({
    coreStateRead: async (...args) => stateDb.read(...args),
    coreVersionsReplace: async (...args) => stateDb.replaceVersions(...args)
  })
  await versions.initialize()
  let revision = 1,
    document = structuredClone(options.playlists ?? [])
  const envelope = () => ({
    version: 2 as const,
    revision,
    savedAt: '',
    data: structuredClone(document)
  })
  const repository: PlaylistRuntime['repository'] = options.repository ?? {
    load: async () => envelope(),
    save: async (next, expected) => {
      if (expected !== revision) throw new Error('fixture repository revision mismatch')
      document = structuredClone(next)
      revision++
      return envelope()
    }
  }
  const state = shallowRef(
    coreSnapshot({
      libraryRevision: db.getMetadata().revision,
      versionsRevision: versions.getRevision(),
      playlistsRevision: 1
    })
  )
  const listeners = new Set<(message: CoreClientMessage) => void>()
  const publish = (patch: Partial<CoreSnapshot> = {}) => {
    state.value = coreSnapshot({ ...state.value, ...patch, sequence: state.value.sequence + 1 })
    for (const listener of listeners)
      listener({
        kind: 'state',
        epoch: state.value.epoch,
        sequence: state.value.sequence,
        snapshot: state.value
      })
  }
  const database = {
    queryTracks: async (...args: Parameters<typeof db.queryTracks>) => db.queryTracks(...args),
    queryCollections: async (...args: Parameters<typeof db.queryCollections>) =>
      db.queryCollections(...args),
    getMetadata: async () => db.getMetadata(),
    getTracksByIds: async (...args: Parameters<typeof db.getTracksByIds>) =>
      db.getTracksByIds(...args),
    lookupTracksByPaths: async (...args: Parameters<typeof db.lookupTracksByPaths>) =>
      db.lookupTracksByPaths(...args),
    syncPlaylistView: async (...args: Parameters<typeof db.syncPlaylistView>) =>
      db.syncPlaylistView(...args)
  }
  const playlists = new CorePlaylistService({
    runtime: { ...playlistRuntime(), repository },
    database,
    versions: {
      getRevision: versions.getRevision.bind(versions),
      snapshot: () => emptyMusicVersions()
    },
    changed: () => publish({ playlistsRevision: playlists.getRevision() })
  })
  await playlists.initialize()
  publish({ playlistsRevision: playlists.getRevision() })
  const resolveInputs = createQueueInputResolver({
    database: {
      getTracksByIds: database.getTracksByIds,
      readLibraryQueue: async () => {
        throw new Error('unused queue')
      }
    },
    authorizeLocal: async (path) => path,
    providers: () => new Set(['ncm']),
    network: async () => {
      throw new Error('unused network')
    },
    streams: () => new Map()
  })
  const submissions = new CorePlaylistSubmission({
    playlists,
    resolve: createPlaylistInputResolver(resolveInputs, database),
    newId: () => crypto.randomUUID(),
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref()
      return () => clearTimeout(timer)
    }
  })
  const search = new CoreMusicSearchService({
    database,
    versions,
    playlists,
    providers: () => [],
    searchProvider: async () => ({ items: [], total: 0 }),
    searchCollectionProvider: async () => ({ items: [], total: 0 }),
    network: { revision: () => 0, search: async () => [] }
  })
  const queries: Array<{ name: string; payload: unknown }> = [],
    commands: Array<{ name: string; payload: unknown }> = []
  let intercept:
    | ((name: string, payload: unknown, signal?: AbortSignal) => Promise<void>)
    | undefined
  async function query<K extends CoreQueryName>(
    name: K,
    payload: CoreQueries[K]['input'],
    signal?: AbortSignal
  ): Promise<CoreQueries[K]['output']> {
    signal?.throwIfAborted()
    queries.push({ name, payload })
    await intercept?.(name, payload, signal)
    signal?.throwIfAborted()
    const p = payload as any
    let value: unknown
    switch (name) {
      case 'library.metadata':
        value = db.getMetadata()
        break
      case 'library.tracks':
        value = coreLibraryPage(db.queryTracks(p))
        break
      case 'library.byIds':
        value = coreLibraryPage(db.getTracksByIds(p.ids, p.revision))
        break
      case 'library.paths.lookup':
        value = db.lookupTracksByPaths(p.paths, p.revision)
        break
      case 'library.collections':
        value = db.queryCollections(p.kind, p.query)
        break
      case 'library.artwork': {
        const page = db.getTracksByIds(p.ids, p.revision)
        value = {
          revision: page.revision,
          items: page.tracks.map((track) => ({
            id: track.id,
            cover: typeof track.cover === 'string' ? track.cover : null
          }))
        }
        break
      }
      case 'library.recent.resolve':
        value = {
          revision: p.revision,
          versionsRevision: p.versionsRevision,
          ids: p.entries.map(
            (entry: { id: string; sourceIds?: string[]; snapshot?: { id: string } }) => {
              const ids = [...(entry.sourceIds ?? []), entry.snapshot?.id ?? entry.id]
              return db.getTracksByIds(ids, p.revision).tracks[0]?.id ?? null
            }
          )
        }
        break
      case 'playlists.state':
        value = playlists.state()
        break
      case 'playlists.catalog':
        value = playlists.catalog(p.offset, p.limit, p.revision)
        break
      case 'playlists.members':
        value = await playlists.members(p)
        break
      case 'playlists.view':
        value = await playlists.view(p, signal)
        break
      case 'playlists.collection':
        value = await playlists.collection(p, signal)
        break
      case 'playlists.export':
        value = await playlists.exportDocument(p.id, p.revision, p.format)
        break
      case 'search.songs':
        value = await search.page(p, signal)
        break
      case 'search.collections':
        value = await search.collections(p, signal)
        break
      case 'metadata.status':
        value = {
          state: 'idle',
          total: 0,
          queued: 0,
          active: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          error: ''
        }
        break
      default:
        throw new Error(`unsupported fixture query ${name}`)
    }
    return value as CoreQueries[K]['output']
  }
  async function command<K extends CoreCommandName>(
    name: K,
    payload: CoreCommands[K],
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted()
    commands.push({ name, payload })
    await intercept?.(name, payload, signal)
    signal?.throwIfAborted()
    const p = payload as any
    switch (name) {
      case 'playlists.edit':
        return playlists.edit(p.revision, p.edit, signal)
      case 'playlists.submit':
        return submissions.submit('renderer', p)
      case 'playlists.importDocument':
        return playlists.importDocument(p.id, p.revision, p.fileName, p.contents, signal)
      case 'playlists.flush':
        return playlists.flush()
      case 'library.reset':
        db.replaceDocument({ version: 2, revision: 0, tracks: [], folders: [], exclusions: [] })
        publish({ libraryRevision: db.getMetadata().revision })
        return
      case 'scan.start':
        return { jobId: 'core-scan' }
      case 'scan.pause':
      case 'scan.resume':
      case 'scan.cancel':
      case 'metadata.cancel':
        return
      default:
        throw new Error(`unsupported fixture command ${name}`)
    }
  }
  const core = {
    state,
    query,
    command,
    attach: async () => state.value,
    refresh: async () => state.value,
    subscribe: (listener: (message: CoreClientMessage) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    status: shallowRef(null),
    failure: shallowRef(null)
  } as ReturnType<typeof createCoreConnectionStore>
  t.after(async () => {
    await submissions.shutdown()
    await playlists.shutdown()
    await search.shutdown()
    db.close()
    stateDb.close()
  })
  return {
    db,
    stateDb,
    versions,
    playlists,
    submissions,
    search,
    core,
    state,
    publish,
    queries,
    commands,
    database,
    repository,
    intercept: (value?: typeof intercept) => {
      intercept = value
    },
    get subscribers() {
      return listeners.size
    }
  }
}
