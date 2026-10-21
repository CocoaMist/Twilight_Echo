import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test, { type TestContext } from 'node:test'
import ts from 'typescript'
import { computed, nextTick, ref, watch } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import type { RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import { createLibraryRecentTracks } from '../../stores/library/libraryRecentTracks.ts'
import { getTrackSource, versionSourceKey } from '../../utils/trackSourceIdentity.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
import type { Track } from '../../types/music.ts'

type Source = ReturnType<typeof createLibraryRecentTracks>
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function script(path: URL, sfc = false) {
  let source = readFileSync(path, 'utf8')
  if (sfc) source = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('online.ts', source, ts.ScriptTarget.Latest, true)
  return ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
    .replace(/^export /gm, '')
}
function evaluate(source: string, globals: object) {
  return runInNewContext(
    ts.transpileModule(source, {
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
    track,
    seconds: 5,
    plays: 1,
    lastPlayed: 1,
    skips: 0,
    completions: 0,
    cover: null,
    sourceIds: [{ source: getTrackSource(track), trackId: track.id }]
  }
}
function fixture(t: TestContext, mode: 'json' | 'sqlite' = 'sqlite', discoveryFailure = false) {
  const db = new LibraryDatabase(':memory:')
  const records: Track[] = Array.from({ length: 605 }, (_, i) => ({
    id: `track:${i}`,
    filePath: `D:/Music/${i}.flac`,
    fileName: `${i}.flac`,
    title: `Song ${i}`,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: 'heavy lyrics must not enter matching identities',
    source: 'local'
  }))
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: records })
  const stats = ref<UnifiedRecentStat[]>([]),
    currentTrack = ref<Track | null>(null),
    isPlaying = ref(false),
    preferenceRevision = ref(0),
    versions = ref<RecordingVersion[]>([])
  let source!: Source,
    callback: ((change: { kind: 'database'; revision: number }) => void) | undefined,
    intercept: ((method: string) => Promise<void>) | undefined,
    active = 0,
    maximum = 0,
    calls = 0,
    removed = 0,
    failReads = false,
    failHydration = false,
    recommendationsReloaded = 0,
    gateLogin: (() => Promise<void>) | undefined
  const historyLimits: number[] = [],
    events: unknown[][] = [],
    plays: Array<{ track: Track; queue: Track[] }> = [],
    mounts: Array<() => void> = [],
    unmounts: Array<() => void> = [],
    stops: Array<() => void> = []
  const database = Object.fromEntries(
    ['getMetadata', 'getTracksByIds', 'lookupPlaylistTracks'].map((method) => [
      method,
      async (...args: unknown[]) => {
        calls++
        active++
        maximum = Math.max(maximum, active)
        try {
          const operation =
            method === 'getTracksByIds' && (args[0] as string[]).length === 0
              ? 'versionProbe'
              : method
          await intercept?.(operation)
          assert.notEqual(
            method,
            'getMetadata',
            'history must not transfer complete exclusions/configuration'
          )
          if (failReads) throw new Error('database offline')
          if (method === 'getTracksByIds') assert.ok((args[0] as string[]).length <= 30)
          if (method === 'lookupPlaylistTracks') {
            const request = args[0] as Parameters<typeof db.lookupPlaylistTracks>[0]
            assert.ok(request.entries.length <= 30)
            assert.ok(request.entries.every((entry) => !('lyrics' in (entry.snapshot ?? {}))))
          }
          return (db[method as keyof LibraryDatabase] as (...args: unknown[]) => unknown).apply(
            db,
            args
          )
        } finally {
          active--
        }
      }
    ])
  ) as unknown as LibraryDatabaseApi
  const provider = ref({ id: 'ncm', capabilities: ['login'] }),
    recommendations = ref<Track[]>([
      { ...records[0], id: 'ncm:9', title: 'Recommended', source: 'ncm', filePath: '' }
    ])
  const globals = {
    computed,
    ref,
    watch: (...args: Parameters<typeof watch>) => {
      const stop = watch(...args)
      stops.push(stop)
      return stop
    },
    onMounted: (mount: () => void) => mounts.push(mount),
    onBeforeUnmount: (unmount: () => void) => unmounts.push(unmount),
    useMusicStore: () => ({
      tracks:
        mode === 'json' && !discoveryFailure
          ? ref(records)
          : {
              get value(): never {
                throw new Error('full renderer library access')
              }
            }
    }),
    getRecentTracks: (count: number) => {
      historyLimits.push(count)
      return stats.value.slice(0, count)
    },
    waitForListeningStatsReady: async () => {
      if (failHydration) throw new Error('history hydration failed')
    },
    getMusicVersions: () => ({ tracks: { versions: versions.value } }),
    musicVersionRevision: preferenceRevision,
    createLibraryRecentTracks: (options: Parameters<typeof createLibraryRecentTracks>[0]) => {
      source = createLibraryRecentTracks(options)
      return source
    },
    usePlayerStore: () => ({
      currentTrack,
      isPlaying,
      playTrack(track: Track, queue: Track[]) {
        plays.push({ track, queue })
        currentTrack.value = track
        isPlaying.value = true
      },
      togglePlay() {
        isPlaying.value = !isPlaying.value
      }
    }),
    useSettingsStore: () => ({ settings: ref({}), updateSettings: async () => {} }),
    useProviderStore: () => ({
      providers: ref([provider.value]),
      getProvider: (id: string) => (id === 'ncm' ? provider.value : null),
      checkLogin: async () => {
        await gateLogin?.()
        return { loggedIn: true }
      },
      callProvider: async () => [],
      fetchPlaylistTracks: async () => recommendations.value
    }),
    useOnlineHome: () => ({
      providers: ref([provider.value]),
      provider,
      loading: ref(false),
      loggedIn: ref(true),
      error: ref(''),
      tracks: recommendations,
      playlists: ref([]),
      sectionTitle: ref('Recommendations'),
      playlistTitle: ref('Playlists'),
      reload: async () => {
        recommendationsReloaded++
      }
    }),
    getTrackSource,
    friendlyStreamingError: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    defineEmits:
      () =>
      (...event: unknown[]) =>
        events.push(event),
    window: {
      api: {
        library: {
          getStorageMode: async () => {
            if (discoveryFailure) throw new Error('storage discovery failed')
            return mode
          },
          database,
          onChanged: (listener: typeof callback) => {
            callback = listener
            return () => {
              removed++
            }
          }
        }
      }
    }
  }
  const useLibraryRecentTracks = evaluate(
    script(new URL('../../composables/useLibraryRecentTracks.ts', import.meta.url)) +
      '\nuseLibraryRecentTracks',
    globals
  )
  const entry = evaluate(
    script(new URL('./OnlineDashboard.vue', import.meta.url), true) +
      '\n({recent,recentState,recentError,hero,actionError,play,playHero,playPlaylist,reload,retryRecent})',
    { ...globals, useLibraryRecentTracks }
  ) as {
    recent: { value: Track[] }
    recentState: Source['state']
    recentError: { value: string }
    hero: { value: Track | null }
    actionError: { value: string }
    play(track: Track, queue: Track[]): Promise<void>
    playHero(): void
    playPlaylist(playlist: { id: string }): Promise<void>
    reload(): void
    retryRecent(): void
  }
  const close = () => {
    unmounts.splice(0).forEach((fn) => fn())
    stops.splice(0).forEach((fn) => fn())
  }
  t.after(() => {
    close()
    db.close()
  })
  return {
    db,
    records,
    stats,
    currentTrack,
    isPlaying,
    versions,
    preferenceRevision,
    entry,
    plays,
    events,
    recommendations,
    get source() {
      return source
    },
    mount() {
      mounts.splice(0).forEach((fn) => fn())
    },
    close,
    notify() {
      callback?.({ kind: 'database', revision: db.getMetadata().revision })
    },
    intercept(value?: typeof intercept) {
      intercept = value
    },
    loginGate(value?: typeof gateLogin) {
      gateLogin = value
    },
    fail(value: boolean) {
      failReads = value
    },
    failHistory(value: boolean) {
      failHydration = value
    },
    get calls() {
      return calls
    },
    get maximum() {
      return maximum
    },
    get removed() {
      return removed
    },
    get recommendationReloads() {
      return recommendationsReloaded
    },
    historyLimits
  }
}
async function settled(f: ReturnType<typeof fixture>) {
  await nextTick()
  for (let i = 0; i < 150 && Object.values(f.source.requests).some(Boolean); i++) await tick()
  assert.ok(Object.values(f.source.requests).every((value) => value === 0))
}

test('production online home resolves thirty bounded histories into six deduplicated records without full renderer arrays', async (t) => {
  const f = fixture(t)
  assert.equal(f.entry.recent.value.length, 0)
  f.stats.value = f.records
    .slice(-40)
    .reverse()
    .map((track) => stat(track))
  f.stats.value.splice(1, 0, stat(f.records[604], 'same-recording'))
  f.mount()
  await settled(f)
  assert.equal(f.entry.recentError.value, '')
  assert.deepEqual(
    f.entry.recent.value.map((track) => track.id),
    ['track:604', 'track:603', 'track:602', 'track:601', 'track:600', 'track:599']
  )
  assert.ok(f.historyLimits.every((limit) => limit === 30))
  const queue = f.entry.recent.value
  await f.entry.play(queue[0], queue)
  assert.equal(f.plays.length, 1)
  assert.deepEqual(
    f.plays[0].queue.map((track) => track.id),
    queue.map((track) => track.id),
    'online history intentionally keeps its small mixed queue'
  )
  f.close()
  assert.equal(f.removed, 1)
})

test('online history resolves unloaded preferred CUE sources, excludes deleted local snapshots and retains remote history', async (t) => {
  const f = fixture(t)
  const cue = { ...f.records[604], subTrack: 'cue:2', cueRange: { startSeconds: 2, endSeconds: 5 } }
  f.db.patchTracks([
    { id: cue.id, expectedVersion: 1, patch: { subTrack: cue.subTrack, cueRange: cue.cueRange } }
  ])
  const remote = { ...f.records[1], id: 'ncm:7', source: 'ncm', filePath: '', title: 'Other title' }
  f.versions.value = [
    {
      id: 'explicit',
      sources: [versionSourceKey(remote), versionSourceKey(cue)],
      preferredSource: versionSourceKey(cue)
    }
  ]
  const missing = { ...f.records[0], id: 'missing', title: 'Missing', artist: 'Not in library' }
  const fallback = { ...remote, id: 'ncm:8', title: 'Remote only' }
  f.stats.value = [stat(remote), stat(missing), stat(fallback)]
  f.mount()
  await settled(f)
  assert.equal(f.entry.recentError.value, '')
  assert.deepEqual(
    f.entry.recent.value.map((track) => track.id),
    ['track:604', 'ncm:8']
  )
  assert.deepEqual(f.entry.recent.value[0].cueRange, cue.cueRange)
  await f.entry.play(f.entry.recent.value[1], f.entry.recent.value)
  assert.equal(f.plays[0].track.id, 'ncm:8')
})

test('content/history/preference invalidation rejects stale recent clicks and refreshes only the history section', async (t) => {
  const f = fixture(t)
  f.stats.value = [stat(f.records[604])]
  f.mount()
  await settled(f)
  const rows = f.entry.recent.value
  f.db.patchTracks([{ id: 'track:604', expectedVersion: 1, patch: { title: 'New title' } }])
  await f.entry.play(rows[0], rows)
  assert.equal(f.plays.length, 0)
  assert.match(f.entry.recentError.value, /更新/)
  f.entry.retryRecent()
  await settled(f)
  assert.equal(f.entry.recent.value[0].title, 'New title')
  assert.equal(f.recommendationReloads, 0)
  const older = f.entry.recent.value
  f.preferenceRevision.value++
  await settled(f)
  await f.entry.play(older[0], older)
  assert.equal(f.plays.length, 0)
  f.entry.retryRecent()
  await settled(f)
  f.stats.value = [stat(f.records[603])]
  await settled(f)
  assert.equal(f.entry.recent.value[0].id, 'track:603')
  await f.entry.play(f.entry.recent.value[0], f.entry.recent.value)
  assert.equal(f.plays[0].track.id, 'track:603')
})

test('recent read storms and rapid playback confirmations keep one active and one latest demand per lane', async (t) => {
  const f = fixture(t)
  f.stats.value = [stat(f.records[604])]
  f.mount()
  await settled(f)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.intercept(async (method) => {
    if (method === 'versionProbe') await gate
  })
  const rows = f.entry.recent.value,
    snapshot = f.source.capture(rows)!
  const confirmations = Array.from({ length: 500 }, () => f.source.confirm(snapshot))
  for (let i = 0; i < 500; i++) f.source.refresh()
  assert.deepEqual(f.source.requests, {
    active: 1,
    pending: 1,
    confirming: 1,
    pendingConfirmation: 1
  })
  release()
  f.intercept()
  const outcomes = await Promise.allSettled(confirmations)
  await settled(f)
  assert.equal(
    outcomes.filter((result) => result.status === 'fulfilled' && result.value === false).length,
    498
  )
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 2)
  assert.ok(f.maximum <= 2)
  const calls = f.calls
  for (let i = 0; i < 500; i++) f.notify()
  await settled(f)
  assert.equal(f.calls, calls, 'same-version scan notices do not reread history')
})

