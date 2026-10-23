import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreApplication, type CoreApplicationDependencies } from './application.ts'
import { CoreStateDatabase } from '../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts, type CoreStateApi } from '../shared/coreState.ts'
import type {
  CoreClientIdentity,
  CoreClientMessage,
  CoreRequestEnvelope,
  CoreResponse,
  CoreSnapshot
} from '../shared/coreProtocol.ts'
import { coreOperation } from '../shared/coreProtocol.ts'
import { CoreDownloadsService } from './downloads/service.ts'
import { CoreMusicCacheService } from './cache/service.ts'
import { OpraCatalog } from './audio/opraCatalog.ts'
import { CoreCatalogService } from './catalog/service.ts'
import { LibraryDatabase } from '../main/library/libraryDatabase.ts'
import { emptyMusicVersions } from '../shared/musicVersions.ts'
import type { TrackData } from '../shared/track.ts'

function fixture(
  t: test.TestContext,
  migrated = true,
  downloads?: CoreDownloadsService,
  search?: CoreApplicationDependencies['search'],
  cache?: CoreApplicationDependencies['cache'],
  output?: CoreApplicationDependencies['output'],
  settings?: CoreApplicationDependencies['settings'],
  owners: Partial<CoreApplicationDependencies> = {}
) {
  const database = new CoreStateDatabase(':memory:'),
    calls: string[] = []
  if (migrated) {
    database.begin('previous-upgrade', { version: 1, counts: emptyCoreStateCounts() })
    database.commit('previous-upgrade')
  }
  const playback: CoreApplicationDependencies['playback'] = {
    initialize: async () => {
      calls.push('playback.initialize')
    },
    snapshot: () => ({
      isStreamBuffering: false,
      loading: false,
      abLoop: { revision: 0, occurrenceId: null, a: null, b: null, mode: 'off' },
      mute: { muted: false, userVolume: 0.7, lastAudibleVolume: 0.7 },
      playback: null,
      track: null,
      queue: null,
      error: null,
      personalized: null,
      heart: null
    }),
    play: async () => {
      calls.push('play')
    },
    pause: async () => {
      calls.push('pause')
    },
    stop: async () => {
      calls.push('stop')
    },
    seek: async () => {},
    navigate: async () => {},
    setVolume: async () => {},
    configureAbLoop: async () => ({
      revision: 0,
      occurrenceId: null,
      a: null,
      b: null,
      mode: 'off'
    }),
    configureMute: async () => {},
    control: async () => {},
    setMode: async () => {},
    select: async () => {},
    fromQuery: async () => {},
    fromPages: async () => {},
    fromTrack: async () => {},
    restoreNamedSession: async () => ({ restored: 0, missing: [], deferred: 0 }),
    setRate: async () => {},
    startCast: async () => {
      calls.push('cast.start')
    },
    endCast: async () => {
      calls.push('cast.end')
    },
    observeCast: () => {},
    castFailed: () => {},
    maintainSources: async (action) => action([]),
    startPersonalized: async () => {},
    refillPersonalized: async () => 0,
    startLiked: async () => {},
    refillHeart: async () => 0,
    edit: async () => {},
    refresh: async () => {},
    flush: async () => {
      calls.push('flush')
    },
    captureWorkspace: async () => {
      throw new Error('No fixture queue')
    },
    shutdown: async () => {
      calls.push('playback.shutdown')
    }
  }
  const scan: CoreApplicationDependencies['scan'] = {
    initialize: async () => {
      calls.push('scan.initialize')
    },
    activate: () => {
      calls.push('scan.activate')
    },
    snapshot: () => ({
      jobId: 'scan',
      phase: 'idle',
      state: 'failed',
      checkedFiles: 0,
      parsedFiles: 0,
      committedFiles: 0,
      failedFiles: 0,
      trackCount: 0,
      revision: 0,
      error: 'Scan failed for https://user:private@example.test/file?token=private'
    }),
    start: async () => scan.snapshot()!,
    pause: async () => true,
    resume: async () => scan.snapshot(),
    cancel: async () => true,
    enqueueDirectories: async () => {},
    startup: async () => {},
    poll: async () => undefined,
    shutdown: async () => {
      calls.push('scan.shutdown')
    }
  }
  const state: CoreStateApi = {
    coreStateOpen: async () => {},
    coreStateStatus: async () => database.status(),
    coreStateRead: async (...args) => database.read(...args),
    coreStateWrite: async (...args) => database.write(...args),
    coreMigrationBegin: async (...args) => database.begin(...args),
    coreMigrationStage: async (...args) => database.stage(...args),
    coreMigrationCommit: async (...args) => database.commit(...args),
    coreMigrationAbort: async (...args) => database.abort(...args)
  }
  const application = new CoreApplication({
    settings,
    output,
    cache,
    search,
    downloads,
    epoch: 'current',
    playback,
    scan,
    libraryBackground: {
      activate: () => {
        calls.push('libraryBackground.activate')
      },
      snapshot: () => ({ enabled: false, folders: [] }),
      shutdown: async () => {
        calls.push('libraryBackground.shutdown')
      }
    },
    state,
    statistics: {
      initialize: async () => {
        calls.push('statistics.initialize')
      },
      getRevision: () => 0,
      historySnapshot: () => new Map(),
      summary: () => ({
        revision: 0,
        trackCount: 0,
        days: {},
        persistence: { dirty: false, failureCount: 0, error: null }
      }),
      page: () => ({ revision: 0, total: 0, offset: 0, items: [] }),
      overview: async () => ({
        revision: 0,
        trackCount: 0,
        days: {},
        persistence: { dirty: false, failureCount: 0, error: null },
        recorded: { seconds: 0, plays: 0, trackCount: 0, formats: [] },
        artists: [],
        history: { mode: 'sqlite', ready: true, pending: false, revision: 0, error: '' }
      }),
      previewClear: (_range, revision) => ({
        revision,
        dayCount: 0,
        seconds: 0,
        trackCount: 0,
        hasUndatedTracks: false
      }),
      observe: () => {},
      clear: async () => {},
      flush: async () => {
        calls.push('statistics.flush')
      },
      shutdown: async () => {
        calls.push('statistics.shutdown')
      }
    },
    library: {
      queryCollections: async () => ({
        revision: 1,
        total: 0,
        offset: 0,
        items: [],
        letterOffsets: {}
      }),
      getTracksByIds: async () => ({ revision: 1, total: 0, offset: 0, tracks: [], versions: {} }),
      lookupTracksByPaths: async (paths) => ({ revision: 1, ids: paths.map(() => null) }),
      lookupPlaylistTracks: async ({ entries }) => ({ revision: 1, ids: entries.map(() => null) }),
      getMetadata: async () => ({
        revision: 1,
        trackCount: 1,
        fileCount: 1,
        folders: [],
        exclusions: []
      }),
      queryTracks: async () => ({
        revision: 1,
        total: 1,
        offset: 0,
        versions: { local: 1 },
        tracks: [
          {
            id: 'local',
            filePath: 'https://private:private@host.test/private?token=private',
            title: 'Track',
            credentials: 'private',
            streamUrl: 'private'
          }
        ]
      }),
      readLibraryQueue: async () => ({
        revision: 1,
        libraryRevision: 1,
        total: 1,
        offset: 0,
        items: [
          {
            position: 0,
            queueEntryId: 'occurrence',
            track: { id: 'local', filePath: 'private', title: 'Track', credentials: 'private' }
          }
        ]
      })
    },
    ready: () => calls.push('ready'),
    ...owners
  })
  const messages = new Map<string, CoreClientMessage[]>(),
    identities = new Map<string, CoreClientIdentity>()
  function connect(
    id: string,
    permissions: CoreClientIdentity['permissions'] = [
      'playback:read',
      'playback:write',
      'library:read',
      'library:write',
      'migration:write',
      'statistics:read',
      'statistics:write'
    ]
  ) {
    const identity: CoreClientIdentity = { id, role: 'desktop', permissions }
    identities.set(id, identity)
    messages.set(id, [])
    application.connect(identity, (message) => messages.get(id)!.push(message))
    return identity
  }
  let serial = 0
  async function request(
    id: string,
    name: string,
    payload = {},
    extra: Partial<CoreRequestEnvelope> = {}
  ): Promise<CoreResponse> {
    const requestId = extra.requestId ?? `request:${++serial}`
    await application.request(id, {
      kind: coreOperation(name)?.kind ?? 'command',
      name,
      payload,
      epoch: 'current',
      requestId,
      ...extra
    } as CoreRequestEnvelope)
    return messages
      .get(id)!
      .findLast(
        (message) => message.kind === 'response' && message.requestId === requestId
      ) as CoreResponse
  }
  t.after(async () => {
    await application.shutdown()
    database.close()
  })
  return { application, playback, scan, calls, messages, connect, request }
}

