import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { computed, effectScope, ref, shallowRef, toRaw, watch, reactive, nextTick } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { LibrarySelectionService } from '../../../../main/library/librarySelectionService.ts'
import { useMusicStore } from '../../stores/useMusicStore.ts'
import { toPlaylistTrackSnapshot } from '../../stores/library/musicStoreData.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { getTrackSource } from '../../utils/logicalTrackModel.ts'
import { addSelectionRange } from '../../../../shared/librarySelectionRanges.ts'
import { usePlaylistLifecycleActions } from './usePlaylistLifecycleActions.ts'
import { useTrackMultiSelect } from './useTrackMultiSelect.ts'
import {
  createSongListActionSource,
  readSongListTagTargets,
  readSongListLoudnessTargets
} from './songListActionSource.ts'
import { buildLibraryLoudnessDatabasePlan } from '../library-loudness/libraryLoudnessDatabasePlan.ts'
import { copyTrackNamePages } from '../../utils/copyTrackNames.ts'

const script = stripTypeScriptTypes(
  readFileSync(new URL('../SongList.vue', import.meta.url), 'utf8')
    .split('<script setup lang="ts">')[1]
    .split('</script>')[0]
)
function install(context, names) {
  for (const name of names) {
    const start = script.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
    const end = script.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start, name)
    vm.runInContext(script.slice(start, end + 2), context)
  }
}
function installComputed(context, name) {
  const start = script.indexOf(`const ${name} = computed`)
  const next = script.slice(start).search(/\r?\n(?:\r?\n|(?=(?:const|let|function)\s))/)
  assert.ok(start >= 0 && next > 0, name)
  vm.runInContext(script.slice(start, start + next), context)
}
function fixture(t, count = 605, extra = () => ({})) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      filePath: `D:/actions/${i}.flac`,
      title: `T${i}`,
      artist: 'Artist',
      album: `A${Math.floor(i / 10)}`,
      duration: 180,
      ...extra(i)
    }))
  })
  const store = useMusicStore()
  store.clearTracks()
  store.playlists.value = []
  const calls = [],
    commands = []
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const service = new LibrarySelectionService({
    createTrackSelection: async (request) => db.createTrackSelection(request),
    readTrackSelection: async (...args) => db.readTrackSelection(...args),
    closeTrackSelection: async (id) => db.closeTrackSelection(id)
  })
  const api = {
    library: {
      database: {
        selection: async (command) => {
          commands.push(command)
          return service.handle(owner, command)
        },
        queryTracks: async (query) => db.queryTracks(query),
        queryCollections: async (...args) => db.queryCollections(...args),
        getMetadata: async () => db.getMetadata(),
        removeFiles: async (request) => {
          calls.push(['remove', request])
          return {
            mode: request.mode,
            metadata: { revision: db.getMetadata().revision + 1 },
            removedTrackIds: request.items.map((item) => item.id),
            removedFilePaths: request.items.map((item) => item.filePath),
            failures: []
          }
        }
      }
    },
    data: { savePlaylists: async () => {} }
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
  const page = db.queryTracks({ sort: 'insertion', limit: 200 })
  const loaded = page.tracks.map(libraryTrack)
  const multi = {
    selectionVersion: ref(1),
    getSelectedRanges: () => [[0, count]],
    getSelectedTracks: () => {
      throw new Error('full SQL selection materialized')
    }
  }
  const c = vm.createContext({
    ...store,
    Error,
    Map,
    Set,
    AbortController,
    JSON,
    computed,
    toRaw,
    structuredClone,
    getTrackSource,
    createSongListActionSource,
    readSongListTagTargets,
    readSongListLoudnessTargets,
    copyTrackNamePages,
    toPlaylistTrackSnapshot,
    addSelectionRange,
    window: {
      api,
      confirm: (prompt) => {
        calls.push(['confirm', prompt])
        return true
      },
      alert: (text) => calls.push(['alert', text])
    },
    document: { activeElement: null },
    HTMLElement: class {},
    currentLibraryViewKey: ref('allSongs'),
    libraryStorage: { mode: ref('sqlite') },
    databaseQuery: shallowRef({ sort: 'insertion' }),
    databasePageState: shallowRef({ page, total: count }),
    databaseTableEnabled: ref(true),
    databasePages: { invalidate: (revision) => calls.push(['invalidate', revision]) },
    tableRowPositions: shallowRef(new Map(loaded.map((row, i) => [row, i]))),
    selectedTableRows: new WeakMap(),
    multiSelect: multi,
    getSelectedTracks: multi.getSelectedTracks,
    currentPlaylist: shallowRef(null),
    currentPlaylistName: ref('source'),
    pendingBatchCreateSource: shallowRef(null),
    showCreatePlaylistDialog: ref(false),
    newPlaylistName: ref('New'),
    createAggregateSource: shallowRef(null),
    showCreateAggregateDialog: ref(false),
    repairMessage: ref(''),
    libraryMutationPending: ref(false),
    tagManagerTracks: shallowRef([]),
    tagManagerContentRevision: ref(null),
    tagManagerInitialView: ref('edit'),
    tagManagerFocusRestoreTarget: ref(null),
    showTagManager: ref(false),
    clearSelection: () => {
      calls.push(['clear'])
      multi.selectionVersion.value++
    },
    closeContextMenu: () => calls.push(['close']),
    completeCreatePlaylistDialog: () => {
      c.showCreatePlaylistDialog.value = false
    },
    openCreatePlaylistDialog: () => {
      c.showCreatePlaylistDialog.value = true
    },
    prepareLocalTracksForRemoval: async (...args) => calls.push(['prepare', ...args]),
    notifyLocalTracksUnavailable: (...args) => calls.push(['unavailable', ...args]),
    playbackStore: {
      appendLibraryQueuePages: async (produce, _, options) => {
        await produce(async (items) => {
          options.guard()
          calls.push(['queue', items])
        })
        options.guard()
      }
    }
  })
  vm.runInContext('let activeSelectionAction = null', c)
  install(c, [
    'captureActionSource',
    'withActionSource',
    'appendActionTracksToQueue',
    'favoriteActionTracks',
    'removeActionTracksFromCurrentPlaylist',
    'addActionTracksToPlaylist',
    'addActionSourceToPlaylist',
    'runLocalLibraryRemoval',
    'removeDatabaseSelectionFiles',
    'openTagManager',
    'handleBatchCreatePlaylistFromMenu',
    'handleConfirmCreatePlaylist',
    'dismissCreatePlaylistDialog',
    'createSelectedAggregatePlaylist',
    'dismissCreateAggregateDialog'
  ])
  t.after(async () => {
    await store.flushPlaylists()
    store.playlists.value = []
    owner.emit('destroyed')
    await Promise.resolve()
    db.close()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  return { c, db, store, api, calls, commands, multi, loaded, owner }
}

test('production queue action streams the entire SQL selection, closes its lease and clears only the same intent', async (t) => {
  const f = fixture(t)
  await f.c.appendActionTracksToQueue()
  assert.deepEqual(
    f.calls.filter(([kind]) => kind === 'queue').map(([, items]) => items.length),
    [200, 200, 200, 5]
  )
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        f.calls
          .filter(([kind]) => kind === 'queue')
          .at(-1)[1]
          .at(-1)
      )
    ),
    { id: '604' }
  )
  assert.equal(f.calls.filter(([kind]) => kind === 'clear').length, 1)
  assert.equal(f.commands.at(-1).kind, 'close')
  assert.equal(f.owner.listenerCount('destroyed'), 0)
  f.c.playbackStore.appendLibraryQueuePages = async (produce) => {
    await produce(async () => {
      f.multi.selectionVersion.value++
    })
  }
  await f.c.appendActionTracksToQueue()
  assert.equal(
    f.calls.filter(([kind]) => kind === 'clear').length,
    1,
    'later selection survives late success'
  )
})

