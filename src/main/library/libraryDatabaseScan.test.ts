import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import { LOCAL_LIBRARY_METADATA_VERSION } from '../../shared/localLibraryScan.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'library-durable-'))
  const path = join(root, 'library.sqlite'),
    db = new LibraryDatabase(path)
  db.updateConfiguration({ folders: [root], exclusions: [] })
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const identity = (name: string): LocalLibraryFileIdentity => {
    const filePath = join(root, name)
    writeFileSync(filePath, name)
    const info = statSync(filePath)
    return { filePath, size: info.size, mtimeMs: info.mtimeMs }
  }
  return { db, root, identity }
}

test('identical full metadata commits advance scan checkpoints without invalidating content queries', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    track = { id: 'one', filePath: one.filePath, title: 'Unchanged', addedAt: 7, custom: 'keep' }
  db.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [track] })
  db.startScan({ id: 'full', mode: 'full', roots: [root] })
  db.claimScanDirectories('full')
  db.recordScanFiles('full', [one])
  db.recordScanDirectory('full', { path: root, children: [] })
  assert.deepEqual(db.claimScanFiles('full').identities, [one])
  const before = db.getMetadata(),
    page = db.queryTracks({ sort: 'title', contentRevision: before.revision }),
    files = db.sql.prepare('SELECT file_key,content_version FROM files').all(),
    batch = {
      jobId: 'full',
      sequence: 1,
      files: [
        {
          identity: one,
          tracks: [{ id: 'one', filePath: one.filePath, title: 'Unchanged' }],
          metadataRead: true
        }
      ]
    }
  assert.deepEqual(db.commitScanBatch(batch), before)
  assert.deepEqual(db.queryTracks({ sort: 'title', contentRevision: before.revision }), page)
  assert.deepEqual(db.sql.prepare('SELECT file_key,content_version FROM files').all(), files)
  assert.equal(db.getScanProgress('full').parsedFiles, 1)
  assert.equal(db.getScanProgress('full').committedFiles, 1)
  assert.deepEqual(db.commitScanBatch(batch), before)
  assert.equal(db.getScanProgress('full').parsedFiles, 1)
  assert.deepEqual(db.finishScan('full').metadata, before)
})

test('mixed full commits publish real changes once and still write later tracks in the batch', (t) => {
  const { db, root, identity } = fixture(t),
    identities = ['one', 'two', 'three'].map((name) => identity(`${name}.flac`)),
    tracks = identities.map((item, index) => ({
      id: String(index),
      filePath: item.filePath,
      title: 'Before'
    }))
  db.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks })
  db.startScan({ id: 'full', mode: 'full', roots: [root] })
  db.recordScanFiles('full', identities)
  db.claimScanFiles('full')
  const before = db.getMetadata(),
    versions = db.getTracksByIds(tracks.map((track) => track.id)).versions
  db.commitScanBatch({
    jobId: 'full',
    sequence: 1,
    files: identities.map((item, index) => ({
      identity: item,
      tracks: [{ ...tracks[index], title: index ? `After ${index}` : 'Before' }],
      metadataRead: true
    }))
  })
  assert.equal(db.getMetadata().revision, before.revision + 1)
  const after = db.getTracksByIds(tracks.map((track) => track.id))
  assert.deepEqual(
    after.tracks.map((track) => track.title),
    ['Before', 'After 1', 'After 2']
  )
  for (let index = 0; index < tracks.length; index++)
    assert.equal(after.versions[String(index)], versions[String(index)] + (index ? 1 : 0))
  assert.throws(
    () => db.queryTracks({ contentRevision: before.revision }),
    /曲库在读取期间发生变化/
  )
})

test('full metadata that only removes a logical segment still publishes its deletion', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    tracks = ['1', '2'].map((subTrack) => ({
      id: subTrack,
      filePath: one.filePath,
      subTrack,
      title: subTrack
    }))
  db.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks })
  db.startScan({ id: 'full', mode: 'full', roots: [root] })
  db.recordScanFiles('full', [one])
  db.claimScanFiles('full')
  const before = db.getMetadata(),
    version = db.getTracksByIds(['1']).versions['1']
  db.commitScanBatch({
    jobId: 'full',
    sequence: 1,
    files: [{ identity: one, tracks: [tracks[0]], metadataRead: true }]
  })
  assert.equal(db.getMetadata().revision, before.revision + 1)
  assert.equal(db.getMetadata().trackCount, 1)
  const after = db.getTracksByIds(['1', '2'])
  assert.deepEqual(after.tracks, [tracks[0]])
  assert.equal(after.versions['1'], version)
})