test('storage/read/hydration errors stay in history, do not read compatibility arrays, and remain retryable', async (t) => {
  const unknown = fixture(t, 'sqlite', true)
  unknown.mount()
  await settled(unknown)
  assert.match(unknown.entry.recentError.value, /discovery/)
  assert.equal(unknown.calls, 0)
  assert.equal(unknown.entry.recent.value.length, 0)
  const f = fixture(t)
  f.fail(true)
  f.mount()
  await settled(f)
  assert.match(f.entry.recentError.value, /database offline/)
  await f.entry.play(f.recommendations.value[0], f.recommendations.value)
  assert.equal(f.plays.length, 1, 'history failure does not disable provider recommendations')
  f.fail(false)
  f.failHistory(true)
  f.entry.retryRecent()
  await settled(f)
  assert.match(f.entry.recentError.value, /hydration/)
  f.failHistory(false)
  f.entry.retryRecent()
  await settled(f)
  assert.equal(f.entry.recentError.value, '')
  assert.equal(f.recommendationReloads, 0)
})

test('unmount and external playback changes prevent delayed history confirmation or provider login from stealing playback', async (t) => {
  const f = fixture(t)
  f.stats.value = [stat(f.records[604])]
  f.mount()
  await settled(f)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.intercept(async (method) => {
    if (method === 'versionProbe') await gate
  })
  const play = f.entry.play(f.entry.recent.value[0], f.entry.recent.value)
  await tick()
  f.currentTrack.value = f.records[0]
  release()
  await play
  await settled(f)
  assert.equal(f.plays.length, 0)
  let login!: () => void
  f.loginGate(
    () =>
      new Promise<void>((resolve) => {
        login = resolve
      })
  )
  const providerPlay = f.entry.play(f.recommendations.value[0], f.recommendations.value)
  await tick()
  f.close()
  login()
  await providerPlay
  assert.equal(f.plays.length, 0)
  const calls = f.calls
  f.source.refresh()
  f.notify()
  await settled(f)
  assert.equal(f.calls, calls)
})

