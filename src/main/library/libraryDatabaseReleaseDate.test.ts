import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase, openLibraryDatabase } from './libraryDatabase.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'

function fixture(t: test.TestContext, names = ['one.flac']) {
  const root = mkdtempSync(join(tmpdir(), 'library-date-only-'))
  const path = join(root, 'library.sqlite'), db = new LibraryDatabase(path)
  db.updateConfiguration({ folders: [root], exclusions: [] })
  const identities = names.map((name): LocalLibraryFileIdentity => {
    const filePath = join(root, name)
    writeFileSync(filePath, name)
    const info = statSync(filePath)
    return { filePath, size: info.size, mtimeMs: info.mtimeMs }
  })
  db.startScan({ id: 'seed', mode: 'full', roots: [root] })
  for (let offset = 0; offset < identities.length; offset += 256) {
    const page = identities.slice(offset, offset + 256)
    db.recordScanFiles('seed', page)
    db.claimScanFiles('seed')
    db.commitScanBatch({ jobId: 'seed', sequence: offset / 256 + 1, files: page.map((identity, index) => ({
      identity, metadataRead: true,
      tracks: [{ id: `track-${offset + index}`, filePath: identity.filePath, title: 'Manual title',
        artist: 'Manual artist', album: 'Manual album', cover: 'manual-cover', lyrics: 'manual lyrics',
        identityTags: { version: 1, title: { value: 'Observed title', origin: 'audio_tag' } },
        metadataMatch: { provider: 'manual-match', trackId: 'remote' }, addedAt: 7 }]
    })) })
  }
  db.recordScanDirectory('seed', { path: root, children: [] })
  db.finishScan('seed')
  db.sql.exec("UPDATE files SET metadata_version=0,identity=json_set(identity,'$.metadataVersion',0)")
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { db, root, path, identities }
}

function start(db: LibraryDatabase, root: string, identities: LocalLibraryFileIdentity[], id = 'dates') {
  db.startScan({ id, mode: 'startup', roots: [root] })
  db.claimScanDirectories(id)
  db.recordScanFiles(id, identities)
  db.recordScanDirectory(id, { path: root, children: [] })
  return db.claimScanFiles(id)
}

function dateResult(identity: LocalLibraryFileIdentity, releaseDate?: string, error?: string) {
  return { identity, tracks: [], metadataRead: !error, releaseDateOnly: true as const, releaseDate, ...(error ? { error } : {}) }
}

test('unchanged legacy files stage only dates and publish dates with markers at successful finish', (t) => {
  const { db, root, identities } = fixture(t)
  const before = db.getTracksByIds(['track-0']), metadata = db.getMetadata()
  assert.deepEqual(start(db, root, identities).releaseDateFilePaths, identities.map((i) => i.filePath))
  const batch = { jobId: 'dates', sequence: 1, files: [{ identity: identities[0], tracks: [],
    metadataRead: true, releaseDateOnly: true as const, releaseDate: '2001-03' }] }
  db.commitScanBatch(batch)
  assert.deepEqual(db.getTracksByIds(['track-0']), before)
  assert.equal(db.sql.prepare('SELECT metadata_version FROM files').get()!.metadata_version, 0)
  assert.deepEqual(db.getMetadata(), metadata)
  db.commitScanBatch(batch)
  assert.equal(db.getScanProgress('dates').parsedFiles, 1)
  assert.equal(db.finishScan('dates').completed, true)
  const after = db.getTracksByIds(['track-0'])
  assert.deepEqual(after.tracks, [{ ...before.tracks[0], releaseDate: '2001-03' }])
  assert.equal(after.versions['track-0'], before.versions['track-0'] + 1)
  assert.equal(db.sql.prepare('SELECT metadata_version FROM files').get()!.metadata_version, 1)
  assert.equal(db.getMetadata().revision, metadata.revision + 1)
})

