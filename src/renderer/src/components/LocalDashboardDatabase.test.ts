import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref } from 'vue'
import { readCoreDashboard } from './local-dashboard/coreDashboard.ts'
import type { CorePlayerClient } from '../stores/player/corePlayerTypes.ts'
import type { Track } from '../types/music.ts'

const track = (id: string): Track => ({ id, title: id, artist: 'Artist', album: 'Release', duration: 180, size: 1 })

test('home reads Core totals and bounded shelves at one content revision', async () => {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = []
  const core = { query: async (name: string, payload: Record<string, unknown>) => {
    calls.push({ name, payload })
    if (name === 'library.artwork') return { revision: 4, items: [{ id: 'song:1', cover: 'cover://one' }] }
    if (name === 'library.collections') return { revision: 4, items: payload.kind === 'albums' ? [{ id: 'release:1', name: 'Release', trackCount: 100 }] : [], total: payload.kind === 'albums' ? 500 : 800 }
    const recent = payload.direction === 'desc'
    return { revision: 4, tracks: Array.from({ length: 6 }, (_, i) => track(`song:${recent ? i + 4 : i}`)), total: 300000, totalDuration: 54000000 }
  } } as Pick<CorePlayerClient, 'query'>
  const result = await readCoreDashboard(core)
  assert.equal(result.total, 300000)
  assert.equal(result.duration, 54000000)
  assert.equal(result.albumCount, 500)
  assert.equal(result.artistCount, 800)
  assert.equal(result.first.length, 6)
  assert.equal(result.recent.length, 6)
  assert.equal(result.first[1].cover, 'cover://one')
  assert.equal(result.first[0].cover, null)
  assert.equal(calls.length, 5)
  assert.deepEqual(calls[0], { name: 'library.tracks', payload: { sort: 'playlist', limit: 6 } })
  assert.equal((calls[4].payload.ids as string[]).length, 10)
  assert.equal(calls[4].payload.revision, 4)
  for (const call of calls.slice(1, 4)) {
    const query = (call.payload.query ?? call.payload) as Record<string, unknown>
    assert.equal(query.contentRevision, 4)
  }
})

test('home reports a changed Core revision instead of mixing shelves', async () => {
  const core = { query: async (name: string, payload: Record<string, unknown>) => {
    if (name === 'library.artwork') return { revision: 9, items: [] }
    if (name === 'library.collections') return { revision: 8, total: 0, items: [] }
    return { revision: 8, total: 1, tracks: payload.direction ? [] : [track('one')] }
  } } as Pick<CorePlayerClient, 'query'>
  await assert.rejects(readCoreDashboard(core), /曲库已变化/)
})

function playbackFixture(preview = false) {
  const source = readFileSync(new URL('./LocalDashboard.vue', import.meta.url), 'utf8').match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('home.ts', source, ts.ScriptTarget.Latest, true)
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['playDashboardTrack', 'shuffleAll', 'playAlbum'].includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n')
  const calls: Array<{ kind: string; query?: unknown; selected?: string; options?: unknown; tracks?: Track[] }> = []
  let failure = ''
  const error = ref(''), items = Array.from({ length: 405 }, (_, i) => track(String(i)))
  const js = ts.transpileModule(`${functions}; ({playDashboardTrack,shuffleAll,playAlbum})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const actions = runInNewContext(js, {
    Error, props: { previewTracks: preview ? items : undefined }, previewTracks: ref(items), DASHBOARD_QUEUE_WINDOW: 200,
    dashboardActionError: error, dashboardTrackCount: ref(300000), dashboardState: ref({ data: { revision: 8 } }),
    getTrackSource: (value: Track) => value.source ?? 'local',
    playTrack: async (_track: Track, tracks: Track[]) => { if (failure) throw Error(failure); calls.push({ kind: 'tracks', tracks }) },
    playbackStore: { playLibraryQuery: async (query: unknown, selected?: string, options?: unknown) => { if (failure) throw Error(failure); calls.push({ kind: 'query', query, selected, options }) } }
  })
  return { ...actions, calls, error, items, fail: (value: string) => { failure = value } }
}

test('home sends library playback and shuffle to Core; preview alone builds a bounded UI queue', async () => {
  const home = playbackFixture()
  await home.playDashboardTrack(track('song:1'))
  home.shuffleAll()
  home.playAlbum({ id: 'release:1' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(home.calls)), [
    { kind: 'query', query: { sort: 'playlist', contentRevision: 8 }, selected: 'song:1' },
    { kind: 'query', query: { sort: 'playlist', contentRevision: 8 }, options: { randomStart: true, playMode: 'shuffle' } },
    { kind: 'query', query: { albumId: 'release:1', sort: 'trackNumber', contentRevision: 8 } }
  ])
  await home.playDashboardTrack({ ...track('ncm:1'), source: 'ncm' })
  assert.equal(home.calls.at(-1)?.tracks?.length, 1)
  const preview = playbackFixture(true)
  await preview.playDashboardTrack(preview.items[210])
  assert.equal(preview.calls[0].tracks?.length, 200)
  assert.equal(preview.calls[0].tracks?.some(item => item.id === '210'), true)
})

test('home keeps failed Core commands visible and clears the error on a successful retry', async () => {
  const home = playbackFixture()
  home.fail('Core source unavailable')
  await home.playDashboardTrack(track('song:1'))
  assert.equal(home.error.value, 'Core source unavailable')
  assert.equal(home.calls.length, 0)
  home.fail('')
  await home.playDashboardTrack(track('song:1'))
  assert.equal(home.error.value, '')
  assert.equal(home.calls.length, 1)
})