test('Core owns catalog readiness, permissions and explicit source playback through the existing resolver', async t => {
  const db = new LibraryDatabase(':memory:')
  const local: TrackData = { id: 'cue:1', source: 'local', title: 'Local', artist: 'Artist', album: 'Album',
    filePath: 'D:/music/disc.flac', fileName: 'disc.flac', duration: 60, size: 0, cover: null, lyrics: null,
    cueRange: { startSeconds: 10, endSeconds: 70, pregapSeconds: 0 } }
  db.replaceDocument({ version: 2, revision: 0, tracks: [local], folders: [], exclusions: [] })
  const remote = { ...local, id: 'ncm:7', source: 'ncm', ncmSongId: 7, filePath: '', cueRange: undefined }
  let job = db.catalogSync({ kind: 'begin', revision: 0 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [remote] })
  db.catalogSync({ kind: 'commit', ...job })
  const catalog = new CoreCatalogService({
    database: {
      catalogStatus: async () => db.catalogStatus(), catalogAdvance: async limit => db.catalogAdvance(limit),
      catalogQuery: async query => db.catalogQuery(query), catalogDetail: async (...args) => db.catalogDetail(...args),
      catalogSources: async query => db.catalogSources(query), catalogSync: async request => db.catalogSync(request),
      catalogProjectVersions: async (...args) => db.catalogProjectVersions(...args), catalogResolve: async (...args) => db.catalogResolve(...args)
    },
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: { getRevision: () => 0, sourceTracks: () => [remote] },
    changed: () => {}, failed: error => assert.fail(String(error))
  })
  let providerEnabled = true
  const resolved: string[] = [], played: TrackData[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    catalog,
    resolvePlaylistInputs: async inputs => {
      if (!providerEnabled) throw new Error('音源未启用')
      assert.equal(inputs[0].kind, 'provider')
      if (inputs[0].kind === 'provider') resolved.push(inputs[0].track.id)
      return [remote]
    }
  })
  f.playback.fromTrack = async (source, _position, _play, signal) => {
    played.push(typeof source === 'function' ? await source(signal ?? new AbortController().signal) : source)
  }
  f.connect('reader', ['library:read'])
  f.connect('player', ['library:read', 'playback:write', 'providers:call'])
  f.connect('blind', ['playback:write'])
  assert.equal((await f.request('reader', 'catalog.refresh')).ok, false)
  assert.equal(db.catalogStatus().localPending, true, 'catalog does not run before Core readiness')
  await f.application.initialize()
  for (let i = 0; i < 100 && (await catalog.status()).state === 'running'; i++)
    await new Promise<void>(resolve => setImmediate(resolve))
  const page = await f.request('reader', 'catalog.query', { kind: 'recording' })
  assert.ok(page.ok)
  const rows = db.catalogQuery({ kind: 'recording' }).items
  const sources = rows.flatMap(row => db.catalogSources({ entityId: row.id }).items)
  const ref = sources.find(source => source.provider === 'local')!
  const online = sources.find(source => source.provider === 'ncm')!
  const revision = db.catalogStatus().revision
  assert.equal((await f.request('blind', 'catalog.play', { sourceId: ref.id, revision })).ok, false)
  assert.equal(f.application.snapshot({ id: 'blind', role: 'desktop', permissions: [] }).catalogRevision, null)
  assert.equal((await f.request('player', 'catalog.play', { sourceId: ref.id, revision })).ok, true)
  assert.deepEqual(played[0].cueRange, local.cueRange)
  assert.equal(played[0].sourceSelection, 'explicit')
  assert.equal((await f.request('player', 'catalog.play', { sourceId: online.id, revision })).ok, true)
  assert.deepEqual(resolved, ['ncm:7'])
  providerEnabled = false
  assert.equal((await f.request('player', 'catalog.play', { sourceId: online.id, revision })).ok, false)
  assert.equal(played.length, 2, 'an explicit unavailable source never falls back to local')
  assert.equal((await f.request('player', 'catalog.play', { sourceId: ref.id, revision: revision - 1 })).ok, false)
  await catalog.shutdown()
  db.close()
})

