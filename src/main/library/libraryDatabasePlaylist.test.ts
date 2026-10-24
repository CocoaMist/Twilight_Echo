import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import type { Track } from '../../renderer/src/types/music.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'

function track(id: string, patch: Partial<Track> = {}): Track {
  return {
    id,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    size: 1,
    filePath: `D:/Music/${id}.flac`,
    fileName: `${id}.flac`,
    source: 'local',
    cover: null,
    lyrics: null,
    ...patch
  }
}
function fixture(t: TestContext, tracks: Track[]) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  t.after(() => db.close())
  return db
}
test('explicit versions locate canonical source paths, preserve CUE ranges, and honor unavailable remote preferences', (t) => {
  const cue = track('cue:2', {
      title: 'Different local title',
      subTrack: 'cue:2',
      cueRange: { startSeconds: 30, endSeconds: 60, pregapSeconds: 0 }
    }),
    neighbor = {
      ...cue,
      id: 'cue:1',
      subTrack: 'cue:1',
      cueRange: { startSeconds: 0, endSeconds: 30, pregapSeconds: 0 }
    },
    remote = track('ncm:1', { source: 'ncm', ncmSongId: 1 }),
    versions = [
      {
        id: 'v',
        sources: [versionSourceKey(cue), versionSourceKey(remote)],
        preferredSource: versionSourceKey(cue)
      }
    ]
  const db = fixture(t, [neighbor, cue])
  const request = {
    entries: [{ id: remote.id, snapshot: remote }],
    versions
  }
  assert.deepEqual(db.lookupPlaylistTracks(request).ids, ['cue:2'])
  assert.deepEqual(db.lookupPlaylistTracks({ ...request, preserveSources: true }).ids, [null])
  assert.deepEqual(
    db.lookupPlaylistTracks({
      ...request,
      versions: [{ ...versions[0], preferredSource: versionSourceKey(remote) }]
    }).ids,
    [null]
  )
  assert.deepEqual(db.lookupPlaylistTracks({ entries: [{ id: 'unknown' }], versions: [] }).ids, [
    null
  ])
  assert.throws(
    () =>
      db.lookupPlaylistTracks({
        entries: Array.from({ length: 201 }, () => ({ id: 'x' })),
        versions: []
      }),
    /oversized/
  )
  assert.throws(
    () => db.lookupPlaylistTracks({ ...request, versions: [...versions, ...versions] }),
    /Invalid/
  )
  assert.throws(
    () =>
      db.lookupPlaylistTracks({
        entries: [{ id: 'x', snapshot: { id: 'x', title: 1 } }],
        versions: []
      } as never),
    /Invalid/
  )
})

test('recent lookup validates resolution and source identities before reading candidates', (t) => {
  const db = fixture(t, [track('one')])
  assert.throws(
    () => db.lookupPlaylistTracks({ entries: [], versions: [], resolution: 'unknown' } as never),
    /Invalid/
  )
  for (const sourceIds of [true, [1], [''], ['x'.repeat(32769)]])
    assert.throws(
      () =>
        db.lookupPlaylistTracks({
          entries: [{ id: 'history', sourceIds }],
          versions: [],
          resolution: 'recent'
        } as never),
      /Invalid/
    )
})

test('dense recording buckets use compact identities and summarized compatibility rather than quadratic pair checks', (t) => {
  const db = fixture(
    t,
    Array.from({ length: 5000 }, (_, i) =>
      track(String(i), { duration: 180 + (i % 1000) / 1000, format: i === 4999 ? 'flac' : 'mp3' })
    )
  )
  const started = performance.now()
  const response = db.lookupPlaylistTracks({
    entries: [{ id: 'missing', snapshot: track('missing') }],
    versions: []
  })
  t.diagnostic(`5000 same-recording candidates: ${Math.round(performance.now() - started)} ms`)
  assert.deepEqual(response.ids, ['4999'])
  assert.ok(JSON.stringify(response).length < 100)
})

test('v5 upgrade snapshots committed WAL and installs recording indexes without changing tracks, history, exclusions or queues', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-recording-upgrade-')),
    path = join(root, 'library.sqlite'),
    old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.replaceDocument({
    version: 2,
    revision: 7,
    folders: ['D:/Music'],
    exclusions: [
      {
        filePath: 'D:/Music/ignored.flac',
        title: 'Ignored',
        artist: 'Artist',
        excludedAt: '2026-10-19'
      }
    ],
    tracks: [track('one')]
  })
  old.syncListeningHistory({ kind: 'begin', id: 'history', mode: 'replace' })
  old.syncListeningHistory({
    kind: 'append',
    id: 'history',
    sequence: 1,
    entries: [{ id: 'one', lastPlayed: 12345 }]
  })
  old.syncListeningHistory({ kind: 'commit', id: 'history', sequence: 2 })
  const queue = old.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' })
  const document = old.exportDocument(),
    page = old.getTracksByIds(['one']),
    files = old.sql.prepare('SELECT file_key,content_version FROM files').all()
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      'DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX tracks_recording; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=5;'
  )
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 28)
    assert.deepEqual(upgraded.exportDocument(), document)
    assert.deepEqual(upgraded.getTracksByIds(['one']), page)
    assert.equal(upgraded.queryTracks({ sort: 'lastPlayed' }).historyRevision, 1)
    assert.equal(
      upgraded.sql.prepare('SELECT last_played FROM library_history WHERE id=?').get('one')
        ?.last_played,
      12345
    )
    assert.deepEqual(
      upgraded.sql.prepare('SELECT file_key,content_version FROM files').all(),
      files
    )
    assert.equal(upgraded.readLibraryQueue(queue.id).total, 2)
    const snapshot = new DatabaseSync(
      join(root, readdirSync(root).find((file) => file.includes('.v5-backup-'))!),
      { readOnly: true }
    )
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 5)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM tracks').get()?.n, 1)
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})

test('recording index DDL failures roll back and backup failures prevent schema changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-recording-fault-')),
    path = join(root, 'library.sqlite'),
    old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      'DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX tracks_recording; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=5;'
  )
  const exec = DatabaseSync.prototype.exec
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('CREATE INDEX tracks_recording')) {
        exec.call(this, 'CREATE INDEX partial_recording_upgrade ON tracks(title)')
        throw new Error('recording DDL fault')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /recording DDL fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 5)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='partial_recording_upgrade'").get(),
    undefined
  )
  failure.mock.restore()
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'VACUUM INTO ?') throw new Error('SQLITE_FULL: backup failed')
    return prepare.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /SQLITE_FULL/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 5)
})
