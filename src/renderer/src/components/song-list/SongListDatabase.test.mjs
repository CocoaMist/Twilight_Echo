import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { computed, effectScope, ref, shallowRef, toRaw } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { enrichLocalTrackMetadata } from '../../utils/musicMetadataMatching.ts'
import { libraryDirectoriesForFiles } from '../../utils/libraryScanDirectories.ts'
import { filterLocalGridItems } from '../../utils/localLibrarySearch.ts'
import { libraryTrackQuery } from '../../utils/libraryTrackQuery.ts'
import { createDefaultLibraryViewState } from '../../utils/libraryViewPreferences.ts'
import { LIBRARY_MAX_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import { normalizeLibraryPath } from '../../../../shared/libraryIdentity.ts'
import { toPlaylistTrackSnapshot } from '../../stores/library/musicStoreData.ts'
import { useTrackMultiSelect } from './useTrackMultiSelect.ts'
import { createSongListActionSource } from './songListActionSource.ts'
import {
  formatPlaylistSourceSummary,
  summarizePlaylistSources
} from '../../utils/playlistSourceSummary.ts'

// Actual production event functions, with the same data-source boundaries as the
// component. Browser rendering remains a separate acceptance check.
const source = stripTypeScriptTypes(
  readFileSync(new URL('../SongList.vue', import.meta.url), 'utf8')
    .split('<script setup lang="ts">')[1]
    .split('</script>')[0]
)
function install(context, names) {
  for (const name of names) {
    const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
    const end = source.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start, 'production function missing: ' + name)
    vm.runInContext(source.slice(start, end + 2), context)
  }
}
function installComputed(context, name, text = source) {
  const start = text.indexOf(`const ${name} = computed`)
  const next = text.slice(start).search(/\r?\n(?:\r?\n|(?=(?:const|let|function)\s))/)
  assert.ok(start >= 0 && next > 0, 'production computed missing: ' + name)
  vm.runInContext(text.slice(start, start + next), context)
}
const clone = (value) => JSON.parse(JSON.stringify(value))
function fixture() {
  const calls = [],
    query = {
      search: 'zjl',
      sort: 'duration',
      direction: 'desc',
      filters: { lossless: true },
      contentRevision: 7
    }
  const track = {
    id: '420',
    filePath: 'D:/Music/disc.flac',
    title: '月光',
    artist: '未知艺术家',
    album: '未知专辑',
    duration: 180
  }
  const context = vm.createContext({
    Error,
    computed,
    toRaw,
    toPlaylistTrackSnapshot,
    selectedTableRows: new WeakMap(),
    normalizeLibraryPath,
    LIBRARY_MAX_PAGE_SIZE,
    props: { category: 'allSongs' },
    tableTrackCount: ref(605),
    databaseQuery: ref(query),
    tableTracks: shallowRef([track]),
    tableEntryIds: shallowRef(new Map()),
    tableRowPositions: shallowRef(new Map([[track, 400]])),
    databaseWindowPages: shallowRef([{ offset: 400 }]),
    databasePlaylistState: shallowRef({ id: null }),
    currentPlaylist: shallowRef(null),
    databaseTableEnabled: ref(true),
    displayTracks: {
      get value() {
        throw new Error('legacy complete-array access')
      }
    },
    playbackStore: {
      playLibraryQuery: (...args) => {
        calls.push(['query', ...clone(args)])
        return Promise.resolve()
      }
    },
    playTrack() {
      throw new Error('legacy playback entry')
    },
    playTrackFromPosition() {
      throw new Error('legacy bookmark entry')
    },
    setPlayMode() {
      throw new Error('old source mode edit must not race a replacement')
    },
    selectedTrack: shallowRef(track),
    currentTrack: shallowRef(track),
    playbackBookmarks: { resumeBookmarkFor: () => ({ positionSeconds: 12.5 }) },
    closeContextMenu: () => calls.push(['close']),
    currentTrackIndex: ref(-1),
    scrollToTrack: (index) => calls.push(['scroll', index]),
    databasePages: {
      locate: (id) => calls.push(['locate', id]),
      pageForTrack: (record) =>
        context.tableTracks.value.includes(record)
          ? context.databasePageState.value.page
          : undefined,
      invalidate: (revision) => calls.push(['refresh', revision])
    },
    databasePageState: shallowRef({
      requestedPage: 2,
      page: { versions: { 420: 1 }, offset: 400, revision: 7 }
    }),
    visibleRange: ref({ start: 404, end: 426 }),
    isAlbumDetail: ref(false),
    prepareLocalTracksForRemoval: async (...args) => calls.push(['prepare', ...clone(args)]),
    notifyLocalTracksUnavailable: (...args) => calls.push(['unavailable', ...clone(args)]),
    window: {
      api: {
        library: {
          database: {
            removeFiles: async (request) => {
              calls.push(['remove', clone(request)])
              return {
                metadata: { revision: 10 },
                removedTrackIds: ['420', '421'],
                removedFilePaths: [track.filePath],
                failures: []
              }
            }
          }
        }
      }
    },
    repairMessage: ref('')
  })
  install(context, [
    'databasePageForTrack',
    'databasePlaybackQuery',
    'databasePlaybackOptions',
    'tableTrackKey',
    'playlistDefinitionTrack',
    'snapshotSelectedTableTrack',
    'playTableTrack',
    'playAllTracks',
    'shufflePlayTracks',
    'handleContinueFromBookmark',
    'locateCurrentTrack',
    'trackListNumber',
    'removeDatabaseSelectionFiles',
    'handleMetadataRematch'
  ])
  context.removeDatabaseFiles = async (selected, mode) => {
    const lease = await createSongListActionSource({
      rows: selected.map((track) => ({
        track,
        definitionId: track.id,
        version: context.selectedTableRows.get(track)?.version ?? 1,
        instance: 17
      }))
    }).open()
    try {
      await context.removeDatabaseSelectionFiles(lease, mode, { aborted: false })
    } finally {
      await lease.close()
    }
  }
  return { context, calls, query, track }
}

