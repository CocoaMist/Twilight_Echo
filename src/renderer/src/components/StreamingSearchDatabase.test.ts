import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'
import { coreLibraryFixture } from '../stores/coreLibraryTestFixture.ts'
import { coreQueueTrackInput } from '../stores/player/corePlayerQueue.ts'
import { getTrackSource } from '../utils/trackSourceIdentity.ts'
import { createCoreCollectionSearch } from './streaming-page/coreCollectionSearch.ts'
import type { LibraryQuery } from '../../../shared/libraryDatabase.ts'
import type { Track } from '../types/music.ts'
import type { useLibraryUnifiedSearch } from '../app/useLibraryUnifiedSearch.ts'
import type { AlbumSearchItem } from './streaming-page/albumSearch.ts'
import type { ArtistSearchItem } from './streaming-page/artistSearch.ts'

function functions(file: string, names: string[]): string {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('component.ts', script, ts.ScriptTarget.Latest, true)
  const nodes = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')
  )
  assert.equal(nodes.length, names.length)
  return nodes.map((node) => node.getText(ast)).join('\n')
}

function declarations(file: string, names: string[]): string {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(
    'component.ts',
    source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1],
    ts.ScriptTarget.Latest,
    true
  )
  const nodes = ast.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        names.includes(declaration.name.getText(ast))
      )
  )
  assert.equal(nodes.length, names.length)
  return nodes.map((node) => node.getText(ast)).join('\n')
}

function source(t: test.TestContext, core: Awaited<ReturnType<typeof coreLibraryFixture>>['core']) {
  const exports: { useLibraryUnifiedSearch?: typeof useLibraryUnifiedSearch } = {}
  const unmounts: Array<() => void> = [],
    scope = vue.effectScope()
  t.after(() => {
    unmounts.forEach((unmount) => unmount())
    scope.stop()
  })
  const dependencies: Record<string, unknown> = {
    vue: { ...vue, onBeforeUnmount: (fn: () => void) => unmounts.push(fn) },
    '../stores/coreConnection.ts': { useCoreConnection: () => core }
  }
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../app/useLibraryUnifiedSearch.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }
    ).outputText,
    {
      exports,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      AbortController,
      AbortSignal,
      Error
    }
  )
  return scope.run(() => exports.useLibraryUnifiedSearch!())!
}
function evaluate(code: string, bindings: object) {
  return runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
    { ...bindings, Error, DOMException }
  )
}

test('production all/local search and manual-rematch callers use Core pages and commands without a renderer library', async (t) => {
  const f = await coreLibraryFixture(t, {
    tracks: Array.from({ length: 405 }, (_, i) => ({
      id: `local:${i}`,
      filePath: `D:/Music/${i}.flac`,
      title: `晴天 ${String(i).padStart(4, '0')}`,
      artist: '周杰伦',
      album: 'Album',
      source: 'local',
      format: 'flac',
      duration: 180
    }))
  })
  const localSearchSource = source(t, f.core),
    repairs = vue.ref(''),
    rematches: unknown[] = []
  const bindings = {
    localSearchSource,
    mediaProviders: {
      searchAllSongs: ({ signal, ...query }: any) => f.core.query('search.songs', query, signal)
    },
    core: {
      command: async (name: string, payload: unknown) => {
        rematches.push({ name, payload })
        return { count: 1, track: { title: 'Authoritative match' } }
      }
    },
    repairMessage: repairs,
    playlistRevision: () => f.core.state.value!.playlistsRevision,
    trackInput: (track: Track) => coreQueueTrackInput(track, null)
  }
  const entry = evaluate(
    functions('./StreamingPage.vue', ['searchUnifiedSongs', 'searchLocalSongs']) +
      '\n' +
      functions('./SongList.vue', ['handleManualRematch']) +
      '\n({ searchUnifiedSongs, searchLocalSongs, handleManualRematch })',
    bindings
  ) as {
    searchUnifiedSongs(
      query: string,
      limit: number,
      offset: number,
      options?: { signal?: AbortSignal }
    ): Promise<{ tracks: Track[]; total: number }>
    searchLocalSongs(
      query: string,
      limit: number,
      offset: number,
      options?: { signal?: AbortSignal }
    ): Promise<{ tracks: Track[]; total: number; playbackQuery?: LibraryQuery }>
    handleManualRematch(track: Track): Promise<void>
  }
  for (const search of [entry.searchUnifiedSongs, entry.searchLocalSongs]) {
    const page = await search('zjl', 30, 300)
    assert.equal(page.total, 405)
    assert.equal(page.tracks.length, 30)
    assert.equal(page.tracks[0].id, 'local:300')
    assert.equal('filePath' in page.tracks[0], false)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(search('晴天', 30, 0, { signal: abort.signal }), { name: 'AbortError' })
  }
  const page = await entry.searchLocalSongs('zjl', 30, 300)
  const queue = f.db.createLibraryQueue(page.playbackQuery!, page.tracks[0].id)
  assert.equal(queue.total, 405)
  assert.equal(queue.index, 300)
  await entry.handleManualRematch(page.tracks[0])
  assert.equal(repairs.value, '已重新匹配到 Authoritative match')
  assert.deepEqual(JSON.parse(JSON.stringify(rematches)), [
    {
      name: 'playlists.rematch',
      payload: { revision: f.playlists.getRevision(), input: { kind: 'local', id: 'local:300' } }
    }
  ])
  bindings.core.command = async () => {
    throw new Error('database offline')
  }
  await entry.handleManualRematch(page.tracks[0])
  assert.equal(repairs.value, 'database offline')
  assert.equal(rematches.length, 1)
})