test('the actual production binding selects the whole result and shifts across unloaded windows without retaining selected Tracks', async (t) => {
  const f = fixture(t)
  Object.assign(f.c, {
    useTrackMultiSelect,
    tableTracks: shallowRef(f.loaded),
    tableTrackCount: ref(605),
    tableEntryIds: shallowRef(new Map()),
    databasePlaylistState: shallowRef({ id: null }),
    containerRef: ref(null),
    recentSource: ref('all'),
    debouncedSearchQuery: ref(''),
    props: { category: 'allSongs' },
    showTable: ref(true),
    databaseWindowPages: shallowRef([{ offset: 0 }]),
    snapshotSelectedTableTrack: () => {
      throw new Error('query selection cached a Track')
    }
  })
  f.c.databasePages.selectionEpoch = ref(0)
  install(f.c, ['tableTrackKey'])
  installComputed(f.c, 'databaseQuerySelection')
  const start = script.indexOf('const multiSelect = useTrackMultiSelect('),
    end = script.indexOf('\n})', start)
  const scope = effectScope()
  t.after(() => scope.stop())
  scope.run(() => vm.runInContext(script.slice(start, end + 3), f.c))
  const selection = vm.runInContext('multiSelect', f.c)
  f.c.clearSelection = selection.clearSelection
  selection.selectAll()
  assert.equal(selection.selectedCount.value, 605)
  assert.deepEqual(selection.getSelectedRanges(), [[0, 605]])
  assert.throws(selection.getSelectedTracks, /异步批次/)
  await f.c.appendActionTracksToQueue()
  assert.equal(
    f.calls.filter(([kind]) => kind === 'queue').reduce((n, [, items]) => n + items.length, 0),
    605
  )
  selection.toggle('15', 15, f.loaded[15])
  const last = libraryTrack(f.db.getTracksByIds(['604']).tracks[0])
  f.c.tableTracks.value = [last]
  f.c.tableRowPositions.value = new Map([[last, 604]])
  f.c.databaseWindowPages.value = [{ offset: 600 }]
  selection.onRowClick(last, 0, { shiftKey: true })
  assert.equal(selection.selectedCount.value, 590)
  assert.deepEqual(selection.getSelectedRanges(), [[15, 605]])
  f.c.databasePages.selectionEpoch.value++
  assert.equal(selection.selectedCount.value, 0)
})