test('the complete production SongList template compiles, including context menu handlers', () => {
  const parsed = parse(readFileSync(new URL('../SongList.vue', import.meta.url), 'utf8'))
  assert.deepEqual(parsed.errors, [])
  const compiled = compileTemplate({
    source: parsed.descriptor.template.content,
    filename: 'SongList.vue',
    id: 'sqlite-song-list-test'
  })
  assert.deepEqual(compiled.errors, [])
})

test('page row, play-all, shuffle and bookmarks use the complete query, never the page as an array queue', () => {
  const f = fixture()
  f.context.playTableTrack(f.track)
  f.context.playAllTracks()
  f.context.shufflePlayTracks()
  f.context.handleContinueFromBookmark()
  const commands = f.calls.filter((call) => call[0] === 'query')
  assert.equal(commands.length, 4)
  assert.ok(commands.every((call) => JSON.stringify(call[1]) === JSON.stringify(f.query)))
  assert.equal(commands[0][2], '420')
  assert.deepEqual(commands[1].slice(2), [null, {}])
  assert.deepEqual(commands[2][3], { randomStart: true, playMode: 'shuffle' })
  assert.deepEqual(commands[3][3], { positionSeconds: 12.5 })
})

test('cross-page file removal uses bounded unique-file batches and stops on an unknown later outcome', async () => {
  const f = fixture()
  const selected = Array.from({ length: 2100 }, (_, index) => ({
    ...f.track,
    id: String(index),
    filePath: `D:/Music/${index}.flac`
  }))
  selected.push({ ...selected[0], id: 'cue-duplicate', filePath: 'd:\\music\\0.flac' })
  let attempts = 0
  f.context.window.api.library.database.removeFiles = async (request) => {
    attempts++
    assert.ok(request.items.length <= LIBRARY_MAX_PAGE_SIZE)
    return {
      mode: request.mode,
      metadata: { revision: 10 + attempts },
      removedTrackIds: request.items.map((track) => track.id),
      removedFilePaths: request.items.map((track) => track.filePath),
      failures: []
    }
  }
  await f.context.removeDatabaseFiles(selected, 'trash')
  assert.equal(attempts, 11)
  assert.equal(
    f.calls.filter((call) => call[0] === 'unavailable').reduce((n, call) => n + call[2].length, 0),
    2100,
    'CUE/duplicate occurrences share one physical operation'
  )
  assert.equal(f.calls.filter((call) => call[0] === 'prepare').length, 11)
  assert.equal(f.calls.filter((call) => call[0] === 'unavailable').length, 11)
  attempts = 0
  f.context.window.api.library.database.removeFiles = async (request) => {
    if (++attempts === 2) throw new Error('reply lost')
    return {
      mode: request.mode,
      metadata: { revision: 20 },
      failures: [],
      removedTrackIds: request.items.map((track) => track.id),
      removedFilePaths: request.items.map((track) => track.filePath)
    }
  }
  await assert.rejects(
    f.context.removeDatabaseFiles(selected, 'library'),
    /已确认移除 200 首.*reply lost/
  )
  assert.equal(attempts, 2, 'neither replay the unknown batch nor start later batches')
  assert.deepEqual(f.calls.at(-1), ['refresh', undefined])
})

