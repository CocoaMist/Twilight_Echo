import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test, { type TestContext } from 'node:test'
import ts from 'typescript'
import { computed, nextTick, onScopeDispose, ref } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseApi, LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import { buildDerivedCollections } from '../../stores/library/derivedCollections.ts'
import {
  createLibraryThemeDashboard,
  THEME_DASHBOARD_SHELVES,
  type LibraryDashboardTheme
} from '../../stores/library/libraryThemeDashboard.ts'
import { buildArchiveLibrary } from './archiveLibrary.ts'
import type { Track } from '../../types/music.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
type Controller = ReturnType<typeof createLibraryThemeDashboard>
type QueryPlayOptions = Parameters<
  Parameters<typeof createLibraryThemeDashboard>[0]['player']['playLibraryQuery']
>[2]

function scriptWithoutImports(path: URL, sfc = false) {
  const source = readFileSync(path, 'utf8')
  const script = sfc ? source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1] : source
  const ast = ts.createSourceFile('home.ts', script, ts.ScriptTarget.Latest, true)
  return ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
    .replace(/^export /gm, '')
}
function evaluate(code: string, globals: object) {
  return runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
    globals
  )
}
function stat(track: Track, id = track.id): UnifiedRecentStat {
  return {
    id,
    title: track.title,
    artist: track.artist,
    seconds: 100,
    plays: 1,
    lastPlayed: 123,
    skips: 0,
    completions: 1,
    cover: null,
    track,
    sourceIds: [{ source: track.source ?? 'local', trackId: track.id }]
  }
}

