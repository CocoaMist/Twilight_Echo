import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { importLegacyQueue } from './legacyQueueImport.ts'
import { libraryQueueTrack } from './libraryTrack.ts'
import type { PlaybackSessionData } from '../../shared/playbackSession.ts'
import type { TrackData } from '../../shared/track.ts'
import type { CoreQueueImportCommand } from '../../shared/coreQueueImport.ts'

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 14,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'library', filePath: 'D:/library.flac' }]
  })
  t.after(() => db.close())
  const a = libraryQueueTrack(
    {
      id: 'temp',
      source: 'local',
      title: 'CUE 1',
      filePath: 'D:/temporary/disc.flac',
      duration: 60,
      cueRange: { startSeconds: 10, endSeconds: 70, pregapSeconds: 2, virtualPregapSeconds: 2 }
    },
    'old:occurrence:one'
  )
  const b = libraryQueueTrack(
    {
      id: 'ncm:7',
      source: 'ncm',
      title: 'Online',
      filePath: 'ncm://7',
      streamUrl: 'https://expired.example/private',
      duration: 120
    },
    'old:occurrence:two'
  )
  const c = {
    ...a,
    queueEntryId: 'old:occurrence:duplicate',
    subTrack: 'sacd:2',
    cueRange: undefined
  }
  const session: PlaybackSessionData<TrackData> = {
    version: 1,
    savedAt: '2026-10-21T00:00:00Z',
    mode: 'trackAndPosition',
    playMode: 'shuffle',
    track: c,
    position: 24,
    queue: [b, a, c],
    queueIndex: 0
  }
  const api = {
    importLegacyPlaybackQueue: async (command: CoreQueueImportCommand) =>
      db.importLegacyPlaybackQueue(command),
    readQueue: async (...args: Parameters<LibraryDatabase['readLibraryQueue']>) =>
      db.readLibraryQueue(...args)
  }
  return { db, api, session }
}

test('legacy mixed/temporary-local queues use the actual library revision and preserve duplicate, CUE and SACD identities', async (t) => {
  const { db, api, session } = fixture(t)
  const { queue, position } = await importLegacyQueue({
    api,
    session,
    sessionRevision: 9,
    libraryRevision: db.getMetadata().revision
  })
  const page = db.readLibraryQueue(queue.id)
  assert.equal(queue.index, 2) // occurrence wins over a stale saved index
  assert.equal(position, 24)
  assert.equal(queue.order, 'shuffle')
  assert.deepEqual(
    page.items.map((r) => r.queueEntryId),
    session.queue!.map((r) => r.queueEntryId)
  )
  assert.deepEqual(
    page.items.map((r) => r.track?.id),
    ['ncm:7', 'temp', 'temp']
  )
  assert.equal(page.items[0].track?.streamUrl, undefined)
  assert.deepEqual(page.items[1].track?.cueRange, session.queue![1].cueRange)
  assert.equal(page.items[2].track?.subTrack, 'sacd:2')
  assert.equal(db.getMetadata().trackCount, 1)
  assert.equal(db.collectLibraryQueueGarbage(0), 0) // protected until file publication
})

test('a lost import publication reply is read-recovered without re-inserting or renaming occurrences', async (t) => {
  const f = fixture(t)
  const commands: string[] = []
  let lose = true
  const api = {
    ...f.api,
    importLegacyPlaybackQueue: async (command: CoreQueueImportCommand) => {
      commands.push(command.kind)
      const result = await f.api.importLegacyPlaybackQueue(command)
      if (command.kind === 'commit' && lose) {
        lose = false
        throw new Error('Publication reply lost')
      }
      return result
    }
  }
  const options = {
    api,
    session: f.session,
    sessionRevision: 10,
    libraryRevision: f.db.getMetadata().revision
  }
  await assert.rejects(importLegacyQueue(options), /reply lost/)
  assert.deepEqual(commands, ['begin', 'append', 'commit'])
  const result = await importLegacyQueue(options)
  assert.deepEqual(commands, ['begin', 'append', 'commit', 'begin'])
  assert.equal(result.queue.selectedEntryId, f.session.track.queueEntryId)
})

test('an interrupted hidden import retires only its own bounded rows; overlapping occurrences remain isolated by queue', async (t) => {
  const f = fixture(t)
  const first = f.session.queue![0]
  f.db.importLegacyPlaybackQueue({
    kind: 'begin',
    id: 'core-session-11',
    contentRevision: f.db.getMetadata().revision,
    order: 'shuffle'
  })
  f.db.importLegacyPlaybackQueue({
    kind: 'append',
    id: 'core-session-11',
    sequence: 1,
    items: [{ id: first.id, occurrenceId: first.queueEntryId!, snapshot: { ...first } }]
  })
  const recovered = await importLegacyQueue({
    api: f.api,
    session: f.session,
    sessionRevision: 11,
    libraryRevision: f.db.getMetadata().revision
  })
  assert.equal(recovered.queue.total, 3)
  const overlap = await importLegacyQueue({
    api: f.api,
    session: f.session,
    sessionRevision: 12,
    libraryRevision: f.db.getMetadata().revision
  })
  assert.notEqual(overlap.queue.id, recovered.queue.id)
  assert.deepEqual(
    f.db.readLibraryQueue(overlap.queue.id).items,
    f.db.readLibraryQueue(recovered.queue.id).items
  )
  assert.equal(
    f.db.getLibraryQueue(recovered.queue.id).selectedEntryId,
    first.queueEntryId === f.session.track.queueEntryId
      ? first.queueEntryId
      : f.session.track.queueEntryId
  )
  assert.throws(
    () =>
      f.db.buildLibraryQueue({
        kind: 'begin',
        id: 'core-session-13',
        contentRevision: f.db.getMetadata().revision,
        order: 'original'
      }),
    /reserved/
  )
  assert.throws(
    () =>
      f.db.buildLibraryQueue({
        kind: 'append',
        id: 'public',
        sequence: 1,
        items: [{ id: first.id, occurrenceId: first.queueEntryId, snapshot: { ...first } }]
      } as any),
    /reserved/
  )
})

test('a single-track legacy session restores without an array; mismatched selections restart at zero', async (t) => {
  const f = fixture(t)
  const single = {
    ...f.session,
    track: f.session.queue![1],
    queue: undefined,
    queueIndex: undefined
  }
  const result = await importLegacyQueue({
    api: f.api,
    session: single,
    sessionRevision: 13,
    libraryRevision: f.db.getMetadata().revision
  })
  assert.equal(result.queue.total, 1)
  assert.equal(result.queue.selectedEntryId, single.track.queueEntryId)
  assert.equal(result.position, 24)
  const missing = {
    ...f.session,
    track: { ...f.session.track, id: 'missing', queueEntryId: 'absent' },
    queue: [f.session.queue![0]]
  }
  const other = await importLegacyQueue({
    api: f.api,
    session: missing,
    sessionRevision: 14,
    libraryRevision: f.db.getMetadata().revision
  })
  assert.equal(other.position, 0)
})