test('the actual favorite action reads complete state, rather than the loaded 200-row prefix', async (t) => {
  const f = fixture(t)
  f.store.playlists.value = [
    {
      id: 'fav',
      name: 'Favorite',
      isDefault: true,
      createdAt: '',
      trackIds: f.loaded.map((row) => row.id),
      trackSnapshots: Object.fromEntries(f.loaded.map((row) => [row.id, row]))
    }
  ]
  await f.c.favoriteActionTracks()
  assert.equal(f.store.playlists.value[0].trackIds.length, 605)
  assert.match(f.c.repairMessage.value, /已加入应用收藏 405 首/)
  assert.equal(
    f.commands.filter((command) => command.kind === 'read').length,
    8,
    'summary and mutation share one frozen lease'
  )
  await f.c.favoriteActionTracks()
  assert.equal(f.store.playlists.value[0].trackIds.length, 0)
  assert.match(f.c.repairMessage.value, /已移出应用收藏 605 首/)
})

test('file confirmation uses frozen physical count, sends version+incarnation and continues after its own invalidation', async (t) => {
  const f = fixture(t, 605, (i) =>
    i === 604
      ? { filePath: 'd:\\actions\\0.flac', cueRange: { startSeconds: 10, endSeconds: 20 } }
      : {}
  )
  f.c.databasePages.invalidate = () => {
    f.multi.selectionVersion.value++
  }
  await f.c.runLocalLibraryRemoval('trash')
  assert.match(f.calls.find(([kind]) => kind === 'confirm')[1], /604 个本地文件/)
  const batches = f.calls.filter(([kind]) => kind === 'remove').map(([, request]) => request.items)
  assert.deepEqual(
    batches.map((items) => items.length),
    [200, 200, 200, 4]
  )
  assert.ok(
    batches
      .flat()
      .every((item) => item.expectedVersion === 1 && Number.isInteger(item.expectedInstance))
  )
  assert.equal(f.calls.filter(([kind]) => kind === 'prepare').length, 4)
  assert.equal(f.calls.filter(([kind]) => kind === 'unavailable').length, 4)
  assert.equal(f.commands.at(-1).kind, 'close')
  assert.equal(f.calls.filter(([kind]) => kind === 'clear').length, 0)
})