function selectionFixture(t) {
  const f = fixture()
  Object.assign(f.context, {
    useTrackMultiSelect,
    containerRef: ref(null),
    debouncedSearchQuery: ref(''),
    recentSource: ref('all'),
    showTable: ref(true),
    databaseQuerySelection: ref(null) // Exercise the retained explicit-selection contract separately from SQL ranges.
  })
  f.context.databasePages.selectionEpoch = ref(0)
  const scope = effectScope()
  t.after(() => scope.stop())
  const start = source.indexOf('const multiSelect = useTrackMultiSelect(')
  const end = source.indexOf('\n})', start)
  assert.ok(start > 0 && end > start)
  scope.run(() => vm.runInContext(source.slice(start, end + 3), f.context))
  const multi = vm.runInContext('multiSelect', f.context)
  return { ...f, multi }
}

test('production selection bindings retain compact CUE occurrence identity off-page and legacy definition actions remain usable', async (t) => {
  const f = selectionFixture(t)
  f.context.databasePlaylistState.value = { id: 'view' }
  f.context.currentPlaylist.value = {
    trackIds: ['old-id', 'missing', 'other', 'other', 'other', 'old-duplicate']
  }
  const first = {
    ...f.track,
    lyrics: 'large lyrics',
    translatedLyrics: 'large translation',
    bpmAnalysis: { tempoMap: [1, 2, 3] },
    custom: { heavy: true },
    cover: 'data:image/png;base64,heavy',
    coverSmall: 'data:image/png;base64,heavy',
    cueRange: { startSeconds: 10, endSeconds: 30 },
    cueSheetPath: 'D:/Music/disc.cue',
    cueEncoding: 'UTF-8'
  }
  f.context.tableEntryIds.value = new Map([[first, '0']])
  f.context.tableRowPositions.value = new Map([[first, 400]])
  f.context.tableTracks.value = [first]
  f.multi.toggle('view:0', 0)
  f.context.databasePageState.value = { requestedPage: 3, page: null }
  f.context.tableEntryIds.value = new Map()
  f.context.tableTracks.value = []
  f.context.databaseWindowPages.value = []
  const duplicate = { ...first }
  f.context.tableEntryIds.value = new Map([[duplicate, '5']])
  f.context.tableRowPositions.value = new Map([[duplicate, 600]])
  f.context.databaseWindowPages.value = [{ offset: 600 }]
  f.context.databasePageState.value = {
    requestedPage: 3,
    page: { offset: 600, revision: 7, versions: { 420: 1 } }
  }
  f.context.tableTracks.value = [duplicate]
  f.multi.toggle('view:5', 0)
  const selected = f.multi.getSelectedTracks()
  assert.equal(selected.length, 2)
  assert.deepEqual(selected.map(f.context.tableTrackKey), ['view:0', 'view:5'])
  assert.deepEqual(
    selected.map((track) => f.context.playlistDefinitionTrack(ref(track).value).id),
    ['old-id', 'old-duplicate']
  )
  assert.ok(selected.every((track) => track.id === '420'))
  for (const track of selected) {
    assert.equal(track.lyrics, null)
    assert.equal(track.translatedLyrics, undefined)
    assert.equal(track.bpmAnalysis, undefined)
    assert.equal(track.custom, undefined)
    assert.equal(track.cover, null)
    assert.equal(track.coverSmall, undefined)
    assert.deepEqual(clone(track.cueRange), { startSeconds: 10, endSeconds: 30 })
    assert.equal(track.cueSheetPath, 'D:/Music/disc.cue')
  }
  Object.assign(f.context, {
    currentPlaylistName: ref('歌单'),
    clearSelection: f.multi.clearSelection,
    removeTracksFromPlaylist: (name, ids) => f.calls.push(['definition-remove', name, ...ids])
  })
  install(f.context, ['removeActionTracksFromCurrentPlaylist'])
  f.context.databaseTableEnabled.value = false
  await f.context.removeActionTracksFromCurrentPlaylist(selected)
  assert.deepEqual(f.calls.at(-2), ['definition-remove', '歌单', 'old-id', 'old-duplicate'])
  assert.equal(f.multi.selectedCount.value, 0)
})

test('production selection clears synchronously on query/revision/retry fences, and storage changes', (t) => {
  const f = selectionFixture(t)
  f.multi.toggle('420', 0)
  f.context.databasePages.selectionEpoch.value++
  assert.equal(f.multi.selectedCount.value, 0)
  f.multi.toggle('420', 0)
  f.context.props.filter = 'other' // Props are reactive in the mounted component.
  f.context.debouncedSearchQuery.value = 'new search'
  assert.equal(f.multi.selectedCount.value, 0)
  f.multi.toggle('420', 0)
  f.context.databaseTableEnabled.value = false
  assert.equal(f.multi.selectedCount.value, 0)
})