test('Core owns OPRA queries and refresh survives window detach without blocking playback', async (t) => {
  const catalog = OpraCatalog.fromText([
    { type: 'vendor', id: 'v', data: { name: 'Vendor' } },
    { type: 'product', id: 'p', data: { name: 'Headphone', vendor_id: 'v' } },
    { type: 'eq', id: 'eq', data: { product_id: 'p', parameters: { gain_db: -3, bands: [{ type: 'peak_dip', frequency: 100, gain_db: 2, q: 1 }] } } }
  ].map(row => JSON.stringify(row)).join('\n'), 'profile/opra/database_v1.jsonl')
  let finish!: () => void
  let refreshes = 0
  catalog.refresh = async () => {
    refreshes++
    await new Promise<void>(resolve => { finish = resolve })
    return catalog.getStatus()
  }
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { opra: catalog })
  await f.application.initialize()
  f.connect('reader', ['settings:read'])
  f.connect('writer', ['settings:write', 'playback:write'])
  assert.equal((await f.request('reader', 'opra.refresh')).ok, false)
  const search = await f.request('reader', 'opra.search', { query: ' vendor headphone ' })
  assert.ok(search.ok)
  assert.equal((search.value as { eqId: string }[])[0].eqId, 'eq')
  const profile = await f.request('reader', 'opra.profile', { id: ' eq ' })
  assert.ok(profile.ok)
  assert.equal((profile.value as { preampDb: number }).preampDb, -3)
  const updating = f.request('writer', 'opra.refresh')
  await new Promise<void>(resolve => setImmediate(resolve))
  f.application.disconnect('reader')
  assert.equal((await f.request('writer', 'playback.pause')).ok, true)
  assert.ok(f.calls.includes('pause'))
  f.connect('recreated', ['settings:read'])
  assert.equal((await f.request('recreated', 'opra.status')).ok, true)
  finish()
  assert.equal((await updating).ok, true)
  assert.equal(refreshes, 1)
  assert.equal((await f.request('recreated', 'opra.profile', { id: 'eq' })).ok, true)
})

test('queue identities feed playlist writes and output diagnostics keep their own permission', async (t) => {
  const writes: unknown[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    playlists: {
      getRevision: () => 3,
      initialize: async () => {},
      shutdown: async () => {},
      edit: async (...args: unknown[]) => {
        writes.push(args)
        return 4
      }
    } as unknown as CoreApplicationDependencies['playlists']
  })
  await f.application.initialize()
  f.connect('desktop')
  const locate = await f.request('desktop', 'queue.locate', {
    id: 'queue',
    revision: 1,
    occurrenceId: 'occurrence'
  })
  assert.deepEqual(locate, {
    kind: 'response',
    epoch: 'current',
    requestId: locate.requestId,
    ok: true,
    value: { position: 0 }
  })
  const added = await f.request('desktop', 'playlists.addQueueEntries', {
    id: 'playlist',
    revision: 3,
    queue: { id: 'queue', revision: 1 },
    occurrenceIds: ['occurrence']
  })
  assert.equal(added.ok, true)
  const [revision, edit] = writes[0] as [
    number,
    { kind: string; tracks: Array<{ filePath: string; queueEntryId: string }> }
  ]
  assert.equal(revision, 3)
  assert.equal(edit.kind, 'add')
  assert.equal(edit.tracks[0].filePath, 'private')
  assert.equal(edit.tracks[0].queueEntryId, 'occurrence')
  assert.doesNotMatch(JSON.stringify(added), /private/)
  f.connect('writer', ['library:write'])
  const denied = await f.request('writer', 'playlists.addQueueEntries', {
    id: 'playlist',
    revision: 3,
    queue: { id: 'queue', revision: 1 },
    occurrenceIds: ['occurrence']
  })
  assert.equal(denied.ok, false)
  const diagnostic = await f.request('desktop', 'playback.diagnostics')
  assert.equal(diagnostic.ok, false)
  if (!diagnostic.ok) assert.equal(diagnostic.error.code, 'FORBIDDEN')
  assert.equal(writes.length, 1)
  const hidden = f.application.snapshot({
    id: 'writer',
    role: 'plugin',
    permissions: ['library:write']
  })
  assert.equal(hidden.abLoop, null)
  assert.equal(hidden.mute, null)
  assert.equal(hidden.presentationRevision, null)
  assert.equal(hidden.playback, null)
})