test('cancelling confirmation preserves selection; an unknown removal stops immediately and is not replayed', async (t) => {
  const f = fixture(t)
  f.c.window.confirm = () => false
  await f.c.runLocalLibraryRemoval('library')
  assert.equal(f.calls.filter(([kind]) => kind === 'clear').length, 0)
  assert.equal(f.commands.at(-1).kind, 'close')
  f.c.window.confirm = () => true
  const remove = f.api.library.database.removeFiles
  let attempts = 0
  f.api.library.database.removeFiles = async (request) => {
    if (++attempts === 2) throw new Error('reply lost')
    return remove(request)
  }
  await f.c.runLocalLibraryRemoval('library')
  assert.equal(attempts, 2)
  assert.match(f.c.repairMessage.value, /已确认移除 200 首.*reply lost/)
  assert.equal(f.commands.at(-1).kind, 'close')
})

test('ordinary add/remove/create and aggregate creation consume full pages with an empty renderer library', async (t) => {
  const f = fixture(t)
  const playlist = { id: 'source', name: 'source', trackIds: [], createdAt: '' }
  f.store.playlists.value = [playlist]
  f.c.currentPlaylist.value = playlist
  await f.c.addActionTracksToPlaylist('source')
  assert.equal(f.store.playlists.value[0].trackIds.length, 605)
  await f.c.removeActionTracksFromCurrentPlaylist()
  assert.equal(f.store.playlists.value[0].trackIds.length, 0)
  f.c.handleBatchCreatePlaylistFromMenu()
  await f.c.handleConfirmCreatePlaylist()
  assert.equal(f.store.playlists.value.at(-1).trackIds.length, 605)
  assert.equal(f.c.showCreatePlaylistDialog.value, false)
  f.c.createAggregateSource.value = f.c.captureActionSource()
  f.c.showCreateAggregateDialog.value = true
  const result = await f.c.createSelectedAggregatePlaylist('Aggregate')
  assert.equal(result.addedCount, 605)
  assert.equal(
    f.store.playlists.value.find((item) => item.id === result.playlistId).kind,
    'aggregate'
  )
  assert.equal(f.store.tracks.value.length, 0)
})

