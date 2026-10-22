import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import { LibraryQueueSource, type LibraryQueueApi } from '../stores/player/libraryQueueSource.ts'
import { libraryNativeQueueOptions, libraryQueueTrack } from './libraryQueuePlayback.ts'
import { NativeQueueLoader } from './nativeQueueLoader.ts'
import { prepareNativeQueue, preparedNativePlayMode } from './nativeQueuePreparation.ts'

test('real SQL tail holes reach renderer native markers without hydrating the complete queue', async (t) => {
  const db = new LibraryDatabase(':memory:')
  const source = new LibraryQueueSource({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => {
    source.dispose()
    db.close()
  })
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      { id: 'cue', filePath: 'D:/Music/disc.flac', cueRange: { startSeconds: 90, endSeconds: 180 } }
    ]
  })
  const created = await source.create({ ids: Array(605).fill('cue'), sort: 'playlist' })
  const tail = db.readLibraryQueue(created!.id, 602, 1).items[0]
  db.sql
    .prepare('UPDATE queue_entries SET track_id=? WHERE queue_id=? AND position>602')
    .run('missing', created!.id)
  await source.edit({ kind: 'select', entryId: tail.queueEntryId })
  for (const mode of ['sequential', 'listLoop', 'repeat'] as const) {
    const window = (await source.playbackWindow({
      repeat: mode === 'repeat',
      wrap: mode === 'listLoop'
    }))!
    assert.equal(window.lastPlayablePosition, 602)
    const track = libraryQueueTrack(window.items[0].track!, window.items[0].queueEntryId)
    const prepared = await prepareNativeQueue({
      ...libraryNativeQueueOptions(window, track, track.filePath, mode),
      isAudioFileAuthorized: async () => true
    })
    assert.equal(prepared?.items[0].logicalQueueEnd, mode !== 'repeat')
    assert.ok((prepared?.items.length ?? 0) <= 2)
    if (mode === 'listLoop') assert.equal(prepared?.items[1].logicalQueueEnd, false)
  }
  assert.ok(source.state.cachedTracks <= 400)
})

test('mixed database windows preserve remote routing and legacy source-less local identities', () => {
  const local = libraryQueueTrack(
    { id: 'track:10:2', filePath: 'D:/Music/cue.flac' },
    'local-entry'
  )
  assert.equal(local.source, 'local')
  const remote = libraryQueueTrack(
    { id: 'ncm:7', filePath: '', source: 'ncm', ncmSongId: 7 },
    'remote-entry'
  )
  assert.equal(remote.source, 'ncm')
  assert.equal(remote.ncmSongId, 7)
  assert.equal(remote.queueEntryId, 'remote-entry')
})

test('database windows reach the existing native loader with page-crossing CUE mappings, then renew after handoff', async (t) => {
  const db = new LibraryDatabase(':memory:')
  const api: LibraryQueueApi = {
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  }
  const source = new LibraryQueueSource(api)
  t.after(() => {
    source.dispose()
    db.close()
  })
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 600 }, (_, index) => ({
      id: String(index),
      title: `Title ${index}`,
      artist: 'Artist',
      album: 'Album',
      filePath: index === 199 || index === 200 ? 'D:/Music/cue.flac' : `D:/Music/${index}.flac`,
      ...(index === 199
        ? { cueRange: { startSeconds: 0, endSeconds: 90 } }
        : index === 200
          ? { cueRange: { startSeconds: 90, endSeconds: 180 } }
          : {}),
      duration: 180
    }))
  })
  await source.create({ sort: 'playlist' }, '199')
  const loader = new NativeQueueLoader(),
    authorized: string[][] = []
  let loads = 0
  const native = {
    loadQueue: async (items: unknown[]) => {
      assert.ok(items.length <= 2)
      return { queueToken: `token-${++loads}` }
    }
  }
  const boundary = {
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async (paths: string[]) => {
      authorized.push(paths)
      return paths.map(() => true)
    }
  }
  const window = (await source.playbackWindow())!
  const current = libraryQueueTrack(window.items[0].track!, window.items[0].queueEntryId)
  const prepared = await loader.prepareAndLoad(
    libraryNativeQueueOptions(window, current, current.filePath, 'sequential'),
    boundary,
    native
  )
  assert.deepEqual(
    prepared?.items.map((item) => item.cueRange),
    [
      { startSeconds: 0, endSeconds: 90 },
      { startSeconds: 90, endSeconds: 180 }
    ]
  )
  assert.deepEqual(authorized, [['D:/Music/cue.flac']])
  assert.equal(preparedNativePlayMode(prepared!, 'listLoop'), 'sequential')
  const handoff = loader.findLibraryEntry({ queueToken: 'token-1', queueIndex: 1 }, window.queue)!
  assert.equal(handoff.index, 200)
  assert.equal(handoff.queueEntryId, window.items[1].queueEntryId)
  await source.edit({ kind: 'select', entryId: handoff.queueEntryId })
  const next = (await source.playbackWindow())!
  const track = libraryQueueTrack(next.items[0].track!, next.items[0].queueEntryId)
  await loader.prepareAndLoad(
    libraryNativeQueueOptions(next, track, track.filePath, 'sequential'),
    boundary,
    native
  )
  assert.equal(
    loader.findLibraryEntry({ queueToken: 'token-2', queueIndex: 1 }, next.queue)?.index,
    201
  )
  assert.equal(loader.findLibraryEntry({ queueToken: 'token-1', queueIndex: 1 }, next.queue), null)
  assert.equal(source.state.queue?.index, 200)
  assert.equal(source.state.queue?.total, 600)
})

test('window adapters preserve duplicate occurrences and global wrap but never repeat the local window', () => {
  const track = {
    id: 'same',
    filePath: 'D:/Music/same.flac',
    arbitrary: { retained: true },
    queueEntryId: 'stale-payload-occurrence'
  }
  const queue = {
    id: 'db',
    revision: 6,
    total: 300_000,
    index: 299_999,
    selectedEntryId: 'last',
    order: 'original' as const
  }
  const window = {
    queue,
    libraryRevision: 20,
    items: [
      { queueEntryId: 'last', position: 299_999, track },
      { queueEntryId: 'first', position: 0, track }
    ]
  }
  const current = libraryQueueTrack(track, 'last')
  assert.equal(current.title, 'same.flac')
  assert.equal(current.queueEntryId, 'last')
  assert.deepEqual((current as unknown as typeof track).arbitrary, track.arbitrary)
  const options = libraryNativeQueueOptions(window, current, current.filePath, 'listLoop')
  assert.deepEqual(options.libraryQueue?.positions, [299_999, 0])
  assert.deepEqual(
    options.queue.map((track) => track.queueEntryId),
    ['last', 'first']
  )
  assert.equal(
    libraryNativeQueueOptions(window, current, current.filePath, 'repeat').queue.length,
    1
  )
  assert.throws(
    () =>
      libraryNativeQueueOptions(
        window,
        { ...current, queueEntryId: 'other' },
        current.filePath,
        'sequential'
      ),
    /no longer matches/
  )
})
