import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import type { TrackData } from '../../shared/track.ts'
import { LEGACY_CATALOG_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'

const track = (id: string, extra: Partial<TrackData> = {}): TrackData => ({
  id,
  title: 'Same title',
  artist: 'Same artist',
  album: 'Album',
  source: 'local',
  filePath: `D:/music/${id}.flac`,
  fileName: `${id}.flac`,
  duration: 200,
  size: 0,
  cover: null,
  lyrics: null,
  ...extra
})
const seed = (db: LibraryDatabase, tracks: TrackData[]) =>
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks,
    folders: ['D:/music'],
    exclusions: []
  })
function memory(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  return db
}
function drain(db: LibraryDatabase, limit = 200) {
  while (db.catalogStatus().localPending) db.catalogAdvance(limit)
}
function remote(db: LibraryDatabase, tracks: TrackData[], revision = 1) {
  let job = db.catalogSync({ kind: 'begin', revision })
  job = db.catalogSync({ kind: 'append', ...job, tracks })
  db.catalogSync({ kind: 'commit', ...job })
}

test('catalog incrementally preserves IDs across metadata edits, removal, reimport and selector changes', (t) => {
  const db = memory(t),
    a = track('old')
  seed(db, [a])
  drain(db, 1)
  const revision = db.getContentRevision()
  const first = db.catalogQuery({ kind: 'recording' }).items[0]
  const source = db.catalogSources({ entityId: first.id }).items[0]
  assert.equal(db.catalogResolve(source.id, db.catalogStatus().revision)?.filePath, a.filePath)
  seed(db, [track('new', { filePath: a.filePath, title: 'Renamed', album: 'Retagged' })])
  drain(db, 1)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].id, first.id)
  assert.equal(db.catalogSources({ entityId: first.id }).items[0].id, source.id)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].title, 'Renamed')
  assert.equal(
    db.getContentRevision(),
    revision + 1,
    'derived writes do not touch scan/content revision'
  )
  seed(db, [])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 0)
  assert.equal(db.catalogSources({ entityId: first.id }).items[0].availability, 'missing')
  assert.equal(db.catalogResolve(source.id, db.catalogStatus().revision), null)
  seed(db, [a])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].id, first.id)
  seed(db, [track('old', { filePath: 'D:/other.flac' })])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogSources({ entityId: first.id }).items[0].inLibrary, false)
})

test('same names stay independent; manual versions join sources reversibly without joining version families', (t) => {
  const db = memory(t),
    local = track('local'),
    online = track('ncm:7', {
      source: 'ncm',
      ncmSongId: 7,
      filePath: '',
      albumId: 'remote-album',
      streamUrl: 'https://secret.invalid/?token=private',
      lyrics: 'private',
      artists: [{ id: 9, name: 'Same artist' }]
    })
  seed(db, [local, track('live', { title: 'Same title (Live)' })])
  drain(db)
  remote(db, [online, online])
  const original = db
    .catalogQuery({ kind: 'recording' })
    .items.map((i) => i.id)
    .sort()
  assert.equal(original.length, 3)
  const doc = emptyMusicVersions()
  doc.tracks.versions = [
    {
      id: 'studio',
      label: 'Studio',
      sources: [versionSourceKey(local), versionSourceKey(online)],
      preferredSource: versionSourceKey(online)
    },
    { id: 'live', label: 'Live', sources: [versionSourceKey(track('live'))], preferredSource: null }
  ]
  doc.tracks.families = [{ id: 'family', versions: ['studio', 'live'], preferredVersion: 'studio' }]
  const localAlbumKey = JSON.stringify(['album', 'local', getAlbumIdentity(local)])
  doc.albums.versions = [
    {
      id: 'album',
      label: 'Album version',
      sources: [localAlbumKey, JSON.stringify(['album', 'ncm', getAlbumIdentity(online)])],
      preferredSource: localAlbumKey
    }
  ]
  db.catalogProjectVersions(doc, 5)
  const grouped = db.catalogQuery({ kind: 'recording' })
  assert.equal(grouped.total, 2)
  const studio = grouped.items.find((i) => i.title === 'Studio')!
  const sources = db.catalogSources({ entityId: studio.id })
  assert.equal(sources.total, 2)
  assert.equal(sources.items.filter((s) => s.preferred).length, 1)
  assert.equal(sources.items.find((s) => s.preferred)?.provider, 'ncm')
  const album = db.catalogQuery({ kind: 'release' }).items[0]
  const albumSources = db.catalogSources({ entityId: album.id }).items
  assert.equal(albumSources.length, 3)
  assert.equal(
    albumSources.filter((s) => s.preferred).every((s) => s.provider === 'local'),
    true
  )
  assert.equal(
    db.sql
      .prepare("SELECT preferred_version FROM catalog_versions WHERE scope='tracks' AND id='live'")
      .get()!.preferred_version,
    'studio'
  )
  assert.equal(
    db.catalogDetail(studio.id).facts.some((f) => f.origin === 'provider'),
    true
  )
  assert.equal(db.catalogQuery({ kind: 'recording', source: 'ncm' }).items[0].sourceCount, 1)
  const serialized = JSON.stringify(sources)
  assert.equal(serialized.includes('filePath'), false)
  assert.equal(serialized.includes('streamUrl'), false)
  assert.equal(serialized.includes('secret.invalid'), false)
  const ref = db.catalogResolve(
    sources.items.find((s) => s.provider === 'ncm')!.id,
    sources.revision
  )!
  assert.equal(ref.ncmSongId, 7)
  assert.equal(ref.streamUrl, undefined)
  assert.equal(ref.lyrics, null)
  db.catalogProjectVersions(emptyMusicVersions(), 6)
  assert.deepEqual(
    db
      .catalogQuery({ kind: 'recording' })
      .items.map((i) => i.id)
      .sort(),
    original
  )
  assert.throws(
    () => db.catalogSources({ entityId: studio.id, revision: sources.revision }),
    /已变化/
  )
})

