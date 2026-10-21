import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import { createLibraryDashboard, type LibraryDashboardState } from './libraryDashboard.ts'
import { buildDerivedCollections } from './derivedCollections.ts'
import {
  createUnifiedRecentTrackResolver,
  resetUnifiedRecentResolverCacheForTests,
  type UnifiedRecentStat
} from '../../utils/unifiedRecentTracks.ts'
import { loadMusicVersions } from '../musicVersions.ts'
import { versionSourceKey } from '../../utils/trackSourceIdentity.ts'
import type { Track } from '../../types/music.ts'
import type { RecordingVersion } from '../../../../shared/recordingIdentity.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settled(source: ReturnType<typeof createLibraryDashboard>) {
  for (let i = 0; i < 100 && (source.requests.active || source.requests.pending); i++) await tick()
  assert.equal(source.requests.active, 0)
  assert.equal(source.requests.pending, 0)
}
function track(id: string, patch: Partial<Track> = {}): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:/Music/${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: 'heavy lyrics',
    source: 'local',
    format: 'flac',
    ...patch
  }
}
function stat(id: string, snapshot: Track | undefined, sources: string[] = []): UnifiedRecentStat {
  return {
    id,
    title: snapshot?.title ?? 'Unknown',
    artist: snapshot?.artist ?? 'Unknown',
    sourceIds: sources.map((trackId) => ({ trackId, source: 'local' })),
    track: snapshot,
    seconds: 100,
    plays: 1,
    lastPlayed: 123,
    skips: 0,
    completions: 1,
    cover: null
  }
}
function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  const tracks = Array.from({ length: 405 }, (_, i) =>
    track(String(i), { album: `Album ${i % 7}`, artist: `Artist ${i % 3}`, duration: i % 11 })
  )
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  let active = 0,
    maximum = 0,
    history: UnifiedRecentStat[] = [],
    preferenceRevision = 0
  const counts: Record<string, number> = {}
  const api = Object.fromEntries(
    [
      'queryTracks',
      'queryCollections',
      'lookupPlaylistTracks',
      'getTracksByIds',
      'getMetadata'
    ].map((method) => [
      method,
      async (...args: unknown[]) => {
        counts[method] = (counts[method] ?? 0) + 1
        active++
        maximum = Math.max(maximum, active)
        try {
          await Promise.resolve()
          if (method === 'lookupPlaylistTracks') {
            const request = args[0] as Parameters<typeof db.lookupPlaylistTracks>[0]
            assert.ok(request.entries.length <= 7)
            for (const entry of request.entries)
              assert.equal('lyrics' in (entry.snapshot ?? {}), false)
          }
          if (method === 'getTracksByIds') assert.ok((args[0] as string[]).length <= 7)
          return (db[method as keyof LibraryDatabase] as (...args: unknown[]) => unknown).apply(
            db,
            args
          )
        } finally {
          active--
        }
      }
    ])
  ) as unknown as Pick<
    LibraryDatabaseApi,
    'queryTracks' | 'queryCollections' | 'lookupPlaylistTracks' | 'getTracksByIds' | 'getMetadata'
  >
  const options = {
    getStorageMode: async () => 'sqlite' as 'sqlite' | 'json',
    getHistory: () => history,
    getPreferences: () => ({ revision: preferenceRevision, versions: [] as RecordingVersion[] }),
    api
  }
  const source = createLibraryDashboard(options)
  t.after(() => {
    source.dispose()
    db.close()
  })
  return {
    db,
    tracks,
    options,
    api,
    source,
    counts,
    setHistory: (value: UnifiedRecentStat[]) => {
      history = value
    },
    changePreferences: () => {
      preferenceRevision++
    },
    get maximum() {
      return maximum
    }
  }
}