test('locate checks SQL even when the current song is not loaded; continuous row numbers use global coordinates', () => {
  const f = fixture()
  f.context.locateCurrentTrack()
  assert.deepEqual(f.calls, [['locate', '420']])
  assert.equal(f.context.trackListNumber(f.track, 2), 407)
  f.context.isAlbumDetail.value = true
  assert.equal(f.context.trackListNumber({ ...f.track, trackNumber: 9 }, 2), 9)
})

test('page deletion submits selected identities without any full-library snapshot, and releases the renderer before trash', async () => {
  const f = fixture()
  await f.context.removeDatabaseFiles([f.track], 'trash')
  assert.equal(f.calls[0][0], 'prepare')
  assert.deepEqual(f.calls[1], [
    'remove',
    {
      mode: 'trash',
      items: [
        {
          id: '420',
          filePath: f.track.filePath,
          title: f.track.title,
          artist: f.track.artist,
          expectedVersion: 1,
          expectedInstance: 17
        }
      ]
    }
  ])
  assert.deepEqual(f.calls[2], ['unavailable', ['420', '421'], [f.track.filePath]])
  assert.deepEqual(f.calls[3], ['refresh', 10])
  f.context.window.api.library.database.removeFiles = async () => {
    throw new Error('reply lost')
  }
  await assert.rejects(f.context.removeDatabaseFiles([f.track], 'library'), /reply lost/)
  assert.deepEqual(f.calls.at(-1), ['refresh', undefined])
  assert.equal(
    f.calls.filter((call) => call[0] === 'remove').length,
    1,
    'unknown outcome must not be automatically replayed'
  )
})

test('metadata matching patches only changed fields with the selected version and preserves concurrent-edit conflicts', async (t) => {
  const f = fixture(),
    db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ ...f.track, custom: { keep: true } }]
  })
  const provider = {
    ...f.track,
    id: 'provider:420',
    artist: '周杰伦',
    album: '新专辑',
    lyrics: '词'
  }
  Object.assign(f.context, {
    syncPluginProviders: async () => {},
    searchMetadataTracks: async () => [provider],
    buildMetadataMatchCandidates: () => [
      { track: provider, confidence: 'high', score: 100, sourceLabel: 'Provider' }
    ],
    enrichLocalTrackMetadata,
    settingsStore: {
      settings: ref({ cachePolicy: { metadata: true, lyrics: true, cover: true } })
    },
    applyTrackMetadataMatch() {
      throw new Error('legacy full-library save')
    }
  })
  const patches = []
  f.context.window.api.library.database.patchTracks = async (entries) => {
    patches.push(clone(entries))
    return db.patchTracks(entries)
  }
  await f.context.handleMetadataRematch(f.track)
  assert.equal(patches[0][0].expectedVersion, 1)
  assert.equal(patches[0][0].patch.filePath, undefined)
  assert.equal(patches[0][0].patch.id, undefined)
  assert.equal(db.getTracksByIds(['420']).tracks[0].artist, '周杰伦')
  assert.deepEqual(db.getTracksByIds(['420']).tracks[0].custom, { keep: true })
  await f.context.handleMetadataRematch(f.track)
  assert.match(f.context.repairMessage.value, /changed concurrently/)
  assert.equal(db.getTracksByIds(['420']).versions['420'], 2)
})