test('playlist publication is atomic, deduplicated and fenced; aborted staging does not add members', (t) => {
  const db = memory(t),
    a = track('ncm:1', { source: 'ncm', filePath: '' }),
    b = track('ncm:2', { source: 'ncm', filePath: '' })
  remote(db, [a])
  let job = db.catalogSync({ kind: 'begin', revision: 2 })
  const staleJob = job
  job = db.catalogSync({ kind: 'append', ...job, tracks: [b, b] })
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogQuery({ kind: 'recording', scope: 'all' }).total, 2)
  assert.throws(() => db.catalogSync({ kind: 'commit', ...staleJob }), /已变化/)
  db.catalogSync({ kind: 'abort', id: job.id })
  assert.equal(db.catalogStatus().playlistsRevision, 1)
  remote(db, [b], 3)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogStatus().playlistsRevision, 3)
  remote(db, [], 4)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 0)
})

test('CUE ranges remain independent and resolve to the original selectors', (t) => {
  const db = memory(t)
  const first = track('cue:1', {
    filePath: 'D:/music/disc.flac',
    cueRange: { startSeconds: 0, endSeconds: 10, pregapSeconds: 0 }
  })
  const second = track('cue:2', {
    filePath: first.filePath,
    cueRange: { startSeconds: 10, endSeconds: 20, pregapSeconds: 0 }
  })
  seed(db, [first, second])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 2)
  const sources = db
    .catalogQuery({ kind: 'recording' })
    .items.flatMap((i) => db.catalogSources({ entityId: i.id }).items)
  assert.equal(new Set(sources.map((s) => s.id)).size, 2)
  for (const source of sources) {
    const resolved = db.catalogResolve(source.id, db.catalogStatus().revision)!
    assert.deepEqual(resolved.cueRange, resolved.id === first.id ? first.cueRange : second.cueRange)
  }
})

test('legacy colon-delimited Track IDs without source remain local and missing display tags use existing fallbacks', (t) => {
  const db = memory(t)
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: [{ id: 'track:10:2', filePath: 'D:/music/legacy.flac' }],
    folders: [],
    exclusions: []
  })
  drain(db)
  const entity = db.catalogQuery({ kind: 'recording' }).items[0]
  assert.equal(entity.title, 'legacy.flac')
  const source = db.catalogSources({ entityId: entity.id }).items[0]
  assert.equal(source.provider, 'local')
  assert.equal(db.catalogResolve(source.id, db.catalogStatus().revision)?.source, 'local')
  assert.deepEqual(
    db.catalogDetail(entity.id).facts,
    [],
    'display fallbacks must not masquerade as file tags'
  )
  assert.equal(
    db.catalogQuery({ kind: 'release' }).total,
    0,
    'missing album tags do not invent a release'
  )
  assert.equal(
    db.catalogQuery({ kind: 'artist' }).total,
    0,
    'missing artist tags do not invent a person'
  )
})

