import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { LibrarySelectionService } from '../../../../main/library/librarySelectionService.ts'
import { openLibrarySelectionLease } from './librarySelectionLease.ts'
import { shallowRef } from 'vue'
import { playlistRuntime } from '../coreTestFixtures.ts'
import { createPlaylistPageCommands } from '../../../../core/playlists/pageCommands.ts'
import { createLibraryPlaylistView } from './libraryPlaylistView.ts'
import { externalEntryForTrack } from './externalPlaylistMembership.ts'
import type { Playlist } from './musicStoreTypes.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'
import type {
  LibrarySelectionApi,
  LibrarySelectionBridgeApi,
  LibrarySelectionCommand,
  LibrarySelectionReply
} from '../../../../shared/librarySelection.ts'

function fixture(
  t: test.TestContext,
  count = 605,
  extra = (_index: number): Record<string, unknown> => ({})
) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      filePath: `D:/lease/${i}.flac`,
      title: `T${i}`,
      ...extra(i)
    }))
  })
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const database: LibrarySelectionApi = {
    createTrackSelection: async (request) => db.createTrackSelection(request),
    readTrackSelection: async (...args) => db.readTrackSelection(...args),
    closeTrackSelection: async (id) => db.closeTrackSelection(id)
  }
  const service = new LibrarySelectionService(database),
    commands: LibrarySelectionCommand[] = []
  const api: LibrarySelectionBridgeApi = {
    selection: async (command) => {
      commands.push(command)
      return service.handle(owner, command)
    }
  }
  const request = {
    query: { contentRevision: db.getMetadata().revision, sort: 'insertion' as const },
    total: count,
    ranges: count ? [[0, count] as [number, number]] : []
  }
  t.after(() => db.close())
  return { db, database, api, commands, request, owner }
}

function playlistCommands(input: Playlist[]) {
  const playlists = shallowRef(input)
  const writes: Playlist[][] = []
  const commands = createPlaylistPageCommands({
    runtime: playlistRuntime(),
    playlists,
    trackById: new Map(),
    getTracksRevision: () => 0,
    getDefaultFavoritePlaylist: () =>
      playlists.value.find((playlist) => playlist.isDefault) ?? null,
    getPlaylistTrackSnapshot: (playlist, id) => playlist.trackSnapshots?.[id],
    clonePlaylistSnapshot: () => structuredClone(playlists.value),
    queuePlaylistPersistence: () => {
      writes.push(structuredClone(playlists.value))
    }
  })
  return { playlists, commands, writes }
}