function fixture(
  t: TestContext,
  theme: LibraryDashboardTheme,
  mode: 'json' | 'sqlite' = 'sqlite',
  failDiscovery = false
) {
  const db = new LibraryDatabase(':memory:')
  const tracks: Track[] = Array.from({ length: 605 }, (_, i) => ({
    id: `track:${i}`,
    title: `Song ${i}`,
    artist: `Artist ${i % 3}`,
    album: `Album ${i % 11}`,
    filePath: `D:/Music/${i}.flac`,
    fileName: `${i}.flac`,
    duration: i % 11,
    size: 1,
    addedAt: i % 3 === 0 ? 100 : 0,
    cover: null,
    lyrics: null,
    source: 'local'
  }))
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  const collections = buildDerivedCollections(tracks, [], '')
  const history = ref<UnifiedRecentStat[]>([]),
    currentTrack = ref<Track | null>(null),
    isPlaying = ref(false),
    preferenceRevision = ref(0)
  const queries: Array<{ query: LibraryQuery; selected?: string; options?: QueryPlayOptions }> = [],
    queues: ReturnType<typeof db.createLibraryQueue>[] = [],
    arrays: Array<{ track: Track; ids: string[] }> = [],
    modes: string[] = [],
    events: unknown[][] = [],
    seeks: number[] = [],
    historyLimits: number[] = [],
    databaseQueries: LibraryQuery[] = []
  let reads = 0,
    maximum = 0,
    calls = 0,
    toggles = 0,
    removed = 0,
    hydrated = 0,
    failReads = false,
    change: ((change: { kind: 'database'; revision: number }) => void) | undefined,
    controller!: Controller
  const mounts: Array<() => void> = [],
    unmounts: Array<() => void> = []
  let intercept: ((method: string) => Promise<void>) | undefined
  const database = Object.fromEntries(
    [
      'queryTracks',
      'queryCollections',
      'getTracksByIds',
      'lookupPlaylistTracks',
      'getMetadata'
    ].map((method) => [
      method,
      async (...args: unknown[]) => {
        calls++
        reads++
        maximum = Math.max(maximum, reads)
        try {
          await intercept?.(method)
          if (failReads) throw new Error('database offline')
          if (method === 'queryTracks') databaseQueries.push(args[0] as LibraryQuery)
          if (method === 'getTracksByIds') assert.ok((args[0] as string[]).length <= 30)
          return (db[method as keyof LibraryDatabase] as (...args: unknown[]) => unknown).apply(
            db,
            args
          )
        } finally {
          reads--
        }
      }
    ])
  ) as unknown as LibraryDatabaseApi
  const forbidden = {
    get value(): never {
      throw new Error('full renderer library access')
    }
  }
  const player = {
    currentTrack,
    isPlaying,
    currentTime: ref(7),
    duration: ref(99),
    playTrack(track: Track, items: Track[]) {
      arrays.push({ track, ids: items.map((item) => item.id) })
    },
    async playLibraryQuery(query: LibraryQuery, selected?: string, options?: QueryPlayOptions) {
      queries.push({ query, selected, options })
      try {
        queues.push(db.createLibraryQueue(query, selected))
      } catch (error) {
        options?.onQueryFailure?.(error)
      }
    },
    setPlayMode(mode: string) {
      modes.push(mode)
    },
    togglePlay() {
      toggles++
    },
    seek(position: number) {
      seeks.push(position)
    },
    prev() {},
    next() {}
  }
  const globals = {
    computed,
    ref,
    onScopeDispose,
    onMounted: (mount: () => void) => mounts.push(mount),
    onBeforeUnmount: (unmount: () => void) => unmounts.push(unmount),
    useMusicStore: () =>
      mode === 'sqlite' || failDiscovery
        ? { tracks: forbidden, albums: forbidden, artists: forbidden }
        : {
            tracks: ref(tracks),
            albums: ref(collections.albums),
            artists: ref(collections.artists)
          },
    usePlayerStore: () => player,
    getRecentTracks: (count: number) => {
      historyLimits.push(count)
      return history.value.slice(0, count)
    },
    waitForListeningStatsReady: async () => {
      hydrated++
    },
    musicVersionRevision: preferenceRevision,
    getMusicVersions: () => ({ tracks: { versions: [] } }),
    THEME_DASHBOARD_SHELVES,
    createLibraryThemeDashboard: (options: Parameters<typeof createLibraryThemeDashboard>[0]) => {
      controller = createLibraryThemeDashboard(options)
      return controller
    },
    window: {
      api: {
        library: {
          getStorageMode: async () => {
            if (failDiscovery) throw new Error('discovery offline')
            return mode
          },
          database,
          onChanged: (listener: typeof change) => {
            change = listener
            return () => {
              removed++
            }
          }
        }
      }
    }
  }
  const useLibraryThemeDashboard = evaluate(
    scriptWithoutImports(
      new URL('../../composables/useLibraryThemeDashboard.ts', import.meta.url)
    ) + '\nuseLibraryThemeDashboard',
    globals
  )
  const name =
    theme === 'archive' ? 'Archive' : theme === 'nightHarbor' ? 'NightHarbor' : 'SoundField'
  const script = scriptWithoutImports(new URL(`./${name}Dashboard.vue`, import.meta.url), true)
  const entry = evaluate(
    script +
      `\n({ summary,recent,recentlyAdded,albumCards,play,shuffle,openAlbum,ready,loading,error,retry,${theme === 'soundField' ? 'hero:featured,heroIsCurrent:isCurrent,seek:seekFeatured' : `hero,heroIsCurrent${theme === 'nightHarbor' ? ',seek:seekHero' : ''}`} })`,
    {
      ...globals,
      useLibraryThemeDashboard,
      defineEmits:
        () =>
        (...event: unknown[]) =>
          events.push(event)
    }
  ) as Pick<
    Controller,
    | 'summary'
    | 'recent'
    | 'recentlyAdded'
    | 'hero'
    | 'heroIsCurrent'
    | 'albumCards'
    | 'play'
    | 'shuffle'
    | 'ready'
    | 'loading'
    | 'error'
    | 'retry'
  > & { openAlbum(index: number): void; seek?: (position: number) => void }
  const close = () => {
    unmounts.splice(0).forEach((unmount) => unmount())
  }
  t.after(() => {
    close()
    db.close()
  })
  return {
    db,
    tracks,
    collections,
    history,
    currentTrack,
    isPlaying,
    entry,
    get controller() {
      return controller
    },
    mount() {
      mounts.splice(0).forEach((mount) => mount())
    },
    close,
    notify() {
      change?.({ kind: 'database', revision: db.getMetadata().revision })
    },
    setFailure(value: boolean) {
      failReads = value
    },
    setIntercept(value?: typeof intercept) {
      intercept = value
    },
    preferenceRevision,
    queries,
    queues,
    arrays,
    modes,
    events,
    seeks,
    historyLimits,
    databaseQueries,
    get calls() {
      return calls
    },
    get maximum() {
      return maximum
    },
    get toggles() {
      return toggles
    },
    get removed() {
      return removed
    },
    get hydrated() {
      return hydrated
    }
  }
}
async function settled(f: ReturnType<typeof fixture>) {
  await nextTick()
  for (let i = 0; i < 150 && Object.values(f.controller.requests).some(Boolean); i++) await tick()
  assert.ok(
    Object.values(f.controller.requests).every((value) => value === 0),
    'home read lanes must settle'
  )
}