test('enumeration batches read live configuration without requesting unrelated library counts', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    two = identity('two.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.claimScanDirectories('job')
  const metadata = t.mock.method(db, 'getMetadata')
  db.recordScanFiles('job', [one])
  db.recordScanDirectory('job', { path: root, children: [], complete: false })
  assert.equal(metadata.mock.callCount(), 0)

  db.updateConfiguration({
    folders: [root],
    exclusions: [{ filePath: one.filePath, title: '', artist: '', excludedAt: '' }]
  })
  const configurationReads = metadata.mock.callCount()
  db.recordScanFiles('job', [one, two])
  db.recordScanDirectory('job', { path: root, children: [], complete: false })
  assert.equal(metadata.mock.callCount(), configurationReads)
  assert.equal(
    db.sql
      .prepare('SELECT state FROM scan_items WHERE job_id=? AND file_key=?')
      .get('job', normalizeLibraryFilePath(one.filePath))!.state,
    'excluded'
  )
  assert.deepEqual(db.claimScanFiles('job').identities, [two])

  db.setLibraryRoots([])
  const revokedReads = metadata.mock.callCount()
  db.recordScanFiles('job', [two])
  assert.throws(
    () => db.recordScanDirectory('job', { path: root, children: [] }),
    /Directory is no longer authorized/
  )
  assert.equal(metadata.mock.callCount(), revokedReads)
  assert.equal(
    db.sql
      .prepare('SELECT state FROM scan_items WHERE job_id=? AND file_key=?')
      .get('job', normalizeLibraryFilePath(two.filePath))!.state,
    'excluded'
  )
})

test('invalid identities and unauthorized directory children roll back their whole enumeration batches', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.claimScanDirectories('job')
  const metadata = db.getMetadata()
  assert.throws(
    () => db.recordScanFiles('job', [one, { ...one, size: -1 }]),
    /Invalid file identity/
  )
  assert.equal(db.getScanProgress('job').checkedFiles, 0)
  assert.deepEqual(db.sql.prepare('SELECT * FROM files').all(), [])
  assert.deepEqual(db.getMetadata(), metadata)
  assert.throws(
    () =>
      db.recordScanDirectory('job', {
        path: root,
        children: [join(root, 'valid'), join(root, '..', 'outside')],
        complete: false
      }),
    /Invalid scan child directory/
  )
  assert.deepEqual(
    db.sql
      .prepare('SELECT path,state FROM scan_directories WHERE job_id=?')
      .all('job')
      .map((row) => ({ ...row })),
    [{ path: normalizeLibraryFilePath(root), state: 'working' }]
  )
})

test('import exclusion restoration and the durable job roll back together, without touching sibling scopes', (t) => {
  const { db, root } = fixture(t)
  const album = join(root, 'album'),
    one = join(album, 'one.wav'),
    sibling = join(root, 'album-other', 'two.wav')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [
      { id: 'one', filePath: one },
      { id: 'two', filePath: sibling }
    ]
  })
  db.updateConfiguration({
    folders: [root],
    exclusions: [one, sibling].map((filePath) => ({
      filePath,
      title: '',
      artist: '',
      excludedAt: new Date().toISOString()
    }))
  })
  const before = db.getMetadata(),
    files = db.sql.prepare('SELECT file_key,content_version FROM files ORDER BY file_key').all()
  db.sql.exec(
    "CREATE TRIGGER fail_import BEFORE INSERT ON meta WHEN NEW.key='exclusions' BEGIN SELECT RAISE(ABORT,'disk full'); END"
  )
  assert.throws(
    () => db.startScan({ id: 'import', mode: 'watch', roots: [album], restoreExcluded: true }),
    /disk full/
  )
  assert.deepEqual(db.getMetadata(), before)
  assert.equal(db.getLatestScanJob(), null)
  assert.deepEqual(
    db.sql.prepare('SELECT file_key,content_version FROM files ORDER BY file_key').all(),
    files
  )
  db.sql.exec('DROP TRIGGER fail_import')
  db.startScan({ id: 'import', mode: 'watch', roots: [album], restoreExcluded: true })
  assert.deepEqual(
    db.getMetadata().exclusions.map((entry) => entry.filePath),
    [sibling]
  )
  assert.equal(db.getMetadata().revision, before.revision + 1)
  assert.equal(db.getLatestScanJob()?.id, 'import')
  const next = db.sql.prepare('SELECT file_key,content_version FROM files ORDER BY file_key').all()
  for (const row of next) {
    const old = files.find((file) => file.file_key === row.file_key)!
    assert.equal(
      row.content_version,
      Number(old.content_version) + (String(row.file_key).endsWith('one.wav') ? 1 : 0)
    )
  }
})