test('finite Core playlist, import and file operations resolve source identities in Core without controlling playback', async (t) => {
  const writes: unknown[] = [],
    resolvedInputs: unknown[] = [],
    revealed: string[] = []
  const track = {
    id: 'ncm:7',
    source: 'ncm',
    title: 'Seven',
    artist: 'Singer',
    album: 'Album',
    filePath: 'private-core-path',
    fileName: 'seven.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null
  }
  const playlist = {
    getRevision: () => 4,
    initialize: async () => {},
    shutdown: async () => {},
    edit: async (...args: unknown[]) => {
      writes.push(['edit', ...args])
      return { revision: 5 }
    },
    favorites: async (...args: unknown[]) => {
      writes.push(['favorites', ...args])
      return { revision: 5 }
    }
  }
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    playlists: playlist as unknown as CoreApplicationDependencies['playlists'],
    library: {
      getMetadata: async () => ({
        revision: 1,
        trackCount: 1,
        fileCount: 1,
        folders: [],
        exclusions: []
      }),
      queryTracks: async () => ({ revision: 1, total: 1, offset: 0, tracks: [], versions: {} }),
      getTracksByIds: async () => ({
        revision: 1,
        total: 1,
        offset: 0,
        tracks: [{ id: 'local', source: 'local', filePath: 'D:/fixture/song.flac' }],
        versions: { local: 1 }
      }),
      queryCollections: async () => ({
        revision: 1,
        total: 0,
        offset: 0,
        items: [],
        letterOffsets: {}
      }),
      readLibraryQueue: async () => ({
        revision: 1,
        libraryRevision: 1,
        total: 0,
        offset: 0,
        items: []
      })
    } as unknown as CoreApplicationDependencies['library'],
    resolvePlaylistInputs: async (inputs) => {
      resolvedInputs.push(inputs)
      return [track]
    },
    playlistSources: {
      replace: async (...args) => {
        writes.push(['replace', ...args])
        return { revision: 5, count: 1, track: { id: track.id } }
      },
      rematch: async (...args) => {
        writes.push(['rematch', ...args])
        return { revision: 5, count: 1 }
      }
    } as unknown as CoreApplicationDependencies['playlistSources'],
    importPreviews: {
      bind: async (...args: unknown[]) => {
        writes.push(['previewBind', ...args])
        return { revision: 5 }
      },
      shutdown: async () => {}
    } as unknown as CoreApplicationDependencies['importPreviews'],
    revealAudioFile: async (path) => {
      revealed.push(path)
    }
  })
  await f.application.initialize()
  f.connect('desktop')
  const input = {
    kind: 'provider' as const,
    track: {
      id: track.id,
      source: 'ncm',
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration
    }
  }

  const favorites = await f.request('desktop', 'playlists.favorites', {
    revision: 4,
    items: [input]
  })
  assert.equal(favorites.ok, true)
  assert.deepEqual(resolvedInputs, [[input]])
  assert.deepEqual(writes[0], ['favorites', 4, [track]])

  const replaced = await f.request('desktop', 'playlists.replaceSource', {
    revision: 4,
    oldTrackId: 'local:old',
    input
  })
  assert.equal(replaced.ok, true)
  assert.equal((writes[1] as unknown[])[0], 'replace')
  assert.equal(f.calls.includes('play'), false)

  const bound = await f.request('desktop', 'imports.previewBind', {
    id: 'preview',
    revision: 4,
    entryId: 'entry',
    input
  })
  assert.equal(bound.ok, true)
  assert.equal((writes[2] as unknown[])[0], 'previewBind')

  const reveal = await f.request('desktop', 'library.reveal', { id: 'local' })
  assert.equal(reveal.ok, true)
  assert.deepEqual(revealed, ['D:/fixture/song.flac'])
  assert.equal(revealed.length, 1)

  const preview = await f.request('desktop', 'statistics.previewClear', {
    range: null,
    revision: 0
  })
  assert.equal(preview.ok, true)
  assert.equal(f.calls.includes('play'), false)
})

