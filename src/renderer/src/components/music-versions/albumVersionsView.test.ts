import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import {
  ALBUM_RELEASE_PAGE_SIZE,
  ALBUM_SOURCE_PAGE_SIZE,
  albumProviderOrder,
  createAlbumVersionsView
} from './albumVersionsView.ts'
import type {
  AlbumBrowsePage,
  AlbumBrowseRelease,
  AlbumSourcesPage
} from '../../../../shared/musicAlbumBrowse.ts'
import type { UnifiedPlaybackResult } from '../../../../shared/musicUnifiedPlayback.ts'

const token = {
  genresRevision: 1,
  catalogRevision: 7,
  contentRevision: 2,
  metadataRevision: 3,
  asOf: 1,
  expiresAt: null,
  contextKey: 'local-context'
}
const release = (id: string, current = false): AlbumBrowseRelease => ({
  id,
  entityId: `catalog-${id}`,
  title: id,
  artist: 'Artist',
  current,
  identity: 'unidentified',
  metadataTargetId: null,
  sourceCount: 2,
  playbackVersionCount: 1
})
const browse = (ids = ['current', 'other'], offset = 0): AlbumBrowsePage => ({
  token,
  project: {
    entityId: 'project',
    title: 'Project',
    artist: 'Artist',
    identity: 'confirmed',
    metadataTargetId: 'mb-project'
  },
  currentRelease: release('current', true),
  projectCount: 1,
  offset,
  total: 8,
  items: ids.map((id) => release(id, id === 'current')),
  externalCatalog: 'unavailable'
})
const sources = (id = 'current', offset = 0): AlbumSourcesPage => ({
  token,
  release: release(id, id === 'current'),
  offset,
  total: 21,
  providers: ['local', 'provider'],
  providerCount: 2,
  items: [
    {
      sourceId: `${id}-local`,
      provider: 'local',
      recordingId: 'recording',
      title: 'Song',
      artist: 'Artist',
      album: id,
      availability: 'indexed',
      preferred: true,
      playbackVersion: {
        id: 'manual-album-version',
        entityId: 'catalog-manual-album-version',
        label: 'Studio',
        familyId: 'family',
        preferredVersionId: 'manual-album-version',
        metadataTargetId: null,
        projectMetadataTargetId: null
      },
      identityConflict: false
    }
  ]
})
const result: UnifiedPlaybackResult = {
  status: 'played',
  requestedSourceId: 'current-local',
  sourceId: 'current-other',
  versionId: 'manual-track-version',
  attempts: [
    {
      sourceId: 'current-local',
      provider: 'local',
      status: 'failed',
      code: 'SOURCE_MISSING',
      message: '文件不可访问'
    },
    {
      sourceId: 'current-other',
      provider: 'provider',
      status: 'selected',
      code: null,
      message: null
    }
  ]
}
type Api = Parameters<typeof createAlbumVersionsView>[0]
const api = (extra: Partial<Api> = {}): Api => ({
  browse: async () => browse(),
  sources: async (query) => sources(query.releaseId, query.offset),
  play: async () => undefined,
  playUnified: async () => result,
  ...extra
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('defaults to current release with bounded pages and one frozen source scope', async (t) => {
  const calls: unknown[] = []
  const view = createAlbumVersionsView(
    api({
      browse: async (query) => {
        calls.push(query)
        return browse()
      },
      sources: async (query) => {
        calls.push(query)
        return sources(query.releaseId)
      }
    })
  )
  t.after(view.dispose)
  await view.setContext('catalog-current', 'epoch')
  assert.deepEqual(calls, [
    { entityId: 'catalog-current', offset: 0, limit: ALBUM_RELEASE_PAGE_SIZE, token: undefined },
    {
      entityId: 'catalog-current',
      releaseId: 'current',
      offset: 0,
      limit: ALBUM_SOURCE_PAGE_SIZE,
      token
    }
  ])
  assert.equal(view.state.value.selectedReleaseId, 'current')
  assert.equal(view.state.value.sources?.items[0].playbackVersion?.id, 'manual-album-version')
  assert.equal(view.state.value.page?.project?.metadataTargetId, 'mb-project')
})

test('release and source pagination preserve selected release and bound all reads', async (t) => {
  const queries: unknown[] = []
  const view = createAlbumVersionsView(
    api({
      browse: async (query) => {
        queries.push(query)
        return query.offset ? browse(['last'], query.offset) : browse()
      },
      sources: async (query) => {
        queries.push(query)
        return sources(query.releaseId, query.offset)
      }
    })
  )
  t.after(view.dispose)
  await view.setContext('catalog-current', 'epoch')
  await view.select('other')
  await view.page(6)
  assert.equal(view.state.value.selectedReleaseId, 'other')
  assert.equal((view.state.value.sources as AlbumSourcesPage | null)?.release?.id, 'other')
  await view.sourcePage(20)
  assert.deepEqual(queries.at(-1), {
    entityId: 'catalog-current',
    releaseId: 'other',
    offset: 20,
    limit: 20,
    token
  })
  assert.deepEqual(queries[3], { entityId: 'catalog-current', offset: 6, limit: 6, token })
})

test('explicit source playback never invokes unified selection; unified sends album scope and retains actual attempts', async (t) => {
  const explicit: unknown[] = [],
    unified: unknown[] = []
  const view = createAlbumVersionsView(
    api({
      play: async (...args) => {
        explicit.push(args.slice(0, 2))
      },
      playUnified: async (...args) => {
        unified.push(args.slice(0, 3))
        return result
      }
    })
  )
  t.after(view.dispose)
  await view.setContext('catalog-current', 'epoch')
  await view.play('not-on-this-page', true)
  assert.equal(unified.length, 0)
  await view.play('current-local')
  assert.deepEqual(explicit, [['current-local', 7]])
  assert.equal(unified.length, 0)
  assert.match(view.state.value.playNotice, /所选音源/)
  await view.play('current-local', true)
  assert.deepEqual(unified, [
    ['current-local', 7, { entityId: 'catalog-current', releaseId: 'current', token }]
  ])
  assert.deepEqual(view.state.value.playResult, result)
  assert.equal(view.state.value.playResult?.sourceId, 'current-other')
})

test('invalidation withdraws results and counts but keeps release selection for explicit reread', async (t) => {
  let plays = 0
  const view = createAlbumVersionsView(
    api({
      play: async () => {
        plays++
      }
    })
  )
  t.after(view.dispose)
  await view.setContext('catalog-current', 'epoch')
  await view.select('other')
  view.invalidate()
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.sources, null)
  assert.equal(view.state.value.selectedReleaseId, 'other')
  assert.equal(view.ready.value, false)
  await view.play('other-local')
  assert.equal(plays, 0)
  await view.refresh()
  assert.equal(view.state.value.selectedReleaseId, 'other')
  assert.equal((view.state.value.sources as AlbumSourcesPage | null)?.release?.id, 'other')
})

test('old context, source selection and cancelled playback responses cannot overwrite newer state', async (t) => {
  const oldPage = deferred<AlbumBrowsePage>(),
    oldSources = deferred<AlbumSourcesPage>(),
    oldPlay = deferred<UnifiedPlaybackResult>()
  const signals: AbortSignal[] = []
  const view = createAlbumVersionsView(
    api({
      browse: async (query, signal) => {
        signals.push(signal)
        return query.entityId === 'old' ? oldPage.promise : browse()
      },
      sources: async (query) => (query.releaseId === 'other' ? oldSources.promise : sources()),
      playUnified: async () => oldPlay.promise
    })
  )
  t.after(view.dispose)
  const old = view.setContext('old', 'epoch')
  await view.setContext('new', 'epoch')
  oldPage.resolve(browse(['old']))
  await old
  assert.equal(signals[0].aborted, true)
  assert.equal(view.state.value.page?.items[0].id, 'current')
  const play = view.play('current-local', true)
  view.cancelPlayback()
  oldPlay.resolve(result)
  await play
  assert.equal(view.state.value.playResult, null)
  const select = view.select('other')
  view.invalidate()
  oldSources.resolve(sources('other'))
  await select
  assert.equal(view.state.value.sources, null)
  assert.equal(view.state.value.blocked, true)
})

test('a changed token or stale revision rejects the whole source read', async (t) => {
  let changed = true
  const view = createAlbumVersionsView(
    api({
      sources: async () => {
        if (changed) return { ...sources(), token: { ...token, metadataRevision: 4 } }
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      }
    })
  )
  t.after(view.dispose)
  await view.setContext('current', 'epoch')
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.blocked, true)
  changed = false
  await view.refresh()
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.sources, null)
})