test('cancel retains committed results; explicit resume of a full rescan skips its unchanged checkpoints', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    two = identity('two.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.claimScanDirectories('job')
  db.recordScanFiles('job', [one, two])
  const work = db.claimScanFiles('job', 1)
  assert.equal(work.identities[0].filePath, one.filePath)
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  db.setScanState('job', 'cancelled')
  assert.equal(db.getMetadata().trackCount, 1)
  assert.deepEqual(db.claimScanFiles('job').identities, [])
  assert.throws(() => db.finishScan('job'), /not running/)
  db.resumeScan('job')
  db.claimScanDirectories('job')
  db.recordScanFiles('job', [one, two])
  assert.deepEqual(
    db.claimScanFiles('job').identities.map((item) => item.filePath),
    [two.filePath]
  )
  db.commitScanBatch({
    jobId: 'job',
    sequence: 2,
    files: [{ identity: two, tracks: [{ id: 'two', filePath: two.filePath }], metadataRead: true }]
  })
  db.recordScanDirectory('job', { path: root, children: [] })
  assert.equal(db.finishScan('job').metadata.trackCount, 2)
})

test('revoked scopes cannot be resumed or handed to the metadata worker', (t) => {
  const { db, root, identity } = fixture(t)
  const one = identity('one.flac')
  db.startScan({ id: 'revoked', mode: 'full', roots: [root] })
  db.recordScanFiles('revoked', [one])
  db.setLibraryRoots([])
  assert.throws(() => db.claimScanDirectories('revoked'), /no longer authorized/)
  assert.throws(() => db.claimScanFiles('revoked'), /no longer authorized/)
  db.setScanState('revoked', 'cancelled')
  assert.throws(() => db.resumeScan('revoked'), /no longer authorized/)
  assert.equal(db.getScanProgress('revoked').state, 'cancelled')
})

test('latest scan lookup includes completion instead of reviving historical cancelled jobs', (t) => {
  const { db, root } = fixture(t)
  assert.equal(db.getLatestScanJob(), null)
  db.startScan({ id: 'obsolete', mode: 'full', roots: [root] })
  db.setScanState('obsolete', 'cancelled')
  db.startScan({ id: 'current', mode: 'startup', roots: [root] })
  db.recordScanDirectory('current', { path: root, children: [] })
  db.finishScan('current')
  assert.equal(db.getLatestScanJob()?.id, 'current')
  assert.equal(db.getLatestScanJob()?.state, 'completed')
  assert.deepEqual(
    db.listScanJobs().map((job) => job.id),
    ['obsolete']
  )
})

test('resuming a full scan after restoring an empty snapshot rebuilds missing committed tracks', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [one])
  db.claimScanFiles('job')
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  db.setScanState('job', 'cancelled')
  db.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [] })
  db.resumeScan('job')
  db.recordScanFiles('job', [one])
  assert.deepEqual(db.claimScanFiles('job').identities, [one])
  db.recordScanDirectory('job', { path: root, children: [] })
  assert.throws(() => db.finishScan('job'), /Incomplete/)
  db.commitScanBatch({
    jobId: 'job',
    sequence: 2,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  assert.equal(db.finishScan('job').metadata.trackCount, 1)
})

test('completed checkpoints cannot bypass stale metadata or incomplete file state', async (t) => {
  for (const update of [
    `metadata_version=${LOCAL_LIBRARY_METADATA_VERSION - 1}`,
    "status='failed'",
    'identity=NULL'
  ]) {
    await t.test(update, (t) => {
      const { db, root, identity } = fixture(t),
        one = identity('one.flac')
      db.startScan({ id: 'job', mode: 'full', roots: [root] })
      db.recordScanFiles('job', [one])
      db.claimScanFiles('job')
      db.commitScanBatch({
        jobId: 'job',
        sequence: 1,
        files: [
          { identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }
        ]
      })
      db.setScanState('job', 'cancelled')
      db.sql.exec(`UPDATE files SET ${update}`)
      db.resumeScan('job')
      db.recordScanFiles('job', [one])
      assert.deepEqual(db.claimScanFiles('job').identities, [one])
    })
  }
})