test('dashboard summaries match complete legacy totals and shelves without returning collection members', async (t) => {
  const f = fixture(t)
  f.setHistory([stat('unloaded', f.tracks[404], ['404'])])
  f.source.refresh(true)
  await settled(f.source)
  assert.equal(f.source.state.value.error, '')
  const data = f.source.state.value.data!
  const legacy = buildDerivedCollections(f.tracks, [], '')
  assert.equal(data.total, 405)
  assert.equal(
    data.duration,
    f.tracks.reduce((total, item) => total + item.duration, 0)
  )
  assert.equal(data.albumCount, legacy.albums.length)
  assert.equal(data.artistCount, legacy.artists.length)
  assert.deepEqual(
    data.first.map((item) => item.id),
    f.tracks.slice(0, 6).map((item) => item.id)
  )
  assert.deepEqual(
    data.recent.map((item) => item.id),
    f.tracks
      .slice(-6)
      .reverse()
      .map((item) => item.id)
  )
  assert.deepEqual(
    data.albums.map((item) => item.id),
    [...legacy.albums]
      .sort((a, b) => b.trackCount - a.trackCount)
      .slice(0, 5)
      .map((item) => item.id)
  )
  assert.ok(data.albums.every((item) => !('tracks' in item)))
  assert.equal(f.source.state.value.history.get('unloaded')?.id, '404')
  assert.equal(f.maximum, 1)
  f.source.refresh()
  await settled(f.source)
  assert.equal(f.counts.queryTracks, 2, 'history ticks reuse library shelves')
  assert.equal(f.counts.queryCollections, 2)
  assert.equal(f.counts.lookupPlaylistTracks, 2)
})

for (const count of [0, 1, 5])
  test(`dashboard handles ${count} records without wrapping the recent shelf`, async (t) => {
    const f = fixture(t)
    f.db.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: f.tracks.slice(0, count)
    })
    f.source.refresh(true)
    await settled(f.source)
    assert.equal(f.source.state.value.error, '')
    assert.equal(f.source.state.value.data?.total, count)
    assert.deepEqual(
      f.source.state.value.data?.recent.map((item) => item.id),
      f.tracks
        .slice(0, count)
        .reverse()
        .map((item) => item.id)
    )
  })

test('recent recording lookup matches the legacy resolver for ordered sources, recording groups and explicit version preferences', async (t) => {
  const f = fixture(t)
  const tracks = [
    track('compressed', { title: 'Recording', format: 'mp3', duration: 170 }),
    track('preferred', { title: 'Recording', duration: 176 }),
    track('long', { title: 'Recording', duration: 300 }),
    track('cue', {
      title: 'Other title',
      subTrack: 'cue:2',
      cueRange: { startSeconds: 2, endSeconds: 4, pregapSeconds: 0 }
    })
  ]
  f.db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  const remote = track('ncm:1', { title: 'Remote', source: 'ncm', ncmSongId: 1 })
  const versions: RecordingVersion[] = [
    {
      id: 'v',
      sources: [versionSourceKey(remote), versionSourceKey(tracks[3])],
      preferredSource: versionSourceKey(remote)
    }
  ]
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () =>
        JSON.stringify({
          version: 1,
          tracks: {
            versions: versions.map((version) => ({ ...version, label: version.id })),
            families: []
          },
          albums: { versions: [], families: [] }
        })
    }
  })
  loadMusicVersions()
  resetUnifiedRecentResolverCacheForTests()
  t.after(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null }
    })
    loadMusicVersions()
    resetUnifiedRecentResolverCacheForTests()
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const history = [
    stat('sources', tracks[2], ['missing', 'compressed', 'long']),
    stat('far-duration', track('gone', { title: 'Recording', duration: 999 })),
    stat('remote', remote),
    stat('missing-local', track('gone-local')),
    stat('empty', undefined),
    stat('exact-long', tracks[2], ['long'])
  ]
  f.options.getPreferences = () => ({ revision: 0, versions })
  f.setHistory(history)
  f.source.refresh(true)
  await settled(f.source)
  assert.equal(f.source.state.value.error, '')
  const resolver = createUnifiedRecentTrackResolver(tracks)
  for (const item of history)
    assert.equal(
      f.source.state.value.history.get(item.id)?.id ?? null,
      resolver(item)?.id ?? null,
      item.id
    )
  assert.equal(f.source.state.value.history.get('sources')?.id, 'preferred')
  assert.equal(f.source.state.value.history.get('far-duration')?.id, 'preferred')
  assert.equal(f.source.state.value.history.get('remote')?.id, 'cue')
  assert.equal(f.source.state.value.history.get('missing-local'), null)
})