test('recent library resolution fences recording-version changes before publishing ids', async (t) => {
  let versionRevision = 3
  const lookup: unknown[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    recordingVersions: {
      initialize: async () => {},
      getRevision: () => versionRevision,
      snapshot: () => ({
        tracks: { versions: [], families: [] },
        albums: { versions: [], families: [] }
      }),
      flush: async () => {}
    } as unknown as CoreApplicationDependencies['recordingVersions'],
    library: {
      getMetadata: async () => ({
        revision: 7,
        trackCount: 0,
        fileCount: 0,
        folders: [],
        exclusions: []
      }),
      queryTracks: async () => ({ revision: 7, total: 0, offset: 0, tracks: [], versions: {} }),
      queryCollections: async () => ({
        revision: 7,
        total: 0,
        offset: 0,
        items: [],
        letterOffsets: {}
      }),
      lookupTracksByPaths: async () => ({ revision: 7, ids: [] }),
      getTracksByIds: async () => ({ revision: 7, total: 0, offset: 0, tracks: [], versions: {} }),
      lookupPlaylistTracks: async (request, revision) => {
        lookup.push({ request, revision })
        versionRevision++
        return { ids: [null], revision }
      },
      readLibraryQueue: async () => ({
        revision: 7,
        libraryRevision: 7,
        total: 0,
        offset: 0,
        items: []
      })
    } as unknown as CoreApplicationDependencies['library']
  })
  await f.application.initialize()
  f.connect('desktop')
  const response = await f.request('desktop', 'library.recent.resolve', {
    entries: [
      {
        id: 'history',
        sourceIds: ['local:1'],
        snapshot: {
          id: 'history',
          title: 'Song',
          artist: 'Artist',
          cueRange: { startSeconds: 0, endSeconds: 1, pregapSeconds: 0 }
        }
      }
    ],
    revision: 7,
    versionsRevision: 3
  })
  assert.equal(response.ok, false)
  if (!response.ok) assert.equal(response.error.code, 'STALE_REVISION')
  assert.equal(lookup.length, 1)
})

test('settings readiness, permissions and a slow settings edit leave Pause independent', async (t) => {
  let finish!: () => void
  const held = new Promise<void>((done) => {
    finish = done
  })
  let initialized = false,
    edits = 0
  const volumes: number[] = []
  const settings: NonNullable<CoreApplicationDependencies['settings']> = {
    getRevision: () => 4,
    state: () => ({ revision: 4, settings: {} as import('../shared/appSettings.ts').AppSettings }),
    initialize: async () => {
      initialized = true
    },
    edit: async () => {
      edits++
      await held
      return settings.state()
    },
    flush: async () => {},
    rememberVolume: (volume) => {
      volumes.push(volume)
    }
  }
  const f = fixture(t, false, undefined, undefined, undefined, undefined, settings)
  f.connect('desktop', [
    'playback:read',
    'playback:write',
    'settings:read',
    'settings:write',
    'migration:write'
  ])
  f.connect('plugin', ['playback:read'])
  await f.application.initialize()
  assert.equal(initialized, false)
  assert.equal(
    (await f.request('desktop', 'settings.edit', { revision: 4, patch: { theme: 'dark' } })).ok,
    false
  )
  await f.request('desktop', 'migration.begin', {
    id: 'upgrade',
    manifest: { version: 1, counts: emptyCoreStateCounts() }
  })
  await f.request('desktop', 'migration.commit', { id: 'upgrade' })
  assert.equal(initialized, true)
  assert.equal(f.application.snapshot().settingsRevision, 4)
  assert.equal(
    f.application.snapshot({ id: 'plugin', role: 'plugin', permissions: ['playback:read'] })
      .settingsRevision,
    null
  )
  const denied = await f.request('plugin', 'settings.state')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  const editing = f.request('desktop', 'settings.edit', { revision: 4, patch: { theme: 'dark' } })
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(edits, 1)
  assert.equal((await f.request('desktop', 'playback.pause')).ok, true)
  finish()
  assert.equal((await editing).ok, true)
  const initial = f.playback.snapshot()
  const actual = { volume: 0.4, outputBackend: 'wasapi' } as NonNullable<typeof initial.playback>
  f.playback.snapshot = () => ({ ...initial, playback: actual })
  await f.request('desktop', 'playback.volume', { volume: 0.9 })
  assert.deepEqual(volumes, [0.4], 'persist the applied device ceiling, not the requested value')
  actual.outputBackend = 'cast'
  await f.request('desktop', 'playback.volume', { volume: 0.2 })
  assert.deepEqual(
    volumes,
    [0.4],
    'remote receiver volume is not the local software volume preference'
  )
})

test('audio output permissions, revision events and slow output work do not block Pause', async (t) => {
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  let edits = 0
  const output: NonNullable<CoreApplicationDependencies['output']> = {
    getRevision: () => 7,
    changed: () => {},
    state: async () =>
      ({ revision: 7 }) as Awaited<
        ReturnType<NonNullable<CoreApplicationDependencies['output']>['state']>
      >,
    profiles: async () =>
      ({ revision: 7 }) as Awaited<
        ReturnType<NonNullable<CoreApplicationDependencies['output']>['profiles']>
      >,
    edit: async () => {
      edits++
      await held
    },
    editProfiles: async () => {
      edits++
    },
    flush: async () => {},
    shutdown: async () => {}
  }
  const f = fixture(t, true, undefined, undefined, undefined, output)
  await f.application.initialize()
  f.connect('ordinary')
  f.connect('audio-editor', ['playback:read', 'playback:write', 'settings:read', 'settings:write'])
  assert.equal(
    f.application.snapshot({ id: 'plugin', role: 'plugin', permissions: ['playback:read'] })
      .audioRevision,
    null
  )
  assert.equal(f.application.snapshot().audioRevision, 7)
  const forbidden = await f.request('ordinary', 'audio.output.edit', {
    revision: 7,
    edit: { kind: 'exclusive', enabled: true }
  })
  assert.equal(forbidden.ok, false)
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN')
  const editing = f.request('audio-editor', 'audio.output.edit', {
    revision: 7,
    edit: { kind: 'exclusive', enabled: true }
  })
  const paused = await f.request('audio-editor', 'playback.pause')
  assert.equal(paused.ok, true)
  assert.equal(edits, 1)
  finish()
  assert.equal((await editing).ok, true)
  const view = await f.request('audio-editor', 'audio.output')
  assert.equal(view.ok, true)
  if (view.ok) assert.deepEqual(view.value, { revision: 7 })
})