test('production actions preserve repeated playback rows and remote snapshots, while playlist removal uses original configured IDs', async (t) => {
  const f = fixture(t, 1)
  const local = f.db.getTracksByIds(['0']).tracks[0]
  const remote = {
    id: 'ncm:7',
    filePath: 'ncm:7',
    title: 'Remote',
    artist: 'Other',
    album: 'Remote',
    source: 'ncm',
    streamUrl: 'transient-secret'
  }
  const definitions = ['definition:0', 'definition:duplicate', remote.id]
  const snapshots = [{ ...local, id: definitions[0] }, { ...local, id: definitions[1] }, remote]
  f.db.syncPlaylistView({ kind: 'begin', id: 'mixed-action', versions: [] })
  f.db.syncPlaylistView({
    kind: 'append',
    id: 'mixed-action',
    sequence: 1,
    entries: definitions.map((id, i) => ({ id, snapshot: snapshots[i] }))
  })
  f.db.syncPlaylistView({ kind: 'commit', id: 'mixed-action', sequence: 2 })
  const query = { playlistView: 'mixed-action', sort: 'playlist' }
  const page = f.db.queryTracks(query)
  assert.deepEqual(
    page.tracks.map((row) => row.id),
    ['0', '0', 'ncm:7']
  )
  f.c.databaseQuery.value = query
  f.c.databasePageState.value = { page, total: 3 }
  f.multi.getSelectedRanges = () => [[0, 3]]
  const playlist = {
    id: 'source',
    name: 'source',
    createdAt: '',
    trackIds: definitions,
    trackSnapshots: Object.fromEntries(snapshots.map((row) => [row.id, libraryTrack(row)]))
  }
  f.store.playlists.value = [playlist]
  f.c.currentPlaylist.value = playlist
  await f.c.appendActionTracksToQueue()
  const items = f.calls.find(([kind]) => kind === 'queue')[1]
  assert.deepEqual(
    items.map((item) => item.id),
    ['0', '0', 'ncm:7']
  )
  assert.equal(items[2].snapshot.source, 'ncm')
  assert.equal(items[2].snapshot.streamUrl, undefined)
  await f.c.removeActionTracksFromCurrentPlaylist()
  assert.equal(f.store.playlists.value[0].trackIds.length, 0)
})

test('closing a create dialog during the last page prevents publication, without reopening the source', async (t) => {
  const f = fixture(t)
  f.c.handleBatchCreatePlaylistFromMenu()
  const read = f.api.library.database.selection
  f.api.library.database.selection = async (command) => {
    const reply = await read(command)
    if (reply.kind === 'page' && reply.page.nextCursor === null) f.c.dismissCreatePlaylistDialog()
    return reply
  }
  await f.c.handleConfirmCreatePlaylist()
  assert.equal(f.store.playlists.value.length, 0)
  assert.match(f.c.repairMessage.value, /创建歌单已取消/)
  assert.equal(f.commands.at(-1).kind, 'close')
})

test('playlist lifecycle reorder, drag and move use the same frozen source, not synchronous selected arrays', async (t) => {
  const f = fixture(t)
  const source = {
    id: 'source',
    name: 'source',
    createdAt: '',
    trackIds: Array.from({ length: 605 }, (_, i) => String(i))
  }
  const target = { id: 'target', name: 'target', createdAt: '', trackIds: [] }
  f.store.playlists.value = [source, target]
  f.c.currentPlaylist.value = source
  f.c.currentPlaylist = computed(() => f.store.playlists.value.find((item) => item.id === 'source'))
  f.multi.getSelectedRanges = () => [[400, 605]]
  const scope = effectScope()
  t.after(() => scope.stop())
  const actions = scope.run(() =>
    usePlaylistLifecycleActions({
      currentPlaylist: f.c.currentPlaylist,
      isPlaylistDetail: ref(true),
      repairMessage: f.c.repairMessage,
      getSelectedTracks: () => {
        throw new Error('synchronous SQL selection')
      },
      isSelected: () => {
        throw new Error('legacy selection predicate')
      },
      clearSelection: f.c.clearSelection,
      selectPlaylist() {},
      streamingSelection: {
        enabled: () => true,
        capture: () => f.c.captureActionSource(),
        run: f.c.withActionSource
      }
    })
  )
  await actions.handleMoveSelectedWithinPlaylist(false)
  assert.deepEqual(f.store.playlists.value[0].trackIds.slice(0, 2), ['400', '401'])
  actions.handlePlaylistDragStart({ dataTransfer: { setData() {} } }, f.loaded[0])
  await actions.handlePlaylistDrop({ preventDefault() {} }, f.loaded[1])
  assert.equal(f.store.playlists.value[0].trackIds.indexOf('400'), 1)
  actions.handleMoveSelectedToPlaylist()
  await actions.confirmPlaylistDialog('target')
  assert.equal(f.store.playlists.value[0].trackIds.length, 400)
  assert.equal(f.store.playlists.value[1].trackIds.length, 205)
  assert.equal(actions.playlistDialog.value, null)
  assert.equal(f.store.tracks.value.length, 0)
})