test('production collection search and navigation read Core summaries and use paged local details rather than member arrays', async (t) => {
  const tracks = Array.from({ length: 405 }, (_, i) => ({
    id: `local:${i}`,
    filePath: `D:/Music/${i}/song.flac`,
    title: `Song ${i}`,
    artist: `周杰伦 ${i}`,
    album: `范特西 ${i}`,
    albumId: `release:${i}`,
    source: 'local'
  }))
  const f = await coreLibraryFixture(t, { tracks }),
    local = source(t, f.core)
  const events: unknown[][] = [],
    notices: unknown[] = [],
    providerNavigations: string[] = []
  const searchType = vue.ref('albums'),
    searchSource = vue.ref('all'),
    activeProvider = vue.ref('remote-a')
  let refreshes = 0,
    invalidate!: () => void
  const bindings = {
    core: f.core,
    createCoreCollectionSearch,
    useLibraryUnifiedSearch: (callback: () => void) => {
      invalidate = callback
      return local
    },
    searchType,
    searchSource,
    activeProvider,
    refreshSearch: () => {
      refreshes++
    },
    mediaProviders: { get: () => null },
    pushNotice: (notice: unknown) => notices.push(notice),
    props: { active: true },
    emit: (...args: unknown[]) => events.push(args),
    detailNavigationToken: 0,
    selectDetailProvider: async (id: string) => {
      activeProvider.value = id
    },
    openArtist: async (artist: ArtistSearchItem) => {
      providerNavigations.push(`${activeProvider.value}:${artist.id}`)
    },
    beginDetailTransition: () => assert.fail('local details must use existing paged queries'),
    getTrackSource,
    friendlyStreamingError: (error: Error) => error.message
  }
  const entry = evaluate(
    declarations('./StreamingPage.vue', [
      'localSearchSource',
      'collectionSearch',
      'albumSearch',
      'artistSearch'
    ]) +
      '\n' +
      functions('./StreamingPage.vue', [
        'isCurrentDetailNavigation',
        'openTrackAlbum',
        'openSearchAlbum',
        'openSearchArtist',
        'openAlbum'
      ]) +
      '\n({ albumSearch, artistSearch, openTrackAlbum, openSearchAlbum, openSearchArtist })',
    bindings
  ) as {
    albumSearch: {
      searchAlbums(
        query: string,
        limit: number,
        offset: number
      ): Promise<{ albums: AlbumSearchItem[]; total: number }>
    }
    artistSearch: {
      searchArtists(
        query: string,
        limit: number,
        offset: number
      ): Promise<{ artists: ArtistSearchItem[]; total: number }>
    }
    openTrackAlbum(track: unknown): Promise<void>
    openSearchAlbum(album: AlbumSearchItem): Promise<void>
    openSearchArtist(artist: ArtistSearchItem): Promise<void>
  }
  const albums = await entry.albumSearch.searchAlbums('zjl ftx', 30, 300),
    artists = await entry.artistSearch.searchArtists('周杰伦', 30, 300)
  assert.equal(albums.total, 405)
  assert.equal(albums.albums.length, 30)
  assert.equal(artists.total, 405)
  assert.equal(artists.artists.length, 30)
  const album = albums.albums[0],
    artist = artists.artists[0]
  await entry.openSearchAlbum(album)
  await entry.openSearchArtist(artist)
  await entry.openTrackAlbum(tracks[404])
  assert.deepEqual(events, [
    ['selectView', 'albums', `album:${album.id}`],
    ['selectView', 'artists', `artist:${artist.name}`],
    [
      'selectView',
      'albums',
      `album:${(await local.resolveAlbum({ trackId: 'local:404' })).albumId}`
    ]
  ])
  assert.equal(notices.length, 0)
  assert.ok(
    f.queries
      .filter((query) => query.name === 'search.collections')
      .every((query) => (query.payload as { limit: number }).limit <= 30)
  )
  await entry.openSearchArtist({
    id: artist.id,
    name: artist.name,
    picUrl: null,
    providerId: 'remote-b'
  })
  assert.deepEqual(providerNavigations, [`remote-b:${artist.id}`])
  invalidate()
  searchType.value = 'artists'
  invalidate()
  searchType.value = 'playlists'
  invalidate()
  searchType.value = 'albums'
  searchSource.value = 'remote-b'
  invalidate()
  assert.equal(refreshes, 2)
  let release!: () => void
  f.intercept(async (name) => {
    if (name === 'library.collections')
      await new Promise<void>((resolve) => {
        release = resolve
      })
  })
  const late = entry.openSearchAlbum(album)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(release)
  await entry.openSearchArtist(artist)
  const count = events.length
  release()
  await late
  assert.equal(events.length, count)
})