test('initial snapshot/subscription and readiness gate prevent all business work until atomic migration publication', async (t) => {
  const f = fixture(t, false)
  await f.application.initialize()
  f.connect('desktop')
  const initial = f.messages.get('desktop')![0]
  assert.equal(initial.kind, 'state')
  if (initial.kind !== 'state') return
  assert.equal(initial.sequence, initial.snapshot.sequence)
  assert.equal(initial.snapshot.phase, 'starting')
  assert.equal(initial.snapshot.migrationRequired, true)
  for (const name of ['playback.pause', 'scan.start', 'library.tracks', 'statistics.summary']) {
    const reply = await f.request('desktop', name, name === 'scan.start' ? { mode: 'full' } : {})
    assert.equal(reply.ok, false)
    if (!reply.ok) assert.equal(reply.error.code, 'NOT_READY')
  }
  assert.ok(!f.calls.includes('scan.activate'))
  assert.ok(!f.calls.includes('libraryBackground.activate'))
  assert.ok(!f.calls.includes('statistics.initialize'))
  await f.request('desktop', 'migration.begin', {
    id: 'upgrade',
    manifest: { version: 1, counts: emptyCoreStateCounts() }
  })
  const committed = await f.request('desktop', 'migration.commit', { id: 'upgrade' })
  assert.equal(committed.ok, true)
  assert.equal(f.application.snapshot().phase, 'ready')
  assert.equal(f.application.snapshot().migrationRequired, false)
  assert.equal(f.calls.filter((call) => call === 'scan.activate').length, 1)
  assert.equal(f.calls.filter((call) => call === 'libraryBackground.activate').length, 1)
  assert.ok(f.calls.indexOf('scan.activate') < f.calls.indexOf('libraryBackground.activate'))
  assert.equal(f.calls.filter((call) => call === 'statistics.initialize').length, 1)
  await f.request('desktop', 'migration.commit', { id: 'upgrade' })
  assert.equal(f.calls.filter((call) => call === 'ready').length, 1)
  assert.equal(f.calls.filter((call) => call === 'libraryBackground.activate').length, 1)
})

test('main-bound capabilities, exact command payloads, epoch and duplicate IDs fence dispatch at the Core too', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.connect('plugin', ['playback:read'])
  const denied = await f.request('plugin', 'playback.pause')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  const invalid = await f.request('desktop', 'playback.pause', { injected: true })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_REQUEST')
  const stale = await f.request('desktop', 'playback.pause', {}, { epoch: 'retired' })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'STALE_EPOCH')
  assert.equal((await f.request('desktop', 'playback.pause', {}, { requestId: 'once' })).ok, true)
  const duplicate = await f.request('desktop', 'playback.pause', {}, { requestId: 'once' })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(f.calls.filter((call) => call === 'pause').length, 1)
  const history = await f.request('plugin', 'statistics.summary')
  assert.equal(history.ok, false)
  if (!history.ok) assert.equal(history.error.code, 'FORBIDDEN')
})

test('cache ownership is dispatched through Core and requires settings access rather than library write', async (t) => {
  let clears = 0
  const action = <T>(run: () => Promise<T>) => run()
  const cache = new CoreMusicCacheService({
    authorize: async () => {},
    maintainSources: (run) => run([]),
    maintainResources: action,
    maintainNetwork: action,
    maintainProvider: action,
    maintainScanner: action,
    clearFiles: async () => {
      clears++
    },
    clearPlatform: async () => {},
    info: async () => ({ sizeBytes: 4 }),
    clearNetwork: async () => ({ sizeBytes: 2 })
  })
  const f = fixture(t, true, undefined, undefined, cache)
  await f.application.initialize()
  f.connect('library-writer', ['library:write'])
  f.connect('settings-reader', ['settings:read'])
  f.connect('settings-writer', ['settings:write'])
  for (const id of ['library-writer', 'settings-reader']) {
    const denied = await f.request(id, 'cache.clear')
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  }
  assert.equal(clears, 0)
  const info = await f.request('settings-reader', 'cache.info')
  assert.ok(info.ok)
  assert.deepEqual(info.value, { sizeBytes: 4 })
  assert.equal(
    (await f.request('settings-writer', 'cache.clear', {}, { requestId: 'clear-once' })).ok,
    true
  )
  const duplicate = await f.request(
    'settings-writer',
    'cache.clear',
    {},
    { requestId: 'clear-once' }
  )
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(clears, 1)
})