test('expired reads and unmounted pending requests do not publish results', async () => {
  const expired = createAlbumVersionsView(
    api({ browse: async () => ({ ...browse(), token: { ...token, expiresAt: Date.now() - 1 } }) })
  )
  await expired.setContext('current', 'epoch')
  assert.equal(expired.state.value.page, null)
  assert.equal(expired.state.value.blocked, true)
  expired.dispose()
  const pending = deferred<AlbumBrowsePage>()
  const view = createAlbumVersionsView(api({ browse: async () => pending.promise }))
  const work = view.setContext('current', 'epoch')
  view.dispose()
  const before = view.state.value
  pending.resolve(browse())
  await work
  assert.equal(view.state.value, before)
})

test('an explicit fresh read replaces the old expiry clock and expires its own results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const fresh = deferred<AlbumBrowsePage>()
  let reads = 0
  const view = createAlbumVersionsView(
    api({
      browse: async () =>
        reads++ ? fresh.promise : { ...browse(), token: { ...token, expiresAt: 1100 } },
      sources: async (query) => ({ ...sources(query.releaseId), token: query.token })
    })
  )
  t.after(view.dispose)
  await view.setContext('current', 'epoch')
  const reading = view.refresh()
  t.mock.timers.tick(100)
  assert.equal(view.state.value.loading, true)
  assert.equal(view.state.value.blocked, false)
  fresh.resolve({ ...browse(), token: { ...token, expiresAt: 1200 } })
  await reading
  assert.equal(view.state.value.sources?.total, 21)
  t.mock.timers.tick(100)
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.sources, null)
  assert.equal(view.state.value.blocked, true)
})

