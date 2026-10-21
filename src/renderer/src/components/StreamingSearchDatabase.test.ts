import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref } from 'vue'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import type { LibraryQuery } from '../../../shared/libraryDatabase.ts'
import { useMusicStore } from '../stores/useMusicStore.ts'
import { unifiedSearchSongs } from '../utils/unifiedMusicSearch.ts'
import { getTrackSource } from '../utils/trackSourceIdentity.ts'
import { createAlbumSearch } from './streaming-page/albumSearch.ts'
import { createArtistSearch, type ArtistSearchItem } from './streaming-page/artistSearch.ts'
import type { AlbumSearchItem } from './streaming-page/albumSearch.ts'
import type { Track } from '../types/music.ts'

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

test('production streaming all/local and manual-rematch callers read authoritative pages without a full renderer array', async (t) => {
  const db = new LibraryDatabase(':memory:'),
    store = useMusicStore()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const tracks: Track[] = Array.from({ length: 405 }, (_, i) => ({
    id: `local:${i}`,
    filePath: `D:/Music/${i}.flac`,
    fileName: `${i}.flac`,
    title: `晴天 ${String(i).padStart(4, '0')}`,
    artist: '周杰伦',
    album: 'Album',
    source: 'local',
    format: 'flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null
  }))
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  let fail = false
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        library: {
          getStorageMode: async () => 'sqlite',
          database: {
            queryTracks: async (query: LibraryQuery) => {
              if (fail) throw new Error('database offline')
              return db.queryTracks(query)
            },
            getMetadata: async () => db.getMetadata()
          }
        }
      }
    }
  })
  store.clearTracks()
  const source = store.createUnifiedSearchSource()
  t.after(() => {
    source.dispose()
    store.clearTracks()
    db.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const repairs = ref(''),
    replacements: string[] = []
  const bindings = {
    localSearchSource: source,
    rematchSearchSource: source,
    musicStore: {
      tracks: {
        get value(): never {
          throw new Error('full renderer library access')
        }
      }
    },
    tracks: {
      get value(): never {
        throw new Error('full renderer library access')
      }
    },
    mediaProviders: {
      searchAllSongs: (options: Parameters<typeof unifiedSearchSongs>[0]) =>
        unifiedSearchSongs({
          ...options,
          providers: [],
          searchProviderSongs: async () => ({ items: [], total: 0 })
        })
    },
    repairMessage: repairs,
    syncPluginProviders: async () => {},
    buildMetadataMatchCandidates: (_track: Track, candidates: Track[]) =>
      candidates.map((track) => ({ track })),
    replaceTrackReference: (_id: string, track: Track) => {
      replacements.push(track.id)
      return 1
    },
    getTrackSource: () => 'local',
    DOMException,
    Error
  }
  const code =
    functions('./StreamingPage.vue', ['searchUnifiedSongs', 'searchLocalSongs']) +
    '\n' +
    functions('./SongList.vue', ['handleManualRematch'])
  const entry = runInNewContext(
    ts.transpileModule(code + '\n({ searchUnifiedSongs, searchLocalSongs, handleManualRematch })', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
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
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(search('晴天', 30, 0, { signal: abort.signal }), { name: 'AbortError' })
  }
  const localPage = await entry.searchLocalSongs('zjl', 30, 300)
  assert.deepEqual(JSON.parse(JSON.stringify(localPage.playbackQuery)), {
    search: 'zjl',
    sort: 'playlist',
    contentRevision: db.getMetadata().revision
  })
  const queue = db.createLibraryQueue(localPage.playbackQuery!, localPage.tracks[0].id)
  assert.equal(
    queue.total,
    405,
    'production local playback includes results outside the 30-row search page'
  )
  assert.equal(queue.index, 300)
  assert.equal(db.readLibraryQueue(queue.id, 404, 1).items[0].track?.id, 'local:404')
  await entry.handleManualRematch({ ...tracks[404], artist: '' })
  assert.equal(replacements[0], 'local:404')
  fail = true
  await entry.handleManualRematch({ ...tracks[404], artist: '' })
  assert.equal(repairs.value, 'database offline')
  assert.equal(replacements.length, 1)
  assert.equal(store.tracks.value.length, 0)
})

test('production collection factories and navigation use SQL summaries and the existing paged local detail without loading member arrays', async (t) => {
  const db = new LibraryDatabase(':memory:'),
    store = useMusicStore()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const tracks = Array.from({ length: 405 }, (_, i) => ({
    id: `local:${i}`,
    filePath: `D:/Music/${i}/song.flac`,
    fileName: 'song.flac',
    title: `Song ${i}`,
    artist: `周杰伦 ${i}`,
    album: `范特西 ${i}`,
    albumId: `release:${i}`,
    source: 'local'
  }))
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  let release: (() => void) | null = null,
    delay = false
  const queries: Array<{ kind: string; query?: LibraryQuery }> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        library: {
          getStorageMode: async () => 'sqlite',
          database: {
            queryCollections: async (kind: 'albums' | 'artists', query?: LibraryQuery) => {
              queries.push({ kind, query })
              if (delay)
                await new Promise<void>((resolve) => {
                  release = resolve
                })
              return db.queryCollections(kind, query)
            },
            getMetadata: async () => db.getMetadata()
          }
        }
      }
    }
  })
  store.clearTracks()
  const source = store.createUnifiedSearchSource()
  t.after(() => {
    source.dispose()
    store.clearTracks()
    db.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const events: unknown[][] = [],
    notices: unknown[] = [],
    providerNavigations: string[] = []
  const searchType = ref('albums'),
    searchSource = ref('all'),
    activeProvider = ref('remote-a')
  let refreshes = 0,
    invalidate: (() => void) | undefined
  const bindings = {
    musicStore: {
      albums: {
        get value(): never {
          throw new Error('full renderer albums')
        }
      },
      artists: {
        get value(): never {
          throw new Error('full renderer artists')
        }
      }
    },
    createAlbumSearch,
    createArtistSearch,
    useLibraryUnifiedSearch: (callback: () => void) => {
      invalidate = callback
      return source
    },
    searchType,
    searchSource,
    activeProvider,
    refreshSearch: () => {
      refreshes++
    },
    providerStore: { providers: ref([]) },
    mediaProviders: { get: () => null },
    pushNotice: (notice: unknown) => notices.push(notice),
    props: { active: true },
    emit: (...args: unknown[]) => events.push(args),
    detailNavigationToken: 0,
    selectDetailProvider: async (id: string) => {
      activeProvider.value = id
    },
    openArtist: async (artist: ArtistSearchItem) =>
      providerNavigations.push(`${activeProvider.value}:${artist.id}`),
    beginDetailTransition: () =>
      assert.fail('SQLite details must use the existing paged local detail'),
    getTrackSource,
    Error,
    DOMException
  }
  const code =
    declarations('./StreamingPage.vue', ['localSearchSource', 'albumSearch', 'artistSearch']) +
    '\n' +
    functions('./StreamingPage.vue', [
      'isCurrentDetailNavigation',
      'openTrackAlbum',
      'openSearchAlbum',
      'openSearchArtist',
      'openAlbum'
    ])
  const entry = runInNewContext(
    ts.transpileModule(
      code + '\n({ albumSearch, artistSearch, openTrackAlbum, openSearchAlbum, openSearchArtist })',
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
      }
    ).outputText,
    bindings
  ) as {
    albumSearch: ReturnType<typeof createAlbumSearch>
    artistSearch: ReturnType<typeof createArtistSearch>
    openTrackAlbum(track: (typeof tracks)[number]): Promise<void>
    openSearchAlbum(album: AlbumSearchItem): Promise<void>
    openSearchArtist(artist: ArtistSearchItem): Promise<void>
  }
  const albums = await entry.albumSearch.searchAlbums('zjl ftx', 30, 300)
  const artists = await entry.artistSearch.searchArtists('周杰伦', 30, 300)
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
      `album:${(await source.resolveAlbum({ trackId: 'local:404' })).albumId}`
    ]
  ])
  assert.equal(notices.length, 0)
  assert.ok(queries.every(({ query }) => (query?.limit ?? 200) <= 30))
  await entry.openSearchArtist({
    id: artist.id,
    name: artist.name,
    picUrl: null,
    providerId: 'remote-b'
  })
  assert.deepEqual(providerNavigations, [`remote-b:${artist.id}`])
  invalidate!()
  searchType.value = 'artists'
  invalidate!()
  searchType.value = 'playlists'
  invalidate!()
  searchType.value = 'albums'
  searchSource.value = 'remote-b'
  invalidate!()
  assert.equal(refreshes, 2, 'only searches with local SQL participants refresh on content changes')
  delay = true
  const lateAlbum = entry.openSearchAlbum(album)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(release)
  await entry.openSearchArtist(artist)
  const count = events.length
  ;(release as () => void)()
  await lateAlbum
  assert.equal(events.length, count, 'a slow album read cannot override newer artist navigation')
})