test('slow source work is cancellable per client while another window can pause; disconnect suppresses late replies', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.connect('mini')
  let aborted = false
  f.playback.play = async (_position, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal!.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(Object.assign(new Error('Preview cancelled'), { code: 'CANCELLED' }))
        },
        { once: true }
      )
    })
  const pending = f.application.request('desktop', {
    kind: 'command',
    name: 'playback.play',
    payload: {},
    epoch: 'current',
    requestId: 'slow'
  })
  assert.equal((await f.request('mini', 'playback.pause')).ok, true)
  f.application.disconnect('desktop')
  await pending
  assert.equal(aborted, true)
  assert.equal(
    f.messages.get('desktop')!.filter((message) => message.kind === 'response').length,
    0
  )
  assert.equal(f.calls.filter((call) => call === 'pause').length, 1)
})

test('reconnecting UI clients only reattach projections; ordered snapshots and library/queue responses never publish credentials', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.connect('plugin', ['playback:read'])
  const before = [...f.calls]
  for (let i = 0; i < 5; i++) {
    f.application.disconnect('desktop')
    f.connect('desktop')
    const response = await f.request('desktop', 'state.snapshot')
    assert.equal(response.ok, true)
  }
  assert.deepEqual(f.calls, before)
  f.application.changed()
  f.application.changed()
  const events = f.messages.get('desktop')!.filter((message) => message.kind === 'state')
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3]
  )
  for (const name of ['library.tracks', 'queue.page', 'scan.status']) {
    const reply = await f.request(
      'desktop',
      name,
      name === 'queue.page' ? { id: 'queue', revision: 1, offset: 0 } : {}
    )
    assert.equal(reply.ok, true)
    assert.doesNotMatch(JSON.stringify(reply), /private|credentials|streamUrl|filePath/)
  }
  const plugin = await f.request('plugin', 'state.snapshot')
  assert.equal(plugin.ok, true)
  if (plugin.ok) assert.equal((plugin.value as CoreSnapshot).scan, null)
  if (plugin.ok) assert.equal((plugin.value as CoreSnapshot).statisticsRevision, null)
})

test('final shutdown stops the durable scan and waits for in-flight request cancellation before playback persistence', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.playback.play = async (_position, signal) =>
    new Promise<void>((_resolve, reject) =>
      signal!.addEventListener(
        'abort',
        () => {
          f.calls.push('preview.cancelled')
          reject(new Error('Cancelled'))
        },
        { once: true }
      )
    )
  const pending = f.application.request('desktop', {
    kind: 'command',
    name: 'playback.play',
    payload: {},
    epoch: 'current',
    requestId: 'pending'
  })
  await f.application.shutdown()
  await pending
  assert.ok(f.calls.indexOf('preview.cancelled') < f.calls.indexOf('playback.shutdown'))
  assert.ok(f.calls.indexOf('scan.shutdown') < f.calls.indexOf('playback.shutdown'))
  assert.ok(f.calls.indexOf('playback.shutdown') < f.calls.indexOf('statistics.shutdown'))
  assert.equal(f.application.snapshot().phase, 'stopped')
  const stopped = await f.request('desktop', 'playback.pause')
  assert.equal(stopped.ok, false)
  assert.ok(!f.calls.includes('pause'))
})

test('download permissions are independent; library import and playback require their additional capabilities', async (t) => {
  let writes = 0
  const downloads = new CoreDownloadsService({
    authorizedRoots: async () => ({ libraryRoots: ['D:/Music'], downloadRoot: null }),
    grant: async (path) => path,
    changed: () => {},
    pluginManager: {
      callProvider: async () => {
        writes++
        return { jobId: 'private', status: 'failed', requestedQuality: 'lossless', error: 'failed' }
      }
    }
  })
  const f = fixture(t, true, downloads)
  await f.application.initialize()
  f.connect('plugin', ['playback:read', 'playback:write'])
  f.connect('downloader', ['playback:read', 'downloads:read', 'downloads:write'])
  const denied = await f.request('plugin', 'downloads.create', {
    providerId: 'fixture',
    track: { id: 'one', title: 'Song', artist: 'Artist' },
    quality: 'lossless'
  })
  assert.equal(denied.ok, false)
  assert.equal(writes, 0)
  assert.equal(
    f.application.snapshot({ id: 'plugin', role: 'plugin', permissions: ['playback:read'] })
      .downloads,
    null
  )
  const created = await f.request('downloader', 'downloads.create', {
    providerId: 'fixture',
    track: { id: 'one', title: 'Song', artist: 'Artist' },
    quality: 'lossless'
  })
  assert.equal(created.ok, true)
  assert.equal(writes, 1)
  const imported = await f.request('downloader', 'downloads.result', {
    id: 'one',
    addToLibrary: true
  })
  assert.equal(imported.ok, false)
  if (!imported.ok) assert.equal(imported.error.code, 'FORBIDDEN')
  const play = await f.request('plugin', 'downloads.play', { id: 'one' })
  assert.equal(play.ok, false)
  if (!play.ok) assert.equal(play.error.code, 'FORBIDDEN')
  let released!: () => void
  const gate = new Promise<void>((resolve) => {
    released = resolve
  })
  const original = downloads.shutdown.bind(downloads)
  downloads.shutdown = async () => {
    f.calls.push('downloads.stopping')
    await gate
    await original()
    f.calls.push('downloads.stopped')
  }
  const shutdown = f.application.shutdown()
  await Promise.resolve()
  assert.ok(!f.calls.includes('scan.shutdown'))
  released()
  await shutdown
  assert.ok(f.calls.indexOf('downloads.stopped') < f.calls.indexOf('scan.shutdown'))
})