test('cancellation discards staged dates and markers but retains ordinary committed files', (t) => {
  const { db, root, identities } = fixture(t)
  const before = db.getTracksByIds(['track-0'])
  const filePath = join(root, 'new.flac')
  writeFileSync(filePath, 'new')
  const info = statSync(filePath), ordinary = { filePath, size: info.size, mtimeMs: info.mtimeMs }
  assert.deepEqual(start(db, root, [...identities, ordinary]).releaseDateFilePaths, [identities[0].filePath])
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '1997'), {
    identity: ordinary, tracks: [{ id: 'new', filePath, title: 'New file', releaseDate: '2024' }], metadataRead: true
  }] })
  db.setScanState('dates', 'cancelled')
  const after = db.getTracksByIds(['track-0'])
  assert.deepEqual(after.tracks, before.tracks)
  assert.deepEqual(after.versions, before.versions)
  assert.equal(db.getTracksByIds(['new']).tracks[0].releaseDate, '2024')
  assert.equal(db.sql.prepare('SELECT metadata_version FROM files WHERE file_key=?').get(normalizeLibraryFilePath(identities[0].filePath))!.metadata_version, 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM scan_release_dates').get()!.n, 0)
  assert.throws(() => db.finishScan('dates'), /not running/)
  db.resumeScan('dates')
  db.recordScanFiles('dates', [...identities, ordinary])
  assert.deepEqual(db.claimScanFiles('dates').identities, identities)
  assert.equal(db.getScanProgress('dates').committedFiles, 1)
})

test('absent dates complete once while failed reads retain the old date and stay retryable', (t) => {
  const { db, root, identities } = fixture(t, ['absent.flac', 'failed.flac'])
  for (const id of ['track-0', 'track-1']) {
    const page = db.getTracksByIds([id])
    db.patchTracks([{ id, expectedVersion: page.versions[id], patch: { releaseDate: '1980' } }])
  }
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0]), dateResult(identities[1], undefined, 'Unreadable tags')] })
  db.finishScan('dates')
  assert.equal(Object.hasOwn(db.getTracksByIds(['track-0']).tracks[0], 'releaseDate'), false)
  assert.equal(db.getTracksByIds(['track-1']).tracks[0].releaseDate, '1980')
  assert.deepEqual(db.sql.prepare('SELECT metadata_version,status FROM files ORDER BY file_key').all().map((r) => ({ ...r })), [
    { metadata_version: 1, status: 'complete' }, { metadata_version: 0, status: 'complete' }
  ])
  const retry = start(db, root, identities, 'retry')
  assert.deepEqual(retry.identities, [identities[1]])
  assert.deepEqual(retry.releaseDateFilePaths, [identities[1].filePath])
})

test('concurrent manual edits invalidate staged dates before any publication, then narrow retry preserves the edit', (t) => {
  const { db, root, identities } = fixture(t, ['one.flac', 'two.flac'])
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: identities.map((identity) => dateResult(identity, '2005-01-02')) })
  const old = db.getTracksByIds(['track-1'])
  db.patchTracks([{ id: 'track-1', expectedVersion: old.versions['track-1'], patch: { title: 'Latest handwritten title', lyrics: 'Latest lyrics' } }])
  assert.equal(db.finishScan('dates').completed, false)
  assert.ok(db.getTracksByIds(['track-0', 'track-1']).tracks.every((track) => track.releaseDate === undefined))
  assert.equal(db.sql.prepare('SELECT sum(metadata_version) n FROM files').get()!.n, 0)
  db.claimScanDirectories('dates')
  db.recordScanFiles('dates', identities)
  db.recordScanDirectory('dates', { path: root, children: [] })
  assert.deepEqual(db.claimScanFiles('dates').identities, [identities[1]])
  db.commitScanBatch({ jobId: 'dates', sequence: 2, files: [dateResult(identities[1], '2005-01-02')] })
  assert.equal(db.finishScan('dates').completed, true)
  const saved = db.getTracksByIds(['track-1']).tracks[0]
  assert.equal(saved.title, 'Latest handwritten title')
  assert.equal(saved.lyrics, 'Latest lyrics')
  assert.equal(saved.releaseDate, '2005-01-02')
  assert.equal(db.getScanProgress('dates').committedFiles, 2)
})