test('public source views omit path-shaped legacy IDs and SACD selectors while private playback retains them', (t) => {
  const db = memory(t)
  const filePath = 'D:/private/disc.iso',
    subTrack = filePath + '?area=stereo&track=2'
  seed(db, [track(filePath, { filePath, subTrack, title: 'SACD track' })])
  drain(db)
  const entity = db.catalogQuery({ kind: 'recording' }).items[0]
  const sources = db.catalogSources({ entityId: entity.id })
  assert.equal(JSON.stringify(sources).includes('D:/private'), false)
  assert.equal(db.catalogResolve(sources.items[0].id, sources.revision)?.subTrack, subTrack)
})

test('v11 upgrade is backed up and backfill resumes across reopen without altering queues', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-upgrade-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(db, [track('one'), track('two'), track('three')])
  const queue = db.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' }, 'two')
  const queued = db.readLibraryQueue(queue.id)
  const metadata = db.getMetadata()
  // Actual v11 queue schema retained; remove only the new derived catalog.
  db.sql.exec(LEGACY_CATALOG_SCHEMA_SQL + 'PRAGMA user_version=11;')
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(
    readdirSync(root).some((name) => name.includes('.v11-backup-')),
    true
  )
  assert.equal(db.catalogStatus().localHorizon, 3)
  db.catalogAdvance(1)
  assert.deepEqual(db.readLibraryQueue(queue.id), queued)
  assert.deepEqual(db.getMetadata(), metadata)
  const one = db.catalogQuery({ kind: 'recording' }).items[0].id
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.catalogStatus().localCursor, 1)
  drain(db, 1)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 3)
  assert.equal(
    db.catalogQuery({ kind: 'recording' }).items.some((i) => i.id === one),
    true
  )
  const backup = new DatabaseSync(
    join(root, readdirSync(root).find((name) => name.includes('.v11-backup-'))!)
  )
  assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 11)
  backup.close()
})

test('v11 catalog DDL failure rolls back partially created tables; backup failure prevents the upgrade', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-failure-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(old, [track('retained')])
  old.sql.exec(LEGACY_CATALOG_SCHEMA_SQL + 'PRAGMA user_version=11;')
  const exec = DatabaseSync.prototype.exec
  const partial = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE catalog_state')) {
        exec.call(this, sql.slice(0, sql.indexOf('CREATE TABLE catalog_sources')))
        throw new Error('Injected catalog DDL failure')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /Injected catalog DDL/)
  partial.mock.restore()
  assert.equal(old.sql.prepare('PRAGMA user_version').get()!.user_version, 11)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='catalog_state'").get(),
    undefined
  )
  assert.equal(old.getMetadata().trackCount, 1)
  const prepare = DatabaseSync.prototype.prepare
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('VACUUM INTO')) throw new Error('Injected backup failure')
      return prepare.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /Injected backup failure/)
  failure.mock.restore()
  assert.equal(old.sql.prepare('PRAGMA user_version').get()!.user_version, 11)
  const upgraded = new LibraryDatabase(path)
  assert.equal(upgraded.catalogStatus().localPending, true)
  drain(upgraded)
  assert.equal(upgraded.catalogQuery({ kind: 'recording' }).total, 1)
  upgraded.close()
})

test('catalog pages are bounded and revision fenced; albums without provider IDs do not merge on a title', (t) => {
  const db = memory(t)
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  for (let page = 0; page < 3; page++)
    job = db.catalogSync({
      kind: 'append',
      ...job,
      tracks: Array.from({ length: 200 }, (_, i) =>
        track(`ncm:${page * 200 + i}`, { source: 'ncm', filePath: '' })
      )
    })
  db.catalogSync({ kind: 'commit', ...job })
  const first = db.catalogQuery({ kind: 'recording', limit: 200 })
  const next = db.catalogQuery({ kind: 'recording', revision: first.revision, offset: 200 })
  assert.equal(first.total, 600)
  assert.equal(next.items.length, 200)
  assert.equal(new Set([...first.items, ...next.items].map((i) => i.id)).size, 400)
  assert.equal(db.catalogQuery({ kind: 'release' }).total, 600)
  assert.throws(() => db.catalogQuery({ kind: 'recording', limit: 201 }), /Invalid/)
  remote(db, [], 2)
  assert.throws(() => db.catalogQuery({ kind: 'recording', revision: first.revision }), /已变化/)
})