test('a partially restored CUE file invalidates its full-scan checkpoint', (t) => {
  const { db, root, identity } = fixture(t),
    audio = identity('disc.flac')
  const tracks = [1, 2].map((number) => ({
    id: `cue-${number}`,
    filePath: audio.filePath,
    cueSheetPath: join(root, 'disc.cue'),
    trackNumber: number,
    cueRange: { startSeconds: (number - 1) * 100, endSeconds: number * 100 }
  }))
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [audio])
  db.claimScanFiles('job')
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [{ identity: audio, tracks, metadataRead: true }]
  })
  db.setScanState('job', 'cancelled')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [tracks[0]]
  })
  db.resumeScan('job')
  db.recordScanFiles('job', [audio])
  assert.deepEqual(db.claimScanFiles('job').identities, [audio])
})

test('new ordinary checks reuse durable unchanged identities, while a new full rescan forces metadata', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac')
  db.startScan({ id: 'initial', mode: 'startup', roots: [root] })
  db.recordScanFiles('initial', [one])
  db.claimScanFiles('initial')
  db.commitScanBatch({
    jobId: 'initial',
    sequence: 1,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  db.setScanState('initial', 'cancelled')
  db.startScan({ id: 'check', mode: 'startup', roots: [root] })
  db.recordScanFiles('check', [one])
  assert.deepEqual(db.claimScanFiles('check').identities, [])
  db.setScanState('check', 'cancelled')
  db.startScan({ id: 'full', mode: 'full', roots: [root] })
  db.recordScanFiles('full', [one])
  assert.equal(db.claimScanFiles('full').identities.length, 1)
})

test('only a successful complete enumeration can remove absent tracks, and cleanup is scoped', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [
      { id: 'gone', filePath: join(root, 'gone.flac') },
      { id: 'outside', filePath: join(root, '..', 'outside.flac') }
    ]
  })
  db.startScan({ id: 'failed', mode: 'startup', roots: [root] })
  db.recordScanDirectory('failed', { path: root, children: [], error: 'EACCES' })
  assert.throws(() => db.finishScan('failed'), /Incomplete/)
  assert.equal(db.getMetadata().trackCount, 2)
  db.setScanState('failed', 'failed')
  db.startScan({ id: 'good', mode: 'startup', roots: [root] })
  db.recordScanFiles('good', [one])
  db.claimScanFiles('good')
  db.commitScanBatch({
    jobId: 'good',
    sequence: 1,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  assert.throws(() => db.finishScan('good'), /Incomplete/)
  db.recordScanDirectory('good', { path: root, children: [] })
  const completed = db.finishScan('good')
  assert.equal(completed.removedFileCount, 1)
  assert.deepEqual(
    db.getTracksByIds(['gone', 'one', 'outside']).tracks.map((item) => item.id),
    ['one', 'outside']
  )
})

test('per-file versions reject relevant stale results without restarting unrelated work', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    two = identity('two.flac')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [
      { id: 'one', filePath: one.filePath, title: 'Original' },
      { id: 'two', filePath: two.filePath }
    ]
  })
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [one, two])
  db.claimScanFiles('job')
  const version = db.getTracksByIds(['one']).versions.one
  db.patchTracks([{ id: 'one', expectedVersion: version, patch: { title: 'User edit' } }])
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [
      {
        identity: one,
        tracks: [{ id: 'one', filePath: one.filePath, title: 'Stale tags' }],
        metadataRead: true
      },
      {
        identity: two,
        tracks: [{ id: 'two', filePath: two.filePath, title: 'Fresh tags' }],
        metadataRead: true
      }
    ]
  })
  assert.deepEqual(
    db.getTracksByIds(['one', 'two']).tracks.map((item) => item.title),
    ['User edit', 'Fresh tags']
  )
  assert.equal(db.listScanJobs()[0].committedFiles, 1)
})

test('excluded files and a directory revoked after task claim cannot be re-added', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    two = identity('two.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [one, two])
  db.claimScanFiles('job')
  db.updateConfiguration({
    folders: [root],
    exclusions: [{ filePath: one.filePath, title: '', artist: '', excludedAt: '' }]
  })
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  db.updateConfiguration({ folders: [], exclusions: [] })
  db.commitScanBatch({
    jobId: 'job',
    sequence: 2,
    files: [{ identity: two, tracks: [{ id: 'two', filePath: two.filePath }], metadataRead: true }]
  })
  assert.equal(db.getMetadata().trackCount, 0)
})