test('a physical change after staging retries as ordinary metadata, not as a stale date-only read', (t) => {
  const { db, root, identities } = fixture(t)
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '2000')] })
  writeFileSync(identities[0].filePath, 'Changed physical audio')
  assert.equal(db.finishScan('dates').completed, false)
  const info = statSync(identities[0].filePath), changed = { ...identities[0], size: info.size, mtimeMs: info.mtimeMs }
  db.claimScanDirectories('dates')
  db.recordScanFiles('dates', [changed])
  db.recordScanDirectory('dates', { path: root, children: [] })
  const work = db.claimScanFiles('dates')
  assert.deepEqual(work.identities, [changed])
  assert.equal(work.releaseDateFilePaths, undefined)
  db.commitScanBatch({ jobId: 'dates', sequence: 2, files: [{ identity: changed, metadataRead: true,
    tracks: [{ id: 'parsed', filePath: changed.filePath, title: 'Changed audio title', releaseDate: '2010' }] }] })
  db.finishScan('dates')
  assert.equal(db.getTracksByIds(['track-0']).tracks[0].title, 'Changed audio title')
  assert.equal(db.getTracksByIds(['track-0']).tracks[0].releaseDate, '2010')
})

test('exclusion after staging cannot publish a date or its completion marker', (t) => {
  const { db, root, identities } = fixture(t)
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '2000')] })
  db.updateConfiguration({ folders: [root], exclusions: [{ filePath: identities[0].filePath,
    title: 'Manual title', artist: 'Manual artist', excludedAt: '2026-10-25T00:00:00.000Z' }] })
  assert.equal(db.finishScan('dates').completed, false)
  assert.equal(db.finishScan('dates').completed, true)
  assert.equal(db.getTracksByIds(['track-0']).tracks.length, 0, 'the explicit exclusion stays removed')
  assert.equal(db.sql.prepare('SELECT metadata_version FROM files').get()!.metadata_version, 0)
})

test('physical date updates preserve all CUE/ISO logical identities and the other audio-cache fields', (t) => {
  const { db, root, identities } = fixture(t, ['disc.iso'])
  const original = db.getTracksByIds(['track-0']).tracks[0]
  db.importTrack({ ...original, id: 'second', subTrack: 'sacd://second', title: 'Second manual title', cueRange: { startSeconds: 10, endSeconds: 20 } })
  const audio = { ...original, title: 'Physical cache', duration: 123.456 }
  db.sql.prepare('UPDATE files SET audio_metadata=?').run(JSON.stringify(audio))
  const before = db.queryTracks({ sort: 'insertion' }).tracks
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '1993')] })
  db.finishScan('dates')
  assert.deepEqual(db.queryTracks({ sort: 'insertion' }).tracks, before.map((track) => ({ ...track, releaseDate: '1993' })))
  assert.deepEqual(JSON.parse(String(db.sql.prepare('SELECT audio_metadata FROM files').get()!.audio_metadata)), { ...audio, releaseDate: '1993' })
})

test('date-only publication changes no Catalog identities, manual links or identification inputs', (t) => {
  const { db, root, identities } = fixture(t)
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entities = db.sql.prepare('SELECT * FROM catalog_entities ORDER BY id').all()
  const sources = db.sql.prepare('SELECT id,source_key,recording_id,release_id FROM catalog_sources ORDER BY id').all()
  const inputs = db.sql.prepare('SELECT * FROM metadata_identification_inputs ORDER BY entity_id').all()
  const schedule = db.sql.prepare('SELECT * FROM metadata_identification_schedule ORDER BY entity_id').all()
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '2000')] })
  db.finishScan('dates')
  while (db.catalogStatus().localPending) db.catalogAdvance()
  assert.deepEqual(db.sql.prepare('SELECT * FROM catalog_entities ORDER BY id').all(), entities)
  assert.deepEqual(db.sql.prepare('SELECT id,source_key,recording_id,release_id FROM catalog_sources ORDER BY id').all(), sources)
  assert.deepEqual(db.sql.prepare('SELECT * FROM metadata_identification_inputs ORDER BY entity_id').all(), inputs)
  assert.deepEqual(db.sql.prepare('SELECT * FROM metadata_identification_schedule ORDER BY entity_id').all(), schedule)
})