test('AutoMix install intent is a desktop settings command and is applied by the Core owner', async (t) => {
  const intents: boolean[] = []
  const modelPack = {
    start: (enableAfterInstall: boolean) => {
      intents.push(enableAfterInstall)
      return { phase: 'selecting', completedBytes: 0, totalBytes: 0 }
    },
    cancel: () => ({ phase: 'cancelled', completedBytes: 0, totalBytes: 0 }),
    state: () => ({ phase: 'idle', completedBytes: 0, totalBytes: 0 }),
    shutdown: async () => {}
  } as unknown as CoreApplicationDependencies['modelPack']
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { modelPack })
  await f.application.initialize()
  f.connect('installer', ['settings:read', 'settings:write'])
  const started = await f.request('installer', 'automix.install.start', {
    enableAfterInstall: true
  })
  assert.equal(started.ok, true)
  assert.deepEqual(intents, [true])

  const pluginMessages: CoreClientMessage[] = []
  f.application.connect(
    { id: 'plugin-installer', role: 'plugin', permissions: ['settings:read', 'settings:write'] },
    (message) => pluginMessages.push(message)
  )
  const denied = await f.application.request('plugin-installer', {
    kind: 'command',
    name: 'automix.install.start',
    payload: { enableAfterInstall: false },
    epoch: 'current',
    requestId: 'plugin-install'
  })
  const reply = pluginMessages.find(
    (message): message is CoreResponse =>
      message.kind === 'response' && message.requestId === 'plugin-install'
  )
  assert.equal(denied, undefined)
  assert.equal(reply?.ok, false)
  if (reply && !reply.ok) assert.equal(reply.error.code, 'FORBIDDEN')
  assert.deepEqual(intents, [true])
})

test('personalized playback requires both player control and provider access at the Core boundary', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  let starts = 0
  f.playback.startPersonalized = async () => {
    starts++
  }
  f.connect('control', ['playback:write'])
  f.connect('provider', ['providers:call'])
  f.connect('authorized', ['playback:write', 'providers:call'])
  for (const id of ['control', 'provider']) {
    const result = await f.request(id, 'personalized.start', { providerId: 'ncm', key: 'fm' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.equal(starts, 0)
  assert.equal(
    (
      await f.request('authorized', 'personalized.start', {
        providerId: 'ncm',
        key: 'radar',
        play: false
      })
    ).ok,
    true
  )
  assert.equal(starts, 1)
})

test('liked and heart operations require playback control and provider permission together', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('control', ['playback:write'])
  f.connect('provider', ['providers:call'])
  f.connect('authorized', ['playback:write', 'providers:call'])
  for (const [name, payload] of [
    ['liked.play', { play: false }],
    ['heart.refill', { id: 'q', revision: 1 }],
    ['playback.mode', { mode: 'heart' }]
  ] as const) {
    for (const id of ['control', 'provider']) {
      const result = await f.request(id, name, payload)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN')
    }
    assert.equal((await f.request('authorized', name, payload)).ok, true)
  }
})

test('unified search needs provider permission; local-only search stays usable with library read access', async (t) => {
  const scopes: unknown[] = []
  const f = fixture(t, true, undefined, {
    collections: async (query) => {
      scopes.push(query.scope)
      return { items: [], total: 0, offset: 0, hasMore: false }
    },
    page: async (query) => {
      scopes.push(query.scope)
      return { items: [], logicalItems: [], health: {}, total: 0, versionsRevision: 0 }
    },
    shutdown: async () => {}
  })
  await f.application.initialize()
  f.connect('local', ['library:read'])
  f.connect('providers', ['providers:call'])
  f.connect('both', ['library:read', 'providers:call'])
  for (const name of ['search.songs', 'search.collections']) {
    const payload = { query: 'Moon', ...(name === 'search.collections' ? { kind: 'albums' } : {}) }
    for (const id of ['local', 'providers']) {
      const result = await f.request(id, name, payload)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN')
    }
    assert.equal((await f.request('local', name, { ...payload, scope: 'local' })).ok, true)
    assert.equal((await f.request('both', name, payload)).ok, true)
  }
  assert.deepEqual(scopes, ['local', undefined, 'local', undefined])
})

test('a slow search is cancelled on disconnect while another client pauses independently', async (t) => {
  let started!: () => void,
    cancelled = false
  const entered = new Promise<void>((resolve) => (started = resolve))
  const f = fixture(t, true, undefined, {
    collections: async () => ({ items: [], total: 0, offset: 0, hasMore: false }),
    page: async (_query, signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal!.addEventListener(
          'abort',
          () => {
            cancelled = true
            reject(signal!.reason)
          },
          { once: true }
        )
      }),
    shutdown: async () => {}
  })
  await f.application.initialize()
  f.connect('search', ['library:read', 'providers:call'])
  f.connect('mini', ['playback:write'])
  const search = f.request('search', 'search.songs', { query: 'Slow' })
  await entered
  assert.equal((await f.request('mini', 'playback.pause')).ok, true)
  f.application.disconnect('search')
  await search
  assert.equal(cancelled, true)
  assert.equal(f.calls.filter((call) => call === 'pause').length, 1)
  assert.equal(f.messages.get('search')!.filter((message) => message.kind === 'response').length, 0)
})