test('closing a pending move dialog fences both playlist publications at the final page', async (t) => {
  const f = fixture(t)
  const source = {
    id: 'source',
    name: 'source',
    createdAt: '',
    trackIds: Array.from({ length: 605 }, (_, i) => String(i))
  }
  f.store.playlists.value = [source, { id: 'target', name: 'target', trackIds: [], createdAt: '' }]
  f.c.currentPlaylist.value = source
  const scope = effectScope()
  t.after(() => scope.stop())
  const actions = scope.run(() =>
    usePlaylistLifecycleActions({
      currentPlaylist: f.c.currentPlaylist,
      isPlaylistDetail: ref(true),
      repairMessage: f.c.repairMessage,
      getSelectedTracks: f.multi.getSelectedTracks,
      isSelected: () => false,
      clearSelection: f.c.clearSelection,
      selectPlaylist() {},
      streamingSelection: {
        enabled: () => true,
        capture: f.c.captureActionSource,
        run: f.c.withActionSource
      }
    })
  )
  actions.handleMoveSelectedToPlaylist()
  const selection = f.api.library.database.selection
  f.api.library.database.selection = async (command) => {
    const reply = await selection(command)
    if (reply.kind === 'page' && reply.page.nextCursor === null) actions.dismissPlaylistDialog()
    return reply
  }
  await actions.confirmPlaylistDialog('target')
  assert.equal(f.store.playlists.value[0].trackIds.length, 605)
  assert.equal(f.store.playlists.value[1].trackIds.length, 0)
  assert.match(f.c.repairMessage.value, /对话框已关闭/)
  assert.equal(f.commands.at(-1).kind, 'close')
})

test('tag opening is bounded, uses physical targets and rejects shared CUE files before opening the editor', async (t) => {
  const f = fixture(t)
  await f.c.openTagManager('edit')
  assert.equal(f.c.tagManagerTracks.value.length, 605)
  assert.equal(f.c.showTagManager.value, true)
  f.c.showTagManager.value = false
  f.multi.getSelectedRanges = () => [[0, 1]]
  f.db.patchTracks([
    { id: '0', expectedVersion: 1, patch: { cueRange: { startSeconds: 0, endSeconds: 10 } } }
  ])
  f.c.databasePageState.value = { page: f.db.queryTracks({ limit: 1 }), total: 605 }
  await f.c.openTagManager('edit')
  assert.equal(f.c.showTagManager.value, false)
  assert.match(f.c.repairMessage.value, /CUE/)
})

test('tag cap rejects over 1000 files before reading details; stream failure poisons the action and closes its lease', async (t) => {
  const f = fixture(t, 1001)
  const source = f.c.captureActionSource()
  const lease = await source.open()
  await assert.rejects(readSongListTagTargets(lease), /1000/)
  assert.equal(f.commands.filter((command) => command.kind === 'read').length, 0)
  await assert.rejects(
    lease.forEachPage(() => {
      throw new Error('consumer failed')
    }),
    /consumer failed/
  )
  await assert.rejects(
    lease.forEachPage(() => {}),
    /中断/
  )
  await lease.close()
  await assert.rejects(source.open(), /已使用/)
})

test('copy streams formatted text, with a final guard before writing the clipboard', async (t) => {
  const f = fixture(t)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const text = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value) => text.push(value) } }
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  })
  const source = f.c.captureActionSource(),
    lease = await source.open()
  try {
    await copyTrackNamePages(lease.tracks)
  } finally {
    await lease.close()
  }
  assert.equal(text[0].split('\n').length, 605)
  assert.equal(text[0].split('\n').at(-1), 'T604 - Artist')
  await assert.rejects(
    copyTrackNamePages(async (append) => {
      await append([{ title: 'a', artist: 'b' }])
      return () => {
        throw new Error('selection changed')
      }
    }),
    /selection changed/
  )
  assert.equal(text.length, 1)
})