test('parse-only callers remain compatible but cannot overwrite a date-only task with full Track payloads', (t) => {
  const { db, root, identities } = fixture(t)
  const before = db.getTracksByIds(['track-0']).tracks[0]
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [{ identity: identities[0], metadataRead: true,
    tracks: [{ id: 'replacement', filePath: identities[0].filePath, title: 'Parser title', cover: null, lyrics: null, releaseDate: '2020' }] }] })
  db.finishScan('dates')
  assert.deepEqual(db.getTracksByIds(['track-0']).tracks[0], { ...before, releaseDate: '2020' })
})

test('pause retains staged dates; restart recovery discards staging and retries without exposing markers', (t) => {
  const { db, root, path, identities } = fixture(t)
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '2003')] })
  db.setScanState('dates', 'paused')
  assert.equal(db.finishScan('dates').completed, false)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM scan_release_dates').get()!.n, 1)
  db.resumeScan('dates')
  db.recordScanFiles('dates', identities)
  assert.equal(db.claimScanFiles('dates').identities.length, 0)
  db.close()
  const recovered = new LibraryDatabase(path)
  try {
    assert.equal(recovered.getTracksByIds(['track-0']).tracks[0].releaseDate, undefined)
    assert.equal(recovered.sql.prepare('SELECT metadata_version FROM files').get()!.metadata_version, 0)
    recovered.setScanState('dates', 'interrupted')
    recovered.resumeScan('dates')
    recovered.claimScanDirectories('dates')
    recovered.recordScanFiles('dates', identities)
    recovered.recordScanDirectory('dates', { path: root, children: [] })
    assert.deepEqual(recovered.claimScanFiles('dates').releaseDateFilePaths, [identities[0].filePath])
    recovered.commitScanBatch({ jobId: 'dates', sequence: 2, files: [dateResult(identities[0], '2004')] })
    recovered.finishScan('dates')
    assert.equal(recovered.getTracksByIds(['track-0']).tracks[0].releaseDate, '2004')
  } finally { recovered.close() }
})

test('v28 upgrades preserve library content and ordinary checkpoints in a backed-up v29 migration', (t) => {
  const { db, root, path, identities } = fixture(t)
  db.startScan({ id: 'legacy-job', mode: 'startup', roots: [root] })
  db.recordScanFiles('legacy-job', identities)
  db.claimScanFiles('legacy-job')
  db.sql.exec("DROP TABLE scan_release_dates; UPDATE files SET status='pending'; PRAGMA user_version=28")
  const before = db.getTracksByIds(['track-0']), metadata = db.getMetadata()
  db.close()
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
    assert.deepEqual(upgraded.getTracksByIds(['track-0']), before)
    assert.deepEqual(upgraded.getMetadata(), metadata)
    assert.equal(upgraded.getLatestScanJob()!.state, 'running')
    upgraded.setScanState('legacy-job', 'interrupted')
    upgraded.resumeScan('legacy-job')
    upgraded.recordScanFiles('legacy-job', identities)
    assert.deepEqual(upgraded.claimScanFiles('legacy-job').releaseDateFilePaths, [identities[0].filePath])
    const backups = readdirSync(root).filter((name) => name.includes('.v28-backup-'))
    assert.equal(backups.length, 1)
    const backup = new DatabaseSync(join(root, backups[0]), { readOnly: true })
    try { assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 28) }
    finally { backup.close() }
  } finally { upgraded.close() }
})