for (const theme of ['archive', 'nightHarbor', 'soundField'] as const)
  test(`${theme} production home reads complete SQL totals, stable newest activity and album identities without full arrays`, async (t) => {
    const f = fixture(t, theme)
    assert.equal(f.entry.ready.value, false)
    assert.equal(f.entry.summary.value.tracks, 0)
    assert.equal(f.entry.recent.value.length, 0)
    assert.equal(f.entry.albumCards.value.length, 0)
    f.history.value = f.tracks
      .slice(-40)
      .reverse()
      .map((track) => stat(track))
    f.mount()
    await settled(f)
    assert.equal(f.entry.error.value, '')
    assert.equal(f.entry.ready.value, true)
    assert.equal(f.entry.summary.value.tracks, 605)
    assert.equal(f.entry.summary.value.albums, f.collections.albums.length)
    assert.equal(f.entry.summary.value.artists, f.collections.artists.length)
    assert.equal(f.entry.summary.value.totalSeconds, buildArchiveLibrary(f.tracks).totalSeconds)
    assert.deepEqual(
      f.entry.recentlyAdded.value.map((track) => track.id),
      buildArchiveLibrary(f.tracks).recentlyAdded.map((track) => track.id)
    )
    const profile = THEME_DASHBOARD_SHELVES[theme]
    assert.equal(f.entry.recent.value.length, profile.history)
    assert.ok(f.historyLimits.every((limit) => limit === profile.history))
    assert.deepEqual(
      f.entry.albumCards.value.map((album) => album.key),
      f.collections.albums.slice(0, profile.albums).map((album) => album.id)
    )
    assert.ok(f.databaseQueries.every((query) => query.limit! <= 30))
    f.entry.openAlbum(profile.albums - 1)
    assert.deepEqual(
      [...f.events[0]],
      ['select-view', 'albums', f.entry.albumCards.value.at(-1)!.key]
    )
    f.entry.play(f.entry.recent.value[0])
    await settled(f)
    assert.equal(f.arrays.length, 0)
    assert.equal(f.queues[0].total, 605)
    assert.equal(f.queues[0].index, 604)
    f.entry.shuffle()
    await settled(f)
    assert.equal(f.queues[1].total, 605)
    assert.equal(f.queries[1].options?.randomStart, true)
    assert.equal(f.queries[1].options?.playMode, 'shuffle')
    assert.equal(
      f.modes.length,
      0,
      'database playback applies shuffle with queue replacement, not the old array'
    )
    f.currentTrack.value = f.tracks[1]
    f.entry.play(f.tracks[1])
    assert.equal(f.toggles, 1)
    f.entry.seek?.(12)
    if (theme !== 'archive') assert.deepEqual(f.seeks, [12])
    assert.ok(f.maximum <= 2)
    f.close()
    assert.equal(f.removed, 1)
  })

test('themed activity resolves unloaded CUE sources, removes missing local snapshots and keeps remote snapshots playable', async (t) => {
  const f = fixture(t, 'soundField')
  f.db.patchTracks([
    {
      id: 'track:604',
      expectedVersion: 1,
      patch: { subTrack: 'cue:2', cueRange: { startSeconds: 2, endSeconds: 4 } }
    }
  ])
  const remote: Track = {
    ...f.tracks[0],
    id: 'ncm:7',
    title: 'Remote only',
    filePath: '',
    source: 'ncm'
  }
  const missing: Track = {
    ...f.tracks[0],
    id: 'missing',
    title: 'Deleted title',
    artist: 'Deleted artist'
  }
  f.history.value = [stat(f.tracks[604], 'logical-cue'), stat(missing), stat(remote)]
  f.mount()
  await settled(f)
  assert.equal(f.entry.error.value, '')
  assert.deepEqual(
    f.entry.recent.value.map((track) => track.id),
    ['track:604', 'ncm:7']
  )
  assert.deepEqual(f.entry.recent.value[0].cueRange, { startSeconds: 2, endSeconds: 4 })
  f.entry.play(remote)
  await settled(f)
  assert.deepEqual(f.arrays[0].ids, ['ncm:7'])
  f.entry.play(missing)
  await settled(f)
  assert.match(f.entry.error.value, /不在曲库/)
  assert.equal(f.arrays.length, 1)
})