test('real SQLite frozen pages feed complete favorite state/mutation with an empty renderer library', async (t) => {
  const { db, api, request, owner } = fixture(t, 605, (index) =>
    index === 604
      ? {
          cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 },
          cueSheetPath: 'D:/lease/disc.cue',
          cueEncoding: 'utf-8'
        }
      : {}
  )
  const firstPage = db.queryTracks({ sort: 'insertion', limit: 200 }).tracks.map(libraryTrack)
  const { playlists, commands, writes } = playlistCommands([
    {
      id: 'favorite',
      name: 'Favorite',
      isDefault: true,
      createdAt: '',
      trackIds: firstPage.map((track) => track.id),
      trackSnapshots: Object.fromEntries(firstPage.map((track) => [track.id, track]))
    }
  ])
  const lease = await openLibrarySelectionLease(api, request)
  try {
    let pages = 0
    assert.deepEqual(
      await commands.readFavoriteTrackPages(async (append) => {
        await lease.forEachPage(async (page) => {
          await append(page.rows.map((row) => libraryTrack(row.track)))
          pages++
        })
      }),
      { count: 605, favoriteCount: 200 }
    )
    assert.equal(pages, 4)
    assert.equal(writes.length, 0)
    assert.equal(
      await commands.setFavoriteTrackPages(async (append) => {
        await lease.forEachPage(async (page) => {
          assert.ok(page.rows.length <= 200)
          await append(page.rows.map((row) => libraryTrack(row.track)))
          assert.equal(playlists.value[0].trackIds.length, 200, 'no staged prefix becomes live')
        })
      }, true),
      405
    )
    assert.equal(playlists.value[0].trackIds.length, 605)
    assert.deepEqual(playlists.value[0].trackSnapshots!['604'].cueRange, {
      startSeconds: 60,
      endSeconds: 120,
      pregapSeconds: 0
    })
    assert.equal(playlists.value[0].trackSnapshots!['604'].cueEncoding, 'utf-8')
    assert.equal(writes.length, 1)
  } finally {
    await lease.close()
  }
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('frozen mixed occurrences move/remove configured IDs rather than resolved playback IDs after the source view is dropped', async (t) => {
  const { db, api, owner } = fixture(t, 605, (index) => ({
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    ...(index === 604
      ? {
          cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 },
          cueSheetPath: 'D:/lease/disc.cue'
        }
      : {}),
    ...(index === 603 ? { subTrack: '2' } : {})
  }))
  const source: Playlist = {
    id: 'source',
    name: 'Mix',
    trackIds: [],
    trackSnapshots: {},
    createdAt: ''
  }
  db.syncPlaylistView({ kind: 'begin', id: 'selection-mixed', versions: [] })
  let sequence = 0
  for (let offset = 0; offset < 605; offset += 200) {
    const entries = db
      .queryTracks({ sort: 'insertion', offset, limit: 200 })
      .tracks.map((record) => {
        const id = `definition:${record.id}`,
          snapshot = { ...record, id }
        source.trackIds.push(id)
        source.trackSnapshots![id] = libraryTrack(snapshot)
        return { id, snapshot }
      })
    db.syncPlaylistView({ kind: 'append', id: 'selection-mixed', sequence: ++sequence, entries })
  }
  const remote = {
    id: 'ncm:7',
    filePath: 'ncm:7',
    title: 'Remote',
    artist: 'Artist',
    source: 'ncm',
    streamUrl: 'temporary-url',
    lyrics: 'heavy'
  }
  source.trackIds.push(remote.id)
  source.trackSnapshots![remote.id] = libraryTrack(remote)
  const tail = [
    { id: 'definition:604', snapshot: { ...source.trackSnapshots!['definition:604'] } },
    { id: remote.id, snapshot: remote }
  ]
  db.syncPlaylistView({
    kind: 'append',
    id: 'selection-mixed',
    sequence: ++sequence,
    entries: tail
  })
  db.syncPlaylistView({ kind: 'commit', id: 'selection-mixed', sequence: ++sequence })
  const { playlists, commands, writes } = playlistCommands([
    source,
    {
      id: 'target',
      name: 'Mix',
      kind: 'aggregate',
      trackIds: [],
      createdAt: ''
    }
  ])
  const lease = await openLibrarySelectionLease(api, {
    query: {
      contentRevision: db.getMetadata().revision,
      playlistView: 'selection-mixed',
      sort: 'playlist'
    },
    total: 607,
    ranges: [[0, 607]]
  })
  db.syncPlaylistView({ kind: 'drop', id: 'selection-mixed' })
  try {
    const sizes: number[] = []
    assert.deepEqual(
      await commands.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
        await lease.forEachPage(async (page) => {
          sizes.push(page.rows.length)
          if (page.rows[0].position === 0) {
            assert.equal(page.rows[0].track.id, '0')
            assert.equal(page.rows[0].definitionId, 'definition:0')
          }
          await append(page.rows.map((row) => row.definitionId))
          assert.equal(playlists.value[0].trackIds.length, 606)
          assert.equal(playlists.value[1].trackIds.length, 0)
        })
      }),
      { moved: 606, sourceRemoved: 606 }
    )
    assert.deepEqual(sizes, [200, 200, 200, 7])
    assert.equal(playlists.value[0].trackIds.length, 0)
    assert.equal(playlists.value[1].trackIds.length, 606)
    assert.ok(
      playlists.value[1].trackIds.every((id) => id.startsWith('definition:') || id === remote.id)
    )
    assert.deepEqual(playlists.value[1].trackSnapshots!['definition:604'].cueRange, {
      startSeconds: 60,
      endSeconds: 120,
      pregapSeconds: 0
    })
    assert.equal(playlists.value[1].trackSnapshots!['definition:603'].subTrack, '2')
    assert.equal(playlists.value[1].trackSnapshots![remote.id].streamUrl, undefined)
    assert.equal(playlists.value[1].trackSnapshots![remote.id].lyrics, null)
    assert.equal(writes.length, 1)
    assert.equal(
      await commands.removeTrackIdPagesFromPlaylistById('target', async (append) => {
        await lease.forEachPage((page) => append(page.rows.map((row) => row.definitionId)))
      }),
      606
    )
    assert.deepEqual(
      playlists.value.map((playlist) => playlist.trackIds.length),
      [0, 0]
    )
    assert.equal(writes.length, 2)
  } finally {
    await lease.close()
  }
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('frozen imported selection reorders, moves and removes occurrence IDs across pages after releasing its view', async (t) => {
  const { db, api, owner } = fixture(t, 605, (i) =>
    i === 200
      ? {
          cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 },
          cueEncoding: 'utf-8'
        }
      : {}
  )
  const source: Playlist = {
    id: 'source',
    name: 'Import',
    trackIds: [],
    createdAt: '',
    imported: {
      version: 1,
      source: { kind: 'file', label: 'mix.csv' },
      complete: true,
      importedAt: '',
      generation: 'refresh',
      membershipRevision: 0,
      entries: []
    }
  }
  for (let offset = 0; offset < 605; offset += 200) {
    for (const record of db.queryTracks({ sort: 'insertion', offset, limit: 200 }).tracks) {
      const position = source.imported!.entries.length
      source.imported!.entries.push({
        ...externalEntryForTrack(libraryTrack(record), position),
        entryId: `entry:${position}`
      })
    }
  }
  const entries = source.imported!.entries
  entries[201].resolution = structuredClone(entries[200].resolution)
  entries[201].manualBinding = structuredClone(entries[200].manualBinding)
  entries[404].resolution = { state: 'missing', message: 'Unavailable' }
  delete entries[404].manualBinding
  const target: Playlist = {
    ...source,
    id: 'target',
    name: 'Target',
    imported: { ...source.imported!, generation: 'target-refresh', entries: [] }
  }
  const { playlists, commands, writes } = playlistCommands([source, target])
  const view = createLibraryPlaylistView({
    syncPlaylistView: async (command) => db.syncPlaylistView(command)
  })
  await view.setPlaylist(source, { revision: 0, versions: [] })
  assert.equal(view.state.value.error, '')
  const lease = await openLibrarySelectionLease(api, {
    query: {
      playlistView: view.state.value.id!,
      sort: 'playlist',
      contentRevision: db.getMetadata().revision
    },
    total: 605,
    ranges: [[199, 405]]
  })
  await view.dispose()
  const sizes: number[] = []
  const produce = async (append: (ids: readonly string[]) => Promise<void>) => {
    await lease.forEachPage(async (page) => {
      sizes.push(page.rows.length)
      assert.ok(page.rows.every((row) => row.track.source === 'playlist-import'))
      await append(page.rows.map((row) => row.definitionId))
    })
  }
  try {
    assert.equal(await commands.reorderPlaylistTrackIdPagesById('source', produce, 0), true)
    assert.deepEqual(sizes, [200, 6])
    assert.equal(playlists.value[0].imported!.entries[0].entryId, 'entry:199')
    assert.deepEqual(
      await commands.movePlaylistMemberPagesById('source', 'target', async (append) => {
        await lease.forEachPage((page) =>
          append(page.rows.map((row) => ({ id: row.definitionId })))
        )
      }),
      { moved: 206, sourceRemoved: 206 }
    )
    const moved = playlists.value[1].imported!.entries
    assert.equal(moved.length, 206)
    assert.equal(playlists.value[0].imported!.entries.length, 399)
    assert.ok(moved.every((entry) => !entry.entryId.startsWith('entry:')))
    assert.equal(moved[1].resolution.track!.id, moved[2].resolution.track!.id)
    assert.deepEqual(moved[1].resolution.track!.cueRange, {
      startSeconds: 60,
      endSeconds: 120,
      pregapSeconds: 0
    })
    assert.equal(moved[1].resolution.track!.cueEncoding, 'utf-8')
    assert.equal(moved.at(-1)!.resolution.state, 'missing')
    assert.equal(moved.at(-1)!.original.title, 'T404')
  } finally {
    await lease.close()
  }
  const targetView = createLibraryPlaylistView({
    syncPlaylistView: async (command) => db.syncPlaylistView(command)
  })
  await targetView.setPlaylist(playlists.value[1], { revision: 0, versions: [] })
  const removal = await openLibrarySelectionLease(api, {
    query: {
      playlistView: targetView.state.value.id!,
      sort: 'playlist',
      contentRevision: db.getMetadata().revision
    },
    total: 206,
    ranges: [[0, 206]]
  })
  await targetView.dispose()
  try {
    assert.equal(
      await commands.removeTrackIdPagesFromPlaylistById('target', async (append) => {
        await removal.forEachPage((page) => append(page.rows.map((row) => row.definitionId)))
      }),
      206
    )
    assert.equal(playlists.value[1].imported!.entries.length, 0)
    assert.equal(writes.length, 3)
  } finally {
    await removal.close()
  }
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('renderer lease streams one confirmed page at a time and closes the sender-bound snapshot', async (t) => {
  const { api, commands, request, owner } = fixture(t),
    lease = await openLibrarySelectionLease(api, request)
  const sizes: number[] = [],
    ids: string[] = []
  await lease.forEachPage(async (page) => {
    sizes.push(page.rows.length)
    ids.push(...page.rows.map((row) => row.track.id))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(commands.filter((command) => command.kind === 'read').length, sizes.length)
  })
  assert.deepEqual(sizes, [200, 200, 200, 5])
  assert.deepEqual(
    ids,
    Array.from({ length: 605 }, (_, i) => String(i))
  )
  await lease.close()
  await lease.close()
  assert.equal(commands.filter((command) => command.kind === 'close').length, 1)
  assert.equal(owner.listenerCount('destroyed'), 0)
})

test('cancelling during a page visitor preserves confirmed work and prevents all later reads', async (t) => {
  const { api, commands, request } = fixture(t),
    abort = new AbortController()
  const lease = await openLibrarySelectionLease(api, request, abort.signal)
  let confirmed = 0
  await assert.rejects(
    lease.forEachPage((page) => {
      confirmed += page.rows.length
      abort.abort()
    }),
    /取消/
  )
  await lease.close()
  assert.equal(confirmed, 200)
  assert.equal(commands.filter((command) => command.kind === 'read').length, 1)
})

test('closing an opening renderer lease fences its late reply without replaying the open', async (t) => {
  const { api, commands, request } = fixture(t),
    abort = new AbortController()
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const delayed: LibrarySelectionBridgeApi = {
    selection: async (command) => {
      const reply = await api.selection(command)
      if (command.kind === 'open') await wait
      return reply
    }
  }
  const open = openLibrarySelectionLease(delayed, request, abort.signal)
  const failed = assert.rejects(open, /取消/)
  await new Promise((resolve) => setImmediate(resolve))
  abort.abort()
  release()
  await failed
  assert.equal(commands.filter((command) => command.kind === 'open').length, 1)
  assert.equal(commands.filter((command) => command.kind === 'close').length, 1)
  assert.equal(commands.filter((command) => command.kind === 'read').length, 0)
})

test('unknown read/consumer failures stop consumption without replay and still permit explicit cleanup', async (t) => {
  const { api, request, commands } = fixture(t)
  let reads = 0
  const failing: LibrarySelectionBridgeApi = {
    selection: (command) => {
      if (command.kind === 'read' && ++reads === 2)
        return Promise.reject(new Error('unknown read outcome'))
      return api.selection(command)
    }
  }
  const lease = await openLibrarySelectionLease(failing, request)
  let confirmed = 0
  await assert.rejects(
    lease.forEachPage((page) => {
      confirmed += page.rows.length
    }),
    /unknown read outcome/
  )
  assert.equal(confirmed, 200)
  assert.equal(reads, 2)
  await assert.rejects(
    lease.forEachPage(() => {}),
    /已中断/
  )
  assert.equal(reads, 2)
  await lease.close()
  assert.equal(commands.filter((command) => command.kind === 'open').length, 1)
})

test('invalid/out-of-scope, repeated or truncated snapshot pages are rejected before that batch is consumed', async (t) => {
  const { api, request, db } = fixture(t)
  for (const mutation of [
    (reply: Extract<LibrarySelectionReply, { kind: 'page' }>) => {
      reply.page.rows[0].position = -1
    },
    (reply: Extract<LibrarySelectionReply, { kind: 'page' }>) => {
      reply.page.rows[1].position = reply.page.rows[0].position
    },
    (reply: Extract<LibrarySelectionReply, { kind: 'page' }>) => {
      reply.page.nextCursor = 0
    },
    (reply: Extract<LibrarySelectionReply, { kind: 'page' }>) => {
      reply.page.nextCursor = null
    },
    (reply: Extract<LibrarySelectionReply, { kind: 'page' }>) => {
      reply.page.snapshot.fileCount++
    },
    (reply: Extract<LibrarySelectionReply, { kind: 'page' }>) => {
      reply.page.rows = []
    }
  ]) {
    const malformed: LibrarySelectionBridgeApi = {
      selection: async (command) => {
        const reply = await api.selection(command)
        if (reply.kind === 'page') mutation(reply)
        return reply
      }
    }
    const lease = await openLibrarySelectionLease(malformed, request)
    let consumed = false
    await assert.rejects(
      lease.forEachPage(() => {
        consumed = true
      }),
      /失效|不完整/
    )
    assert.equal(consumed, false)
    await lease.close()
    // The direct SQL fixture has no worker maintenance loop. Retiring slots
    // remain occupied until their bounded cleanup has actually completed.
    while (db.needsQueryMaintenance) db.maintainQueryState()
  }
})

test('a renderer lease captures its query/ranges rather than following later caller edits', async (t) => {
  const { api, request } = fixture(t)
  const lease = await openLibrarySelectionLease(api, request)
  request.ranges[0][1] = 1
  request.query.contentRevision++
  assert.equal(await lease.forEachPage(() => {}), 605)
  await lease.close()
})

test('concurrent visits reject without an extra RPC and an empty query yields an empty complete page', async (t) => {
  const { api, request, commands } = fixture(t),
    lease = await openLibrarySelectionLease(api, request)
  let release!: () => void, entered!: () => void
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocking = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = lease.forEachPage(async () => {
    entered()
    await blocking
  })
  await inside
  await assert.rejects(
    lease.forEachPage(() => {}),
    /正在读取/
  )
  assert.equal(commands.filter((command) => command.kind === 'read').length, 1)
  release()
  await running
  await lease.close()
  const empty = fixture(t, 0),
    emptyLease = await openLibrarySelectionLease(empty.api, empty.request)
  assert.equal(
    await emptyLease.forEachPage((page) => {
      assert.equal(page.rows.length, 0)
    }),
    0
  )
  await emptyLease.close()
})