test('loudness expands through complete authoritative albums, keeps CUE intervals and refuses 257-member albums', async (t) => {
  const f = fixture(t, 258, (i) => ({
    album: i < 257 ? 'Large' : 'Small',
    ...(i === 257 ? { cueRange: { startSeconds: 5, endSeconds: 15 } } : {})
  }))
  const revision = f.db.getMetadata().revision
  const small = libraryTrack(f.db.getTracksByIds(['257']).tracks[0])
  const plan = await buildLibraryLoudnessDatabasePlan(
    f.api.library.database,
    [small],
    revision,
    'album'
  )
  assert.equal(plan.trackCount, 1)
  assert.deepEqual(plan.groups[0].tracks[0].cueRange, { startSeconds: 5, endSeconds: 15 })
  const large = libraryTrack(f.db.getTracksByIds(['0']).tracks[0])
  await assert.rejects(
    buildLibraryLoudnessDatabasePlan(f.api.library.database, [large], revision, 'album'),
    /256/
  )
  assert.equal(
    (await buildLibraryLoudnessDatabasePlan(f.api.library.database, [large], revision, 'track'))
      .trackCount,
    1
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    buildLibraryLoudnessDatabasePlan(
      f.api.library.database,
      [small],
      revision,
      'album',
      controller.signal
    ),
    /取消/
  )
})

test('loudness collection selection does not trim an album to selected members and enforces the 10000-track bound', async (t) => {
  const f = fixture(t)
  const revision = f.db.getMetadata().revision
  const plan = await buildLibraryLoudnessDatabasePlan(
    f.api.library.database,
    [f.loaded[5]],
    revision,
    'album'
  )
  assert.equal(plan.trackCount, 10)
  assert.deepEqual(
    plan.groups[0].tracks.map((track) => track.id),
    Array.from({ length: 10 }, (_, i) => String(i))
  )
  await assert.rejects(
    buildLibraryLoudnessDatabasePlan(
      f.api.library.database,
      Array(10001).fill(f.loaded[0]),
      revision,
      'track'
    ),
    /10,000/
  )
})

test('the production loudness resolver discards stale mode results and aborts on disposal', async (t) => {
  const dialog = stripTypeScriptTypes(
    readFileSync(new URL('../library-loudness/LibraryLoudnessDialog.vue', import.meta.url), 'utf8')
      .split('<script setup lang="ts">')[1]
      .split('</script>')[0]
  )
  const pending = []
  const props = reactive({
    resolvePlan: (mode, signal) => new Promise((resolve) => pending.push({ mode, signal, resolve }))
  })
  const c = vm.createContext({ props, computed, ref, shallowRef, watch, AbortController })
  const scope = effectScope()
  t.after(() => scope.stop())
  const start = dialog.indexOf('const resolvedPlan ='),
    end = dialog.indexOf('const plan = computed', start)
  scope.run(() => vm.runInContext("const mode = ref('track');\n" + dialog.slice(start, end), c))
  assert.equal(pending[0].mode, 'track')
  vm.runInContext("mode.value = 'album'", c)
  await nextTick()
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve({ groups: [], trackCount: 256, skipped: 0, error: '' })
  await nextTick()
  pending[0].resolve({ groups: [], trackCount: 1, skipped: 0, error: '' })
  await nextTick()
  assert.equal(vm.runInContext('resolvedPlan.value.trackCount', c), 256)
  vm.runInContext("mode.value = 'track'", c)
  await nextTick()
  scope.stop()
  assert.equal(pending.at(-1).signal.aborted, true)
})