test('scan/history/preference updates coalesce and stale or failed lookups cannot replace a newer play intent', async (t) => {
  const f = fixture(t, 'nightHarbor')
  f.mount()
  await settled(f)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setIntercept(async (method) => {
    if (method === 'getTracksByIds') await gate
  })
  for (let i = 0; i < 500; i++) f.entry.play(f.tracks[i % 600])
  assert.equal(f.controller.requests.playback, 1)
  assert.equal(f.controller.requests.pendingPlayback, 1)
  f.db.patchTracks([{ id: 'track:0', expectedVersion: 1, patch: { title: 'Changed' } }])
  for (let i = 0; i < 100; i++) f.notify()
  f.preferenceRevision.value++
  await nextTick()
  release()
  f.setIntercept()
  await settled(f)
  assert.equal(f.arrays.length + f.queries.length, 0)
  assert.match(f.entry.error.value, /revision|变化/)
  assert.equal(f.entry.summary.value.tracks, 605)
  f.entry.retry()
  await settled(f)
  f.entry.play(f.tracks[604])
  await settled(f)
  assert.equal(f.queues[0].index, 604)
  const reads = f.calls
  f.history.value = [stat(f.tracks[603])]
  await settled(f)
  assert.equal(f.entry.recent.value[0].id, 'track:603')
  assert.ok(f.calls > reads)
  assert.ok(f.maximum <= 2)
})

test('discovery and SQL failures never fall back to compatibility arrays, and retry/unmount own their requests', async (t) => {
  const unknown = fixture(t, 'archive', 'sqlite', true)
  unknown.mount()
  await settled(unknown)
  assert.match(unknown.entry.error.value, /discovery offline/)
  assert.equal(unknown.calls, 0)
  assert.equal(unknown.entry.ready.value, false)
  assert.equal(unknown.entry.summary.value.tracks, 0)
  const f = fixture(t, 'archive')
  f.setFailure(true)
  f.mount()
  await settled(f)
  assert.match(f.entry.error.value, /database offline/)
  assert.equal(f.entry.ready.value, false)
  f.setFailure(false)
  f.entry.retry()
  await settled(f)
  assert.equal(f.entry.error.value, '')
  assert.equal(f.entry.summary.value.tracks, 605)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setIntercept(async (method) => {
    if (method === 'getTracksByIds') await gate
  })
  f.entry.play(f.tracks[604])
  f.close()
  release()
  await settled(f)
  assert.equal(f.queries.length + f.arrays.length, 0)
  const calls = f.calls
  f.entry.play(f.tracks[0])
  f.entry.shuffle()
  f.entry.retry()
  await settled(f)
  assert.equal(f.calls, calls)
})

for (const theme of ['archive', 'nightHarbor', 'soundField'] as const)
  test(`${theme} JSON home retains its album order, history size and bounded array playback`, async (t) => {
    const f = fixture(t, theme, 'json')
    f.history.value = [stat(f.tracks[604])]
    f.mount()
    await settled(f)
    assert.equal(f.calls, 0)
    assert.equal(f.entry.ready.value, true)
    assert.equal(f.entry.summary.value.tracks, 605)
    assert.equal(f.entry.recent.value[0].id, 'track:604')
    assert.deepEqual(
      f.entry.recentlyAdded.value.map((track) => track.id),
      buildArchiveLibrary(f.tracks).recentlyAdded.map((track) => track.id)
    )
    f.entry.play(f.tracks[604])
    assert.equal(f.arrays[0].ids.length, 200)
    assert.equal(f.arrays[0].track.id, 'track:604')
    assert.ok(f.arrays[0].ids.includes('track:604'))
    f.currentTrack.value = f.tracks[0]
    t.mock.method(Math, 'random', () => 0)
    f.entry.shuffle()
    assert.equal(
      f.arrays.length,
      2,
      'random selection of the current track still starts the array queue'
    )
    assert.equal(f.toggles, 0)
    assert.deepEqual(f.modes, ['shuffle'])
    assert.equal(f.queries.length, 0)
  })