test('a continuous cross-page window uses each row occurrence and version, including secondary-page playback and edits', async () => {
  const f = fixture()
  const secondary = { ...f.track, id: '421', title: 'Secondary' }
  const pages = [
    { offset: 0, revision: 7, tracks: [f.track], entryIds: ['0'], versions: { 420: 1 } },
    { offset: 200, revision: 7, tracks: [secondary], entryIds: ['5'], versions: { 421: 9 } }
  ]
  f.context.databaseWindowPages.value = pages
  f.context.databasePages.pageForTrack = (track) =>
    pages.find((page) => page.tracks.includes(track))
  f.context.databasePageState.value = { page: pages[0] }
  f.context.databasePlaylistState.value = { id: 'view' }
  f.context.databaseQuery.value = { playlistView: 'view', sort: 'playlist' }
  f.context.currentPlaylist.value = { trackIds: ['old-id', '', '', '', '', 'old-secondary'] }
  // Install all three production mappings, rather than reconstruct them in the fixture.
  for (const name of ['tableTracks', 'tableEntryIds', 'tableRowPositions']) {
    delete f.context[name]
    installComputed(f.context, name)
  }
  assert.equal(f.context.tableTrackKey(ref(secondary).value), 'view:5')
  assert.equal(f.context.playlistDefinitionTrack(secondary).id, 'old-secondary')
  assert.equal(vm.runInContext('tableRowPositions.value.get(tableTracks.value[1])', f.context), 200)
  f.context.playTableTrack(ref(secondary).value)
  assert.deepEqual(f.calls.at(-1), [
    'query',
    { playlistView: 'view', sort: 'playlist', contentRevision: 7, playlistEntryId: '5' },
    '421',
    {}
  ])
  Object.assign(f.context, {
    syncPluginProviders: async () => {},
    searchMetadataTracks: async () => [{ ...secondary, artist: 'Updated' }],
    buildMetadataMatchCandidates: (_track, candidates) => [{ track: candidates[0] }],
    enrichLocalTrackMetadata,
    settingsStore: { settings: ref({ cachePolicy: { metadata: true } }) }
  })
  const patches = []
  f.context.window.api.library.database.patchTracks = async (entries) => {
    patches.push(clone(entries))
    return { updated: ['421'] }
  }
  await f.context.handleMetadataRematch(ref(secondary).value)
  assert.equal(patches[0][0].id, '421')
  assert.equal(
    patches[0][0].expectedVersion,
    9,
    'the first page version is not the secondary row version'
  )
})

test('an evicted explicit selection retains its removal version rather than authorizing newer metadata', async () => {
  const f = fixture()
  const selected = f.context.snapshotSelectedTableTrack(f.track)
  f.context.tableTracks.value = []
  f.context.databasePageState.value = { page: null }
  await f.context.removeDatabaseFiles([selected], 'library')
  const sent = f.calls.find((call) => call[0] === 'remove')[1].items[0]
  assert.equal(sent.expectedVersion, 1)
  assert.equal(sent.id, f.track.id)
})

function tagFixture(mode = 'sqlite') {
  const f = fixture()
  Object.assign(f.context, {
    libraryStorage: { mode: ref(mode), error: ref('mode read failed'), load: async () => {} },
    pendingTagRecheckPaths: ref([]),
    tagRecheckPending: ref(false),
    libraryDirectoriesForFiles,
    scanLibraryDirectories: async (request) => {
      f.calls.push(['scoped', clone(request)])
      return { state: 'completed' }
    },
    applyLocalTagWrite: (...args) => {
      f.calls.push(['legacy-tags', ...clone(args)])
      return 2
    }
  })
  vm.runInContext('let tagRecheckGeneration = 0', f.context)
  install(f.context, ['applyTagManagerWrite', 'recheckWrittenTags'])
  return f
}

test('tag writes check only affected parent directories and never unexclude or start a whole-library scan', async () => {
  const f = tagFixture()
  await f.context.applyTagManagerWrite(
    ['D:/Music/a/one.wav', 'D:/Music/a/two.wav', 'D:/Music/b/three.wav'],
    { title: 'Edited' }
  )
  assert.deepEqual(f.calls, [
    ['scoped', { directories: ['D:/Music/a', 'D:/Music/b'], reason: 'tags' }]
  ])
  assert.equal(f.context.pendingTagRecheckPaths.value.length, 0)
  assert.equal(f.context.repairMessage.value, '标签检查已完成')
})