test('unavailable playback preserves each failed reason and explicit failure remains explicit', async (t) => {
  const unavailable: UnifiedPlaybackResult = {
    ...result,
    status: 'unavailable',
    sourceId: null,
    attempts: result.attempts.filter((attempt) => attempt.status === 'failed')
  }
  const view = createAlbumVersionsView(
    api({
      play: async () => {
        throw new Error('明确音源不可访问')
      },
      playUnified: async () => unavailable
    })
  )
  t.after(view.dispose)
  await view.setContext('current', 'epoch')
  await view.play('current-local')
  assert.equal(view.state.value.playError, '明确音源不可访问')
  assert.equal(view.state.value.playResult, null)
  await view.play('current-local', true)
  assert.deepEqual(view.state.value.playResult, unavailable)
  assert.equal(view.state.value.playError, '')
})

test('actual album entry and controls compile with distinct metadata, manual version, family and playback paths', async () => {
  const source = await readFile(new URL('./AlbumVersionsPanel.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'album-versions-test' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: 'AlbumVersionsPanel.vue',
    id: 'album-versions-test',
    compilerOptions: { bindingMetadata: script.bindings }
  })
  assert.deepEqual(template.errors, [])
  for (const label of [
    '专辑项目',
    '资料发行已确认',
    '人工专辑播放版本',
    '版本族',
    '统一播放此曲',
    '明确播放此音源',
    '实际音源',
    'attempt.message'
  ])
    assert.ok(source.includes(label), label)
  assert.match(source, /core\.command\('catalog\.play', \{ sourceId, revision \}/)
  assert.match(source, /catalog\.playUnified/)
  const entry = await readFile(
    new URL('../music-metadata/EntityMetadataPanel.vue', import.meta.url),
    'utf8'
  )
  assert.match(entry, /<AlbumVersionsPanel[\s\S]*?:entity-id="albumEntityId"/)
  assert.match(entry, /selected\?\.kind === 'release'/)
})

test('page-only provider order respects actual platforms without inferring quality', () => {
  assert.equal(albumProviderOrder('default', ['local', 'provider']), undefined)
  assert.deepEqual(albumProviderOrder('local-first', ['provider']), ['local'])
  assert.deepEqual(albumProviderOrder('streaming-first', ['z', 'local', 'a', 'a']), ['a', 'z'])
  assert.deepEqual(albumProviderOrder('streaming-first', ['provider']), ['provider'])
})