test('trusted JSON v0 indexes retain the narrow date-only lane after migration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-json-date-only-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filePath = join(root, 'legacy.flac'), library = join(root, 'music-library.json')
  writeFileSync(filePath, 'Legacy audio')
  const info = statSync(filePath), identity = { filePath, size: info.size, mtimeMs: info.mtimeMs }
  const track = { id: 'legacy', filePath, title: 'Handwritten title', cover: 'manual', lyrics: 'manual lyrics' }
  writeFileSync(library, JSON.stringify({ version: 2, revision: 7, folders: [root], exclusions: [], tracks: [track] }))
  writeFileSync(join(root, 'music-library-file-index.json'), JSON.stringify({ version: 1,
    libraryRevision: 7, updatedAt: '2026-10-25', entries: [identity] }))
  const db = await openLibraryDatabase(library)
  try {
    assert.deepEqual(start(db, root, [identity]).releaseDateFilePaths, [filePath])
    db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identity, '2001')] })
    assert.deepEqual(db.getTracksByIds(['legacy']).tracks, [track])
    db.finishScan('dates')
    assert.deepEqual(db.getTracksByIds(['legacy']).tracks, [{ ...track, releaseDate: '2001' }])
    assert.equal(db.sql.prepare('SELECT status FROM files').get()!.status, 'complete')
  } finally { db.close() }
})

test('a failed finalization rolls back all dates, markers and checkpoints together', (t) => {
  const { db, root, identities } = fixture(t, ['one.flac', 'two.flac'])
  const before = db.queryTracks({ sort: 'insertion' })
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: identities.map((identity) => dateResult(identity, '2001')) })
  db.sql.exec("CREATE TRIGGER fail_date_finish BEFORE UPDATE ON scan_jobs WHEN new.state='completed' BEGIN SELECT RAISE(ABORT,'finish failed'); END")
  assert.throws(() => db.finishScan('dates'), /finish failed/)
  assert.deepEqual(db.queryTracks({ sort: 'insertion' }), before)
  assert.equal(db.sql.prepare('SELECT sum(metadata_version) n FROM files').get()!.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM scan_release_dates').get()!.n, 2)
  db.sql.exec('DROP TRIGGER fail_date_finish')
  db.finishScan('dates')
  assert.ok(db.queryTracks({ sort: 'insertion' }).tracks.every((track) => track.releaseDate === '2001'))
})

test('a stale result beyond the first bounded publication page cannot leak earlier dates', (t) => {
  const { db, root, identities } = fixture(t, Array.from({ length: 257 }, (_, i) => `${String(i).padStart(4, '0')}.flac`))
  db.startScan({ id: 'dates', mode: 'startup', roots: [root] })
  for (let offset = 0; offset < identities.length; offset += 256) {
    db.recordScanFiles('dates', identities.slice(offset, offset + 256))
    const page = db.claimScanFiles('dates')
    assert.ok(page.identities.length <= 256)
    db.commitScanBatch({ jobId: 'dates', sequence: offset / 256 + 1, files: page.identities.map((identity) => dateResult(identity, '2000')) })
  }
  db.recordScanDirectory('dates', { path: root, children: [] })
  const last = db.getTracksByIds(['track-256'])
  db.patchTracks([{ id: 'track-256', expectedVersion: last.versions['track-256'], patch: { title: 'Latest edit' } }])
  assert.equal(db.finishScan('dates').completed, false)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM tracks WHERE json_extract(payload,'$.releaseDate') IS NOT NULL").get()!.n, 0)
  assert.equal(db.sql.prepare('SELECT sum(metadata_version) n FROM files').get()!.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM scan_release_dates').get()!.n, 256)
})

test('library reset removes date staging and fences late results from the cancelled epoch', (t) => {
  const { db, root, identities } = fixture(t)
  start(db, root, identities)
  db.commitScanBatch({ jobId: 'dates', sequence: 1, files: [dateResult(identities[0], '2000')] })
  db.resetLibrary()
  assert.equal(db.sql.prepare('SELECT count(*) n FROM scan_release_dates').get()!.n, 0)
  assert.equal(db.getScanProgress('dates').state, 'cancelled')
  assert.equal(db.getMetadata().trackCount, 0)
  assert.throws(() => db.commitScanBatch({ jobId: 'dates', sequence: 2, files: [dateResult(identities[0], '2000')] }), /not running/)
})
