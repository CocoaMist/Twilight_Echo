import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test, { type TestContext } from 'node:test'
import ts from 'typescript'
import { computed, nextTick, ref, watch } from 'vue'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import type { LibraryCollectionSummary, LibraryQuery } from '../../../shared/libraryDatabase.ts'
import type { Track } from '../types/music.ts'
import { createLibraryDashboard } from '../stores/library/libraryDashboard.ts'
import {
  createUnifiedRecentTrackResolver,
  type UnifiedRecentStat
} from '../utils/unifiedRecentTracks.ts'
import { getTrackSource } from '../utils/trackSourceIdentity.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(t: TestContext, mode: 'json' | 'sqlite' = 'sqlite', preview = false) {
  const db = new LibraryDatabase(':memory:')
  const tracks: Track[] = Array.from({ length: 405 }, (_, i) => ({
    id: `track:${i}`,
    title: `Song ${i}`,
    artist: `Artist ${i % 3}`,
    album: `Album ${i % 7}`,
    filePath: `D:/Music/${i}.flac`,
    fileName: `${i}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    trackNumber: 405 - i,
    source: 'local'
  }))
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  const top = ref<UnifiedRecentStat[]>([]),
    latest = ref<UnifiedRecentStat[]>([])
  const current = ref<Track | null>(null),
    version = ref(0)
  let fail = false,
    callback: ((change: { kind: 'database'; revision: number }) => void) | undefined
  let subscribed = 0,
    removed = 0,
    sqlCalls = 0
  let held = false,
    lookups = 0
  const releases: Array<() => void> = []
  const queries: Array<{ query: LibraryQuery; selected?: string; options?: unknown }> = []
  const arrays: Array<{ track: Track; ids: string[] }> = []
  const queues: ReturnType<typeof db.createLibraryQueue>[] = []
  const modes: string[] = []
  const player = {
    currentTrack: current,
    isPlaying: ref(false),
    playTrack: (track: Track, items: Track[]) =>
      arrays.push({ track, ids: items.map((item) => item.id) }),
    playLibraryQuery: async (query: LibraryQuery, selected?: string, options?: unknown) => {
      queries.push({ query, selected, options })
      queues.push(db.createLibraryQueue(query, selected))
    },
    setPlayMode: (value: string) => modes.push(value),
    togglePlay() {},
    next() {},
    prev() {}
  }
  const mounts: Array<() => void> = [],
    unmounts: Array<() => void> = [],
    stops: Array<() => void> = []
  const forbidden = {
    get value(): never {
      throw new Error('full renderer library access')
    }
  }
  const database = Object.fromEntries(
    [
      'queryTracks',
      'queryCollections',
      'getTracksByIds',
      'getMetadata',
      'lookupPlaylistTracks'
    ].map((method) => [
      method,
      async (...args: unknown[]) => {
        sqlCalls++
        if (method === 'getTracksByIds') {
          lookups++
          if (held)
            await new Promise<void>((resolve) => {
              releases.push(resolve)
            })
        }
        if (fail) throw new Error('database offline')
        return (db[method as keyof LibraryDatabase] as (...args: unknown[]) => unknown).apply(
          db,
          args
        )
      }
    ])
  )
  const source = readFileSync(new URL('./LocalDashboard.vue', import.meta.url), 'utf8')
  const script = source
    .match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
    .split('// ---------- Listening calendar ----------')[0]
  const ast = ts.createSourceFile('dashboard.ts', script, ts.ScriptTarget.Latest, true)
  const code = ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
  const entry = runInNewContext(
    ts.transpileModule(
      code +
        `\n({dashboard, dashboardTrackCount, dashboardAlbumCount, dashboardArtistCount,
    databaseDashboard, dashboardError, dashboardReadPending, hasLibrary, heroTrack, recentlyAdded, albumShelf, totalDuration,
    rankedStats, lastPlayedTrack, playDashboardTrack, shuffleAll, playAlbum, retryDashboard})`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
      }
    ).outputText,
    {
      computed,
      ref,
      Error,
      watch: (...args: Parameters<typeof watch>) => {
        const stop = watch(...args)
        stops.push(stop)
        return stop
      },
      onMounted: (mount: () => void) => mounts.push(mount),
      onBeforeUnmount: (unmount: () => void) => unmounts.push(unmount),
      defineProps: () => (preview ? { previewTracks: tracks.slice(0, 3) } : {}),
      defineEmits: () => () => {},
      useMusicStore: () =>
        mode === 'sqlite'
          ? { tracks: forbidden, albums: forbidden, artists: forbidden }
          : { tracks: ref(tracks), albums: ref([]), artists: ref([]) },
      useListeningStatsStore: () => ({ listeningStats: ref({ days: {} }) }),
      usePlayerStore: () => player,
      useAudioOutputDspStore: () => ({
        audioProcessing: ref({}),
        playbackInfo: ref(null),
        outputInfo: ref(null)
      }),
      storeToRefs: (store: unknown) => store,
      getMostListenedTracks: () => top.value,
      getRecentTracks: () => latest.value,
      waitForListeningStatsReady: async () => {},
      musicVersionRevision: version,
      getMusicVersions: () => ({ tracks: { versions: [] } }),
      createLibraryDashboard,
      createUnifiedRecentTrackResolver,
      getTrackSource,
      resolveTimeGreeting: () => '你好',
      refreshDspRouteState: async () => {},
      refreshDspGraphStatus: async () => {},
      refreshDspSceneState: async () => {},
      dspRoutePoll: null,
      dspRouteDialogOpen: ref(false),
      dspRouteDirty: false,
      dspRoutePollTick: 0,
      window: {
        setInterval: () => 1,
        clearInterval() {},
        api: {
          library: {
            getStorageMode: async () => mode,
            onChanged: (listener: typeof callback) => {
              subscribed++
              callback = listener
              return () => {
                removed++
              }
            },
            database
          }
        }
      }
    }
  ) as {
    dashboard: ReturnType<typeof createLibraryDashboard>
    dashboardTrackCount: { value: number }
    dashboardAlbumCount: { value: number }
    dashboardArtistCount: { value: number }
    databaseDashboard: { value: boolean }
    dashboardError: { value: string }
    dashboardReadPending: { value: boolean }
    hasLibrary: { value: boolean }
    heroTrack: { value: Track | null }
    recentlyAdded: { value: Track[] }
    albumShelf: { value: LibraryCollectionSummary[] }
    totalDuration: { value: { value: string; unit: string } }
    rankedStats: { value: Array<{ track: Track | null }> }
    lastPlayedTrack: { value: Track | null }
    playDashboardTrack(track: Track): void
    shuffleAll(): void
    playAlbum(album: LibraryCollectionSummary): void
    retryDashboard(): void
  }
  async function settled() {
    await nextTick()
    for (
      let i = 0;
      i < 100 && (entry.dashboard.requests.active || entry.dashboard.requests.pending);
      i++
    )
      await tick()
    assert.equal(entry.dashboard.requests.active, 0)
    assert.equal(entry.dashboard.requests.pending, 0)
  }
  let mounted = false,
    closed = false
  function unmount() {
    if (closed) return
    closed = true
    for (const hook of unmounts) hook()
    for (const stop of stops) stop()
  }
  t.after(() => {
    unmount()
    db.close()
  })
  return {
    entry,
    db,
    tracks,
    queries,
    queues,
    arrays,
    modes,
    top,
    latest,
    current,
    settled,
    mount: () => {
      assert.equal(mounted, false)
      mounted = true
      for (const hook of mounts) hook()
    },
    change: () => callback?.({ kind: 'database', revision: db.getMetadata().revision }),
    fail: (value: boolean) => {
      fail = value
    },
    unmount,
    holdLookups: (value: boolean) => {
      held = value
    },
    releaseLookup: () => {
      assert.ok(releases.length)
      releases.shift()!()
    },
    get lookups() {
      return lookups
    },
    get sqlCalls() {
      return sqlCalls
    },
    get subscribed() {
      return subscribed
    },
    get removed() {
      return removed
    }
  }
}

test('production home uses SQL totals, bounded shelves and full-library/album playback with no renderer tracks', async (t) => {
  const f = fixture(t),
    e = f.entry
  assert.equal(e.dashboardReadPending.value, true)
  assert.equal(e.databaseDashboard.value, true)
  f.mount()
  await f.settled()
  assert.equal(e.dashboardError.value, '')
  assert.equal(e.dashboardTrackCount.value, 405)
  assert.equal(e.dashboardAlbumCount.value, 7)
  assert.equal(e.dashboardArtistCount.value, 3)
  assert.equal(e.totalDuration.value.value, '20.3')
  assert.equal(e.hasLibrary.value, true)
  assert.equal(e.heroTrack.value?.id, 'track:0')
  assert.deepEqual(
    Array.from(e.recentlyAdded.value, (track) => track.id),
    f.tracks
      .slice(-6)
      .reverse()
      .map((track) => track.id)
  )
  assert.equal(e.albumShelf.value.length, 5)
  assert.ok(e.albumShelf.value.every((album) => !('tracks' in album)))
  e.playDashboardTrack(e.recentlyAdded.value[0])
  await tick()
  assert.equal(f.queues[0].total, 405)
  assert.equal(f.queues[0].index, 404)
  assert.equal(f.db.readLibraryQueue(f.queues[0].id, 0, 1).items[0].track?.id, 'track:0')
  assert.equal(f.queries[0].query.contentRevision, f.db.getMetadata().revision)
  e.shuffleAll()
  assert.equal(f.queues[1].total, 405)
  assert.deepEqual(JSON.parse(JSON.stringify(f.queries[1].options)), {
    randomStart: true,
    playMode: 'shuffle'
  })
  e.playAlbum(e.albumShelf.value[0])
  const album = f.db.readLibraryQueue(f.queues[2].id)
  assert.equal(album.total, e.albumShelf.value[0].trackCount)
  assert.deepEqual(
    album.items.map((item) => item.track?.id),
    f.tracks
      .filter((track) => track.album === e.albumShelf.value[0].name)
      .reverse()
      .map((track) => track.id)
  )
  assert.equal(f.arrays.length, 0)
  assert.equal(f.subscribed, 1)

  f.latest.value = [
    {
      id: 'recent',
      sourceIds: [{ trackId: 'track:400', source: 'local' }],
      track: f.tracks[400],
      title: 'Recent',
      artist: 'Artist',
      cover: null,
      seconds: 100,
      plays: 1,
      lastPlayed: 100,
      skips: 0,
      completions: 0
    }
  ]
  await f.settled()
  assert.equal(e.lastPlayedTrack.value?.id, 'track:400')
  assert.equal(e.heroTrack.value?.id, 'track:400')
  const remote = { ...f.tracks[0], id: 'ncm:1', source: 'ncm' as const, ncmSongId: 1 }
  e.playDashboardTrack(remote)
  assert.deepEqual(Array.from(f.arrays[0].ids), ['ncm:1'])
  f.current.value = remote
  assert.equal(e.heroTrack.value?.id, 'ncm:1')
  e.playDashboardTrack({ ...f.tracks[0], id: 'missing-local' })
  await tick()
  assert.deepEqual(
    Array.from(f.arrays[1].ids),
    ['missing-local'],
    'only confirmed missing local snapshots retain singleton playback'
  )
  f.fail(true)
  e.playDashboardTrack(f.tracks[400])
  await tick()
  assert.equal(e.dashboardError.value, 'database offline')
  assert.equal(f.arrays.length, 2, 'database errors cannot fall back to a snapshot')
  f.fail(false)

  f.db.patchTracks([{ id: 'track:0', expectedVersion: 1, patch: { duration: 3600 } }])
  f.change()
  await f.settled()
  assert.equal(e.totalDuration.value.value, '21.2')
  f.unmount()
  const calls = f.sqlCalls
  f.top.value = f.latest.value
  await f.settled()
  assert.equal(f.sqlCalls, calls)
  assert.equal(f.removed, 1)
})

test('home playback checks are serialized and only the latest click can replace the queue', async (t) => {
  const f = fixture(t)
  f.mount()
  await f.settled()
  f.holdLookups(true)
  f.entry.playDashboardTrack(f.tracks[0])
  for (let i = 0; i < 500; i++) f.entry.playDashboardTrack(f.tracks[404])
  assert.equal(f.lookups, 1)
  assert.equal(f.queues.length, 0)
  f.holdLookups(false)
  f.releaseLookup()
  await tick()
  assert.equal(f.lookups, 2)
  assert.equal(f.queues.length, 1)
  assert.equal(f.queues[0].index, 404)
  f.holdLookups(true)
  f.entry.playDashboardTrack(f.tracks[0])
  f.entry.shuffleAll()
  f.releaseLookup()
  await tick()
  assert.equal(f.queues.length, 2, 'shuffle supersedes the pending local click')
  f.entry.playDashboardTrack(f.tracks[0])
  f.current.value = f.tracks[20]
  f.releaseLookup()
  await tick()
  assert.equal(f.queues.length, 2, 'playback selected elsewhere supersedes the pending home click')
  f.entry.playDashboardTrack(f.tracks[0])
  f.unmount()
  f.releaseLookup()
  await tick()
  assert.equal(f.queues.length, 2)
  assert.equal(f.arrays.length, 0)
})

test('home database failure remains visible and retryable without using compatibility tracks', async (t) => {
  const f = fixture(t)
  f.fail(true)
  f.mount()
  await f.settled()
  assert.equal(f.entry.dashboardError.value, 'database offline')
  assert.equal(f.entry.hasLibrary.value, false)
  f.fail(false)
  f.entry.retryDashboard()
  await f.settled()
  assert.equal(f.entry.dashboardError.value, '')
  assert.equal(f.entry.hasLibrary.value, true)
})

test('explicit JSON and previews retain the bounded array playback entry', async (t) => {
  const f = fixture(t, 'json')
  f.mount()
  await f.settled()
  assert.equal(f.entry.databaseDashboard.value, false)
  assert.equal(f.entry.dashboardTrackCount.value, 405)
  f.entry.playDashboardTrack(f.tracks[404])
  assert.equal(f.arrays[0].ids.length, 200)
  assert.equal(f.arrays[0].ids.at(-1), 'track:404')
  f.entry.shuffleAll()
  assert.deepEqual(f.modes, ['shuffle'])
  assert.equal(f.sqlCalls, 0)
  const p = fixture(t, 'sqlite', true)
  p.mount()
  await p.settled()
  assert.equal(p.entry.databaseDashboard.value, false)
  assert.equal(p.entry.dashboardTrackCount.value, 3)
  p.entry.playDashboardTrack(p.entry.heroTrack.value!)
  assert.equal(p.arrays[0].ids.length, 3)
  assert.equal(p.sqlCalls, 0)
  assert.equal(p.subscribed, 0)
})