for (const phase of ['library', 'history', 'final', 'preferences', 'incomplete'] as const)
  test(`dashboard rejects ${phase} inconsistencies instead of publishing mixed data`, async (t) => {
    const f = fixture(t)
    f.setHistory([stat('s', f.tracks[404], ['404'])])
    const mutate = () =>
      f.db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'Changed' } }])
    if (phase === 'library') {
      const read = f.api.queryTracks
      f.api.queryTracks = async (query) => {
        const page = await read(query)
        if (query?.sort === 'insertion') mutate()
        return page
      }
    }
    if (phase === 'history' || phase === 'incomplete') {
      const read = f.api.getTracksByIds
      f.api.getTracksByIds = async (...args) => {
        const page = await read(...args)
        if (phase === 'history') mutate()
        return phase === 'incomplete' ? { ...page, tracks: [] } : page
      }
    }
    if (phase === 'final' || phase === 'preferences')
      f.api.getMetadata = async () => {
        if (phase === 'final') mutate()
        else f.changePreferences()
        return f.db.getMetadata()
      }
    f.source.refresh(true)
    await settled(f.source)
    assert.match(f.source.state.value.error, /变化/)
    assert.equal(f.source.state.value.data, null)
    assert.equal(f.source.state.value.history.size, 0)
  })

test('one read lane coalesces a storm, ignores old notifications and stops new calls after disposal', async (t) => {
  const f = fixture(t),
    read = f.api.queryTracks
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.api.queryTracks = async (query) => {
    await gate
    return read(query)
  }
  f.source.refresh(true)
  await tick()
  for (let i = 0; i < 500; i++) f.source.refresh()
  assert.deepEqual(f.source.requests, { active: 1, pending: 1 })
  release()
  await settled(f.source)
  assert.equal(f.source.state.value.error, '')
  assert.equal(f.maximum, 1)
  assert.equal(f.counts.queryTracks, 2)
  const calls = { ...f.counts }
  for (let i = 0; i < 500; i++) f.source.invalidate(f.db.getMetadata().revision)
  await settled(f.source)
  assert.deepEqual(f.counts, calls)
  const g = fixture(t),
    next = g.api.queryTracks
  let finish!: () => void
  g.api.queryTracks = async (query) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return next(query)
  }
  g.source.refresh(true)
  await tick()
  g.source.dispose()
  finish()
  await settled(g.source)
  assert.equal(g.counts.queryTracks, 1)
  assert.equal(g.counts.queryCollections, undefined)
  assert.equal(g.source.state.value.data, null)
})

test('discovery and SQL failures are visible and retryable; explicit JSON mode performs no database reads', async (t) => {
  const f = fixture(t)
  f.options.getStorageMode = async () => {
    throw new Error('discovery offline')
  }
  f.source.refresh(true)
  await settled(f.source)
  assert.equal(f.source.state.value.error, 'discovery offline')
  assert.equal(f.source.state.value.mode, null)
  assert.deepEqual(f.counts, {})
  f.options.getStorageMode = async () => 'json'
  f.source.retry()
  await settled(f.source)
  assert.equal(f.source.state.value.mode, 'json')
  assert.deepEqual(f.counts, {})
  const g = fixture(t),
    read = g.api.queryCollections
  g.api.queryCollections = async () => {
    throw new Error('database offline')
  }
  g.source.refresh(true)
  await settled(g.source)
  assert.equal(g.source.state.value.mode, 'sqlite')
  assert.equal(g.source.state.value.error, 'database offline')
  assert.equal(g.source.state.value.data, null)
  g.api.queryCollections = read
  g.source.retry()
  await settled(g.source)
  assert.equal(g.source.state.value.error, '')
  assert.equal((g.source.state.value as LibraryDashboardState).data?.total, 405)
})