test('a second tag write during a check stays pending; explicit retry checks all affected directories', async () => {
  const f = tagFixture()
  let release
  f.context.scanLibraryDirectories = (request) => {
    f.calls.push(['scoped', clone(request)])
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const first = f.context.applyTagManagerWrite(['D:/Music/a/one.wav'], { title: 'One' })
  await Promise.resolve()
  await f.context.applyTagManagerWrite(['D:/Music/b/two.wav'], { title: 'Two' })
  release({ state: 'completed' })
  await first
  assert.equal(f.context.pendingTagRecheckPaths.value.length, 2)
  assert.equal(f.context.tagRecheckPending.value, false)
  f.context.scanLibraryDirectories = async (request) => {
    f.calls.push(['retry', clone(request)])
    return { state: 'completed' }
  }
  await f.context.recheckWrittenTags()
  assert.deepEqual(f.calls.at(-1), [
    'retry',
    { directories: ['D:/Music/a', 'D:/Music/b'], reason: 'tags' }
  ])
  assert.equal(f.context.pendingTagRecheckPaths.value.length, 0)
})

test('tag recheck admission failures keep an explicit retry, and discovery failure never selects the JSON write path', async () => {
  const f = tagFixture()
  f.context.scanLibraryDirectories = async () => {
    throw new Error('曲库扫描正在运行')
  }
  await f.context.applyTagManagerWrite(['D:/Music/a/one.wav'], { title: 'One' })
  assert.match(f.context.repairMessage.value, /扫描正在运行.*当前扫描结束后重试/)
  assert.equal(f.context.pendingTagRecheckPaths.value.length, 1)
  assert.equal(f.context.tagRecheckPending.value, false)
  const unknown = tagFixture(null)
  await unknown.context.applyTagManagerWrite(['D:/Music/a/one.wav'], { title: 'One' })
  assert.deepEqual(unknown.calls, [])
  assert.match(unknown.context.repairMessage.value, /无法确认曲库存储/)
  const legacy = tagFixture('json')
  await legacy.context.applyTagManagerWrite(['D:/Music/a/one.wav'], { title: 'One' })
  assert.deepEqual(legacy.calls, [['legacy-tags', ['D:/Music/a/one.wav'], { title: 'One' }]])
})

test('database collection grids consume summaries without touching compatibility collections or re-filtering missing members', () => {
  const never = {
    get value() {
      throw new Error('complete compatibility collection accessed')
    }
  }
  const summaries = [{ id: 'release', name: 'Other album', trackCount: 405, duration: 90000 }]
  const context = vm.createContext({
    computed,
    props: { category: 'albums' },
    databaseGridKind: ref('albums'),
    databaseGridEnabled: ref(true),
    libraryStorage: { mode: ref('sqlite') },
    databaseCollectionState: shallowRef({ page: { items: summaries } }),
    isCollectionGrid: ref(true),
    collectionGridItems: never,
    genres: never,
    folders: never,
    localPlaylistOrder: { playlists: never },
    filterLocalGridItems,
    serverFiltered: ref(true),
    debouncedSearchQuery: ref('Needle song')
  })
  installComputed(context, 'currentGridItems')
  const helper = readFileSync(new URL('./useSongListGridRendering.ts', import.meta.url), 'utf8')
  installComputed(
    context,
    'filteredGridItems',
    helper.slice(0, helper.indexOf('  const leadingSlotCount')) + '\n\n'
  )
  assert.deepEqual(clone(vm.runInContext('filteredGridItems.value', context)), summaries)
  context.libraryStorage.mode.value = null
  context.databaseCollectionState.value = { page: null }
  assert.equal(vm.runInContext('currentGridItems.value.length', context), 0)
})

test('A-Z jumps use absolute continuous positions without waiting for a page-local index', () => {
  const calls = []
  const context = vm.createContext({
    isCollectionGrid: ref(true),
    databaseGridEnabled: ref(true),
    activeCollectionLetter: ref(null),
    collectionLetterDisabled: (letter) => letter !== 'Z',
    databaseCollections: { letterOffsets: ref({ A: 0, Z: 420 }) },
    renderGridThroughIndex: (index) => calls.push(index),
    firstCollectionIndexForLetter() {
      throw new Error('page-only A-Z lookup')
    }
  })
  install(context, ['jumpToCollectionLetter'])
  context.jumpToCollectionLetter('Z')
  assert.deepEqual(calls, [420])
  assert.equal(context.activeCollectionLetter.value, 'Z')
  context.jumpToCollectionLetter('X')
  assert.deepEqual(calls, [420])
})

test('the active A-Z letter survives unloaded windows and follows the authoritative reverse order', () => {
  const context = vm.createContext({
    isCollectionGrid: ref(true),
    databaseGridEnabled: ref(true),
    activeCollectionLetter: ref(null),
    scrollTop: ref(12800),
    gridOffsetTop: ref(200),
    gridColumns: ref(4),
    gridRowStride: ref(240),
    databaseCollections: { letterOffsets: ref({ Z: 0, M: 160, A: 420 }) }
  })
  install(context, ['updateActiveCollectionLetter'])
  context.updateActiveCollectionLetter()
  assert.equal(context.activeCollectionLetter.value, 'M')
  context.scrollTop.value = 28000
  context.updateActiveCollectionLetter()
  assert.equal(context.activeCollectionLetter.value, 'A')
})

test('playlist keyboard reordering includes unloaded matching neighbors and preserves hidden configured slots', () => {
  const playlists = Array.from({ length: 405 }, (_, i) => ({
    id: String(i),
    name: i === 200 ? 'Other' : 'Mix ' + i
  }))
  const moves = []
  const context = vm.createContext({
    computed,
    databaseGridEnabled: ref(true),
    debouncedSearchQuery: ref('Mix'),
    normalizeSearchText: (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''),
    localPlaylistOrder: { playlists: ref(playlists), move: (...args) => moves.push(clone(args)) },
    filteredGridItems: ref(playlists.slice(0, 200))
  })
  installComputed(context, 'localPlaylistReorderEntries')
  install(context, ['localPlaylistKeydown'])
  const target = {}
  context.localPlaylistKeydown(
    { target, currentTarget: target, altKey: true, key: 'ArrowDown', preventDefault() {} },
    playlists[199]
  )
  assert.equal(moves[0][0], '199')
  assert.equal(moves[0][1], '201')
  assert.equal(moves[0][2].length, 404)
  assert.equal(
    moves[0][2].some((item) => item.id === '200'),
    false
  )
})

test('opening album versions reads an unfiltered authoritative track even when the table has no loaded members', async () => {
  const f = fixture()
  const queries = []
  Object.assign(f.context, {
    props: { category: 'albums', filter: 'album:release-id' },
    currentLibraryViewKey: ref('albums:release-id'),
    isAlbumDetail: ref(true),
    musicVersionsOpening: ref(false),
    musicVersionsInitialTrack: shallowRef(),
    showMusicVersions: ref(false),
    libraryToolsMenuOpen: ref(true),
    libraryStorage: { mode: ref('sqlite') },
    libraryTrack: (record) => record
  })
  f.context.window.api.library.database.queryTracks = async (query) => {
    queries.push(clone(query))
    return { tracks: [f.track] }
  }
  install(f.context, ['openMusicVersions'])
  await f.context.openMusicVersions()
  assert.deepEqual(queries, [{ albumId: 'release-id', sort: 'trackNumber', limit: 1 }])
  assert.equal(f.context.showMusicVersions.value, true)
  assert.equal(f.context.musicVersionsInitialTrack.value.id, f.track.id)
  f.context.showMusicVersions.value = false
  f.context.window.api.library.database.queryTracks = async () => {
    f.context.currentLibraryViewKey.value = 'artists:another'
    return { tracks: [f.track] }
  }
  await f.context.openMusicVersions()
  assert.equal(f.context.showMusicVersions.value, false)
  assert.equal(f.context.musicVersionsOpening.value, false)
})

test('last-played pages wait for confirmed SQL history and never fall back to the full compatibility tracks', () => {
  const never = {
    get value() {
      throw new Error('full compatibility tracks accessed')
    }
  }
  const view = { ...createDefaultLibraryViewState('allSongs'), sortKey: 'lastPlayed' }
  const context = vm.createContext({
    computed,
    props: { category: 'allSongs', previewTracks: undefined },
    tracks: never,
    albums: never,
    databaseTableCandidate: ref(true),
    databaseTableEnabled: ref(true),
    libraryStorage: { mode: ref('sqlite') },
    databaseHistoryReady: ref(false),
    databaseHistoryRequested: ref(true),
    databaseHistoryRevision: ref(undefined),
    databaseDetailScope: ref({}),
    isPlaylistDetail: ref(false),
    libraryTrackQuery,
    libraryViewState: ref(view),
    debouncedSearchQuery: ref('moon'),
    settingsStore: { settings: ref({ genreSeparators: '/' }) }
  })
  installComputed(context, 'baseDisplayTracks')
  installComputed(context, 'databaseQuery')
  assert.equal(vm.runInContext('baseDisplayTracks.value.length', context), 0)
  assert.equal(vm.runInContext('databaseQuery.value', context), null)
  context.databaseHistoryReady.value = true
  context.databaseHistoryRevision.value = 7
  const query = clone(vm.runInContext('databaseQuery.value', context))
  assert.equal(query.sort, 'lastPlayed')
  assert.equal(query.historyRevision, 7)
  assert.equal(query.search, 'moon')
})

test('playlist playback freezes the full query and selects the exact occurrence; edits address the original configured member', () => {
  const f = fixture()
  const duplicate = { ...f.track }
  f.context.tableTracks.value = [f.track, duplicate]
  f.context.tableEntryIds.value = new Map([
    [f.track, '0'],
    [duplicate, '5']
  ])
  f.context.databasePlaylistState.value = { id: 'view' }
  f.context.databaseQuery.value = { playlistView: 'view', sort: 'playlist' }
  f.context.currentPlaylist.value = {
    trackIds: ['old-id', 'missing', 'other', 'other', 'other', 'old-duplicate']
  }
  assert.equal(f.context.tableTrackKey(f.track), 'view:0')
  assert.equal(f.context.tableTrackKey(duplicate), 'view:5')
  f.context.playTableTrack(ref(duplicate).value)
  assert.deepEqual(f.calls.at(-1), [
    'query',
    {
      playlistView: 'view',
      sort: 'playlist',
      contentRevision: 7,
      playlistEntryId: '5'
    },
    '420',
    {}
  ])
  assert.equal(f.context.playlistDefinitionTrack(ref(duplicate).value).id, 'old-duplicate')
  assert.equal(duplicate.id, '420')
  f.context.playAllTracks()
  assert.deepEqual(f.calls.at(-1), [
    'query',
    { playlistView: 'view', sort: 'playlist', contentRevision: 7 },
    null,
    {}
  ])
  f.context.databasePageState.value = { page: null }
  const count = f.calls.length
  f.context.playTableTrack(duplicate)
  f.context.playAllTracks()
  f.context.shufflePlayTracks()
  assert.equal(f.calls.length, count, 'loading/replaced pages cannot start an old array or query')
})

test('occurrence mapping does not traverse complete JSON arrays or ordinary library pages', () => {
  const context = vm.createContext({
    computed,
    databaseTableEnabled: ref(false),
    databaseWindowPages: shallowRef([]),
    tableTracks: {
      get value() {
        throw new Error('complete-array walk')
      }
    }
  })
  installComputed(context, 'tableEntryIds')
  assert.equal(vm.runInContext('tableEntryIds.value.size', context), 0)
  context.databaseTableEnabled.value = true
  context.databaseWindowPages.value = [{ tracks: [], entryIds: undefined }]
  assert.equal(vm.runInContext('tableEntryIds.value.size', context), 0)
})

test('an expired view first encountered on play rebuilds the view without replaying a queue mutation', () => {
  const f = fixture(),
    recovered = []
  f.context.databasePlaylistView = {
    recover: (id, error) => {
      recovered.push([id, error.message])
      return true
    }
  }
  f.context.databaseQuery.value = { playlistView: 'expired', sort: 'playlist' }
  let attempts = 0
  f.context.playbackStore.playLibraryQuery = (_query, _id, options) => {
    attempts++
    options.onQueryFailure(new Error('Playlist view expired; rebuild'))
    return Promise.resolve()
  }
  f.context.playTableTrack(f.track)
  assert.equal(attempts, 1)
  assert.deepEqual(recovered, [['expired', 'Playlist view expired; rebuild']])
  assert.match(f.context.repairMessage.value, /完成后请重新播放/)
})

test('playlist grids wait for the catalog, read only summary pages, and keep order outside the membership upload', () => {
  const context = vm.createContext({
    computed,
    props: { category: 'playlists', previewTracks: null },
    showGrid: ref(true),
    isCollectionGrid: ref(false),
    libraryStorage: { mode: ref('sqlite') },
    databaseCatalogState: shallowRef({ id: null, pending: true, error: '' }),
    databaseCollectionState: shallowRef({ page: null, loading: false, error: '', total: null }),
    debouncedSearchQuery: ref('Mix'),
    localPlaylistOrder: { playlists: shallowRef([{ id: 'b' }, { id: 'a' }]) },
    formatPlaylistSourceSummary,
    summarizePlaylistSources
  })
  for (const name of [
    'databaseGridKind',
    'databaseGridEnabled',
    'databaseGridSelection',
    'databaseGridPending',
    'currentGridItems'
  ])
    installComputed(context, name)
  assert.equal(vm.runInContext('databaseGridKind.value', context), 'playlists')
  assert.equal(vm.runInContext('databaseGridSelection.value.kind', context), null)
  assert.equal(vm.runInContext('databaseGridPending.value', context), true)
  assert.deepEqual(clone(vm.runInContext('currentGridItems.value', context)), [])
  context.databaseCatalogState.value = { id: 'catalog', pending: false, error: '' }
  assert.deepEqual(clone(vm.runInContext('databaseGridSelection.value', context)), {
    kind: 'playlists',
    query: { search: 'Mix', playlistView: 'catalog', collectionOrder: ['b', 'a'] }
  })
  const card = {
    id: 'a',
    name: 'Mix',
    trackCount: 607,
    sourceSummary: {
      total: 607,
      local: 606,
      provider: 1,
      providers: [{ source: 'network', count: 1 }]
    }
  }
  context.databaseCollectionState.value = { page: { items: [card] }, loading: false }
  install(context, ['playlistSourceSummaryLabel'])
  assert.equal(vm.runInContext('currentGridItems.value[0].trackCount', context), 607)
  assert.equal(context.playlistSourceSummaryLabel(card), '本地 606 · Provider 1 · network')
  context.localPlaylistOrder.playlists.value = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(
    clone(vm.runInContext('databaseGridSelection.value.query.collectionOrder', context)),
    ['a', 'b']
  )
  context.libraryStorage.mode.value = 'json'
  assert.equal(vm.runInContext('databaseGridSelection.value.kind', context), null)
  assert.deepEqual(clone(vm.runInContext('currentGridItems.value', context)), [
    { id: 'a' },
    { id: 'b' }
  ])
})