test('failed metadata is recorded without replacing a playable track and remains retryable', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'one', filePath: one.filePath, duration: 300, title: 'Playable' }]
  })
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [one])
  db.claimScanFiles('job')
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [
      {
        identity: one,
        tracks: [{ id: 'fallback', filePath: one.filePath, duration: 0 }],
        metadataRead: false,
        error: 'Metadata timeout'
      }
    ]
  })
  assert.equal(db.getTracksByIds(['one']).tracks[0].duration, 300)
  assert.equal(db.listScanJobs()[0].failedFiles, 1)
  db.setScanState('job', 'failed')
  db.startScan({ id: 'retry', mode: 'startup', roots: [root] })
  db.recordScanFiles('retry', [one])
  assert.equal(db.claimScanFiles('retry').identities.length, 1)
})

test('SQLite disk-full rollback preserves the prior library and the original error', (t) => {
  const { db, root } = fixture(t)
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.flac'), title: 'Before' }]
  })
  const before = db.exportDocument(),
    version = db.getTracksByIds(['one']).versions.one
  const pages = Number(db.sql.prepare('PRAGMA page_count').get()?.page_count)
  db.sql.exec(`PRAGMA max_page_count=${pages + 1}`)
  assert.throws(
    () =>
      db.patchTracks([
        {
          id: 'one',
          expectedVersion: version,
          patch: { title: 'must roll back', extension: 'x'.repeat(1_000_000) }
        }
      ]),
    /full/
  )
  assert.deepEqual(db.exportDocument(), before)
})

test('a malformed sibling result rolls back all tracks, identities and checkpoint progress in its batch', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    two = identity('two.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [one, two])
  db.claimScanFiles('job')
  const before = db.getMetadata()
  assert.throws(
    () =>
      db.commitScanBatch({
        jobId: 'job',
        sequence: 1,
        files: [
          { identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true },
          {
            identity: two,
            tracks: [{ id: 'wrong-file', filePath: one.filePath }],
            metadataRead: true
          }
        ]
      }),
    /mismatched file/
  )
  assert.deepEqual(db.getMetadata(), before)
  assert.equal(db.listScanJobs()[0].committedFiles, 0)
  assert.deepEqual(db.getFileIdentities(), [])
})

test('pause stops claims while preserving already claimed work, and a second active scan is rejected', (t) => {
  const { db, root, identity } = fixture(t),
    one = identity('one.flac'),
    two = identity('two.flac')
  db.startScan({ id: 'job', mode: 'full', roots: [root] })
  db.recordScanFiles('job', [one, two])
  db.claimScanFiles('job', 1)
  db.setScanState('job', 'paused')
  assert.deepEqual(db.claimScanFiles('job').identities, [])
  assert.deepEqual(db.claimScanDirectories('job').directories, [])
  assert.throws(
    () => db.startScan({ id: 'conflict', mode: 'watch', roots: [root] }),
    /already active/
  )
  db.commitScanBatch({
    jobId: 'job',
    sequence: 1,
    files: [{ identity: one, tracks: [{ id: 'one', filePath: one.filePath }], metadataRead: true }]
  })
  db.resumeScan('job')
  assert.deepEqual(
    db.claimScanFiles('job').identities.map((item) => item.filePath),
    [two.filePath]
  )
})

test('stable CUE IDs preserve legacy fields when a rescan supplies previously missing segment metadata', (t) => {
  const { db, root, identity } = fixture(t),
    audio = identity('disc.flac'),
    cueSheetPath = join(root, 'disc.cue')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [
      {
        id: 'stable-cue-id',
        filePath: audio.filePath,
        cueSheetPath,
        cueRange: { startSeconds: 0, endSeconds: 100 },
        addedAt: 123,
        extension: { recording: 'original' },
        title: 'Old title'
      }
    ]
  })
  db.startScan({ id: 'repair-cue', mode: 'full', roots: [root] })
  db.recordScanFiles('repair-cue', [audio])
  db.claimScanFiles('repair-cue')
  db.commitScanBatch({
    jobId: 'repair-cue',
    sequence: 1,
    files: [
      {
        identity: audio,
        metadataRead: true,
        tracks: [
          {
            id: 'stable-cue-id',
            filePath: audio.filePath,
            cueSheetPath,
            trackNumber: 1,
            cueRange: { startSeconds: 0, endSeconds: 101 },
            addedAt: 999,
            title: 'New title'
          }
        ]
      }
    ]
  })
  const result = db.getTracksByIds(['stable-cue-id']).tracks[0]
  assert.equal(result.addedAt, 123)
  assert.deepEqual(result.extension, { recording: 'original' })
  assert.equal(result.title, 'New title')
  assert.equal(result.trackNumber, 1)
})