test('dispose settles active and pending confirmations before the outstanding read returns', async (t) => {
  const f = fixture(t)
  f.stats.value = [stat(f.records[604])]
  f.mount()
  await settled(f)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(() => release())
  f.intercept(async (method) => {
    if (method === 'versionProbe') await gate
  })
  const rows = f.entry.recent.value,
    snapshot = f.source.capture(rows)!,
    active = f.source.confirm(snapshot),
    pending = f.source.confirm(snapshot)
  let results: boolean[] | undefined
  const complete = Promise.all([active, pending]).then((values) => {
    results = values
  })
  await tick()
  assert.equal(f.source.requests.confirming, 1)
  assert.equal(f.source.requests.pendingConfirmation, 1)
  f.close()
  await tick()
  assert.deepEqual(results, [false, false], 'disposal does not wait for a stalled RPC')
  assert.equal(f.source.requests.confirming, 1, 'disposal does not free the live RPC slot')
  const calls = f.calls
  assert.equal(await f.source.confirm(snapshot), false)
  f.source.refresh()
  f.notify()
  release()
  await complete
  await settled(f)
  assert.equal(f.calls, calls)
  assert.equal(f.plays.length, 0)
})

test('JSON online history retains the legacy resolver and small array entry with no SQL reads', async (t) => {
  const f = fixture(t, 'json')
  f.stats.value = [stat(f.records[604])]
  f.mount()
  await settled(f)
  assert.equal(f.entry.recentError.value, '')
  assert.equal(f.entry.recent.value[0].id, 'track:604')
  assert.equal(f.calls, 0)
  await f.entry.play(f.entry.recent.value[0], f.entry.recent.value)
  assert.equal(f.plays[0].queue.length, 1)
  f.stats.value = [stat(f.records[603])]
  await nextTick()
  assert.equal(f.entry.recent.value[0].id, 'track:603')
  assert.equal(f.calls, 0)
})
