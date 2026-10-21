import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { registerLibraryRecordingFunctions } from '../library/libraryDatabasePlaylist.ts'
import { LibraryDatabaseServiceClient } from '../library/libraryDatabaseServiceClient.ts'
import type { LibraryDocumentExportOptions } from '../library/libraryDatabaseProtocol.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import type { PlaybackSession } from '../core/types.ts'
import type { PersonalBackup, PersonalRestoreOptions } from '../../shared/personalBackup.ts'
import { mergePersonalDomain } from '../../shared/personalBackup.ts'
import {
  applyPendingPersonalRestore,
  applyPendingPersonalRestoreFromDatabase,
  createPersonalBackupFromDatabase,
  parsePersonalBackup,
  previewRestoreFromDatabase,
  readPersonalData,
  stagePersonalRestore,
  stagePersonalRestoreFromDatabase,
  type PersonalLibraryDatabase
} from './personalBackup.ts'

const profileCleanup = new Map<string, Array<() => void | Promise<void>>>()
function profile(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-personal-'))
  const cleanup: Array<() => void | Promise<void>> = []
  profileCleanup.set(root, cleanup)
  t.after(async () => {
    for (const close of cleanup.reverse()) await close()
    rmSync(root, { recursive: true, force: true })
    profileCleanup.delete(root)
  })
  return root
}
function document(root: string, title = 'Current database'): LocalMusicLibraryDocument {
  return {
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [
      {
        filePath: join(root, 'excluded.flac'),
        title: 'Excluded',
        artist: 'Artist',
        excludedAt: '2026-10-01T00:00:00.000Z'
      }
    ],
    tracks: [
      {
        id: 'cue-1',
        filePath: join(root, 'disc.flac'),
        title,
        addedAt: 42,
        cueSheetPath: join(root, 'disc.cue'),
        cueRange: { startSeconds: 0, endSeconds: 30 },
        custom: { retained: true },
        artist: 'Artist',
        album: 'Album'
      }
    ]
  }
}
const options: PersonalRestoreOptions = {
  conflict: 'use-backup',
  mappings: [],
  domains: ['library', 'playlists']
}
function incoming(root: string): PersonalBackup {
  return {
    format: 'twilight-personal-data',
    version: 1,
    createdAt: '2026-10-19T00:00:00.000Z',
    data: {
      library: document(root, 'Restored'),
      playlists: [{ id: 'favorites', name: '收藏', trackIds: ['cue-1'] }]
    }
  }
}
function localDatabase(_t: test.TestContext, root: string) {
  const db = new LibraryDatabase(join(root, 'music-library.sqlite'))
  profileCleanup.get(root)!.push(() => db.close())
  db.replaceDocument({ ...document(root), tracks: [] })
  const api: PersonalLibraryDatabase = {
    exportPlaybackQueue: async (...args) => db.exportPlaybackQueue(...args),
    exportDocument: async (options) => db.exportDocument(options),
    getMetadata: async () => db.getMetadata(),
    restoreDocument: (document, id, revision) => db.restoreDocument(document, id, revision),
    restorePersonalLibrary: (document, conflict, id, revision) =>
      db.restorePersonalLibrary(document, conflict, id, revision),
    previewPersonalLibrary: async (document) => db.previewPersonalLibrary(document)
  }
  return { db, api }
}
function keepStaleJson(root: string): string {
  const original = JSON.stringify(document(root, 'Stale JSON must never win'))
  writeFileSync(join(root, 'music-library.json'), original)
  return original
}

test('database playback backup is portable, retains duplicate occurrence selection and restores without the source queue', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  db.replaceDocument(document(root))
  let queue = db.createLibraryQueue({ ids: ['cue-1', 'cue-1'], sort: 'playlist' })
  const second = db.readLibraryQueue(queue.id).items[1].queueEntryId
  queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId: second }).queue
  const session: PlaybackSession = {
    version: 1,
    savedAt: '2026-10-19T00:00:00Z',
    mode: 'trackAndPosition',
    track: { ...(document(root).tracks[0] as object), queueEntryId: second },
    position: 12,
    libraryQueue: { id: queue.id, revision: queue.revision, entryId: second, index: 1 }
  }
  writeFileSync(
    join(root, 'playback-session.json'),
    JSON.stringify({ version: 2, revision: 4, data: session })
  )
  writeFileSync(join(root, 'playback-queue.json'), '{stale arrays must never load')
  const exported = await createPersonalBackupFromDatabase(root, {}, api)
  const playback = exported.data.playback as PlaybackSession
  assert.equal(playback.libraryQueue, undefined)
  assert.equal(playback.queueRevision, undefined)
  assert.equal(playback.queueIndex, 1)
  assert.equal(playback.queue?.length, 2)
  assert.equal((playback.queue![1] as { queueEntryId: string }).queueEntryId, second)
  assert.notEqual((playback.queue![0] as { queueEntryId: string }).queueEntryId, second)
  assert.deepEqual((playback.queue![1] as Record<string, unknown>).cueRange, {
    startSeconds: 0,
    endSeconds: 30
  })
  const destination = profile(t),
    target = localDatabase(t, destination)
  await stagePersonalRestoreFromDatabase(
    destination,
    exported,
    { ...options, domains: ['library', 'playback'] },
    [],
    target.api
  )
  await applyPendingPersonalRestoreFromDatabase(destination, target.api)
  const restored = readPersonalData(destination, { library: null }).playback as PlaybackSession
  assert.equal(restored.position, 12)
  assert.equal(restored.queue?.length, 2)
  assert.equal(restored.libraryQueue, undefined)
  assert.equal((restored.queue![1] as { queueEntryId: string }).queueEntryId, second)
  assert.throws(
    () => parsePersonalBackup(JSON.stringify({ ...exported, data: { playback: session } })),
    /无效/
  )
  await stagePersonalRestoreFromDatabase(
    root,
    exported,
    { ...options, conflict: 'keep-local', domains: ['playback'] },
    [],
    api
  )
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.deepEqual(
    (readPersonalData(root, { library: null }).playback as PlaybackSession).libraryQueue,
    session.libraryQueue
  )
})

test('playback export fails explicitly on stale revision, over-capacity or library changes without replacing the saved reference', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  db.replaceDocument(document(root))
  let queue = db.createLibraryQueue({})
  const session: PlaybackSession = {
    version: 1,
    savedAt: '',
    mode: 'track',
    position: 0,
    track: { ...(document(root).tracks[0] as object), queueEntryId: queue.selectedEntryId },
    libraryQueue: {
      id: queue.id,
      revision: queue.revision,
      entryId: queue.selectedEntryId!,
      index: 0
    }
  }
  const path = join(root, 'playback-session.json'),
    original = JSON.stringify(session)
  writeFileSync(path, original)
  const exportDocument = api.exportDocument
  api.exportDocument = async (...args) => {
    const result = await exportDocument(...args)
    db.patchTracks([
      {
        id: 'cue-1',
        expectedVersion: db.getTracksByIds(['cue-1']).versions['cue-1'],
        patch: { title: 'changed' }
      }
    ])
    return result
  }
  await assert.rejects(createPersonalBackupFromDatabase(root, {}, api), /曲库发生变化/)
  api.exportDocument = exportDocument
  db.patchTracks([
    {
      id: 'cue-1',
      expectedVersion: db.getTracksByIds(['cue-1']).versions['cue-1'],
      patch: { extra: 'x'.repeat(1024 * 1024) }
    }
  ])
  // 33 duplicate snapshots exceed only the 32 MiB queue cap, not the library cap.
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'insert',
    trackIds: Array(33).fill('cue-1')
  }).queue
  const updated = {
    ...session,
    libraryQueue: { ...session.libraryQueue!, revision: queue.revision }
  }
  writeFileSync(path, JSON.stringify(updated))
  await assert.rejects(createPersonalBackupFromDatabase(root, {}, api), /未截断/)
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(updated))
  writeFileSync(path, original)
  await assert.rejects(createPersonalBackupFromDatabase(root, {}, api), /播放队列已变化/)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('SQLite export and existing-format restore retain CUE IDs, extension data, exclusions and playlist links without touching JSON', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  const original = keepStaleJson(root)
  db.replaceDocument(document(root))
  writeFileSync(
    join(root, 'playlists.json'),
    JSON.stringify({ version: 2, data: incoming(root).data.playlists })
  )
  const exported = await createPersonalBackupFromDatabase(root, {}, api)
  const library = exported.data.library as LocalMusicLibraryDocument
  assert.equal((library.tracks[0] as Record<string, unknown>).title, 'Current database')
  assert.equal((library.tracks[0] as Record<string, unknown>).id, 'cue-1')
  assert.equal((library.tracks[0] as Record<string, unknown>).addedAt, 42)
  assert.deepEqual(library.exclusions, document(root).exclusions)
  assert.deepEqual(exported.data.playlists, incoming(root).data.playlists)
  assert.equal(
    (await previewRestoreFromDatabase(root, exported, {}, api)).rows.find(
      (row) => row.domain === 'library'
    )?.conflicts,
    3
  )
  const destination = profile(t),
    restored = localDatabase(t, destination)
  const retainedSource = keepStaleJson(destination)
  await stagePersonalRestoreFromDatabase(
    destination,
    parsePersonalBackup(JSON.stringify(exported)),
    options,
    [],
    restored.api
  )
  assert.throws(() => applyPendingPersonalRestore(destination), /SQLite/)
  await applyPendingPersonalRestoreFromDatabase(destination, restored.api)
  assert.deepEqual(restored.db.exportDocument().tracks, library.tracks)
  assert.deepEqual(
    JSON.parse(readFileSync(join(destination, 'playlists.json'), 'utf8')).data,
    exported.data.playlists
  )
  assert.equal(readFileSync(join(root, 'music-library.json'), 'utf8'), original)
  assert.equal(readFileSync(join(destination, 'music-library.json'), 'utf8'), retainedSource)
  assert.throws(() => readPersonalData(root), /SQLite/)
  const snapshot = readdirSync(destination).find((name) => name.includes('.pre-restore-'))!
  const previous = new DatabaseSync(join(destination, snapshot), { readOnly: true })
  try {
    registerLibraryRecordingFunctions(previous)
    assert.equal(previous.prepare('SELECT count(*) AS n FROM tracks').get()?.n, 0)
    assert.equal(previous.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
  } finally {
    previous.close()
  }
})

test('redo after a database commit is idempotent and preserves edits made after its lost ACK', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  const original = keepStaleJson(root)
  await stagePersonalRestoreFromDatabase(root, incoming(root), options, [], api)
  await assert.rejects(
    applyPendingPersonalRestoreFromDatabase(root, api, (name) => {
      if (name === 'playlists.json') throw new Error('process died after database commit')
    }),
    /process died/
  )
  assert.equal(db.getMetadata().trackCount, 1)
  const first = db.getTracksByIds(['cue-1'])
  db.patchTracks([
    {
      id: 'cue-1',
      expectedVersion: first.versions['cue-1'],
      patch: { title: 'Edited after restore' }
    }
  ])
  const edited = db.getTracksByIds(['cue-1'])
  assert.ok(existsSync(join(root, 'personal-restore-journal.json')))
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.deepEqual(db.getTracksByIds(['cue-1']), edited)
  assert.equal(readdirSync(root).filter((name) => name.includes('.pre-restore-')).length, 1)
  assert.equal(existsSync(join(root, 'personal-restore-journal.json')), false)
  assert.equal(readFileSync(join(root, 'music-library.json'), 'utf8'), original)
})

test('snapshot failure keeps the database and redo journal intact; replay succeeds after the failure is removed', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  await stagePersonalRestoreFromDatabase(root, incoming(root), options, [], api)
  const before = db.exportDocument()
  const save = db.backupTo.bind(db)
  db.backupTo = async () => {
    throw new Error('SQLITE_FULL')
  }
  await assert.rejects(applyPendingPersonalRestoreFromDatabase(root, api), /SQLITE_FULL/)
  assert.deepEqual(db.exportDocument(), before)
  assert.equal(existsSync(join(root, 'personal-restore-journal.json')), true)
  assert.equal(existsSync(join(root, 'playlists.json')), false)
  db.backupTo = save
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(db.getMetadata().trackCount, 1)
})

test('concurrent library changes reject a staged replacement without clobbering current records', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  await stagePersonalRestoreFromDatabase(root, incoming(root), options, [], api)
  await assert.rejects(
    applyPendingPersonalRestoreFromDatabase(root, api, (name) => {
      if (name === 'music-library.json') db.replaceDocument(document(root, 'Concurrent edit'))
    }),
    /changed concurrently/
  )
  assert.equal(db.queryTracks().tracks[0].title, 'Concurrent edit')
  assert.ok(existsSync(join(root, 'personal-restore-journal.json')))
  assert.equal(existsSync(join(root, 'playlists.json')), false)
})

test('legacy staged requests are applied to SQLite and never to the retained migration JSON', async (t) => {
  const root = profile(t)
  stagePersonalRestore(root, incoming(root), options)
  const { db, api } = localDatabase(t, root)
  const original = keepStaleJson(root)
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(db.queryTracks().tracks[0].title, 'Restored')
  assert.equal(readFileSync(join(root, 'music-library.json'), 'utf8'), original)
})

test('bounded export measures redacted UTF-8 JSON and never changes the unlimited compatibility entry', (t) => {
  const root = profile(t),
    { db } = localDatabase(t, root)
  const saved = document(root)
  Object.assign(saved.tracks[0] as object, {
    title: '中文😀',
    cookie: 'private'.repeat(1000),
    custom: { password: 'private', retained: true },
    streamUrl: 'https://private.test'
  })
  db.replaceDocument(saved)
  const clean = db.exportDocument({ redactPrivateData: true })
  const bytes = Buffer.byteLength(JSON.stringify(clean))
  assert.deepEqual(db.exportDocument({ maxBytes: bytes, redactPrivateData: true }), clean)
  assert.throws(
    () => db.exportDocument({ maxBytes: bytes - 1, redactPrivateData: true }),
    /容量限制/
  )
  assert.throws(() => db.exportDocument({ maxBytes: bytes }), /容量限制/)
  assert.equal(
    (db.exportDocument().tracks[0] as Record<string, unknown>).cookie,
    'private'.repeat(1000)
  )
  assert.equal(JSON.stringify(clean).includes('private'), false)
})

test('a library over the existing 100 MiB backup limit fails explicitly without truncation or JSON fallback', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  keepStaleJson(root)
  const payload = 'x'.repeat(1024 * 1024)
  db.replaceDocument({
    ...document(root),
    tracks: Array.from({ length: 101 }, (_, index) => ({
      id: String(index),
      filePath: join(root, `${index}.flac`),
      extra: payload
    }))
  })
  await assert.rejects(createPersonalBackupFromDatabase(root, {}, api), /容量限制.*未截断/)
  assert.equal(db.getMetadata().trackCount, 101)
  assert.equal(existsSync(join(root, 'personal-restore-pending.json')), false)
})

test('non-library restore does not hydrate or limit a large unrelated library', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  api.exportDocument = async () => {
    throw new Error('library must not be read')
  }
  const selected = { ...options, domains: ['playlists'] as const }
  await stagePersonalRestoreFromDatabase(
    root,
    incoming(root),
    { ...selected, domains: [...selected.domains] },
    [],
    api
  )
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(db.getMetadata().trackCount, 0)
  assert.equal(
    JSON.parse(readFileSync(join(root, 'playlists.json'), 'utf8')).data[0].id,
    'favorites'
  )
})

test('a small restore merges into a library over 100 MiB without exporting or journaling its existing payloads', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  const saved = {
    ...document(root),
    tracks: Array.from({ length: 101 }, (_, index) => ({
      id: `large-${index}`,
      filePath: join(root, `${index}.flac`),
      extra: 'x'.repeat(1024 * 1024)
    }))
  }
  db.replaceDocument(saved)
  const before = db.getTracksByIds(['large-0'])
  api.exportDocument = async () => {
    throw new Error('restore must not export the existing library')
  }
  const preview = await previewRestoreFromDatabase(root, incoming(root), {}, api)
  assert.equal(preview.rows[0].current, 103) // 101 tracks, one root and one exclusion
  await stagePersonalRestoreFromDatabase(root, incoming(root), options, [], api)
  await assert.rejects(
    applyPendingPersonalRestoreFromDatabase(root, api, (name) => {
      if (name === 'playlists.json') throw new Error('inspect durable redo')
    }),
    /inspect durable redo/
  )
  assert.ok(statSync(join(root, 'personal-restore-journal.json')).size < 16 * 1024)
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(db.getMetadata().trackCount, 102)
  const after = db.getTracksByIds(['large-0'])
  assert.deepEqual(after.tracks, before.tracks)
  assert.deepEqual(after.versions, before.versions)
  const previous = JSON.parse(readFileSync(join(root, 'personal-restore-previous.json'), 'utf8'))
  assert.ok(existsSync(previous.data['music-library.json'].databaseSnapshot))
  assert.ok(statSync(previous.data['music-library.json'].databaseSnapshot).size > 100 * 1024 * 1024)
})

for (const conflict of ['keep-local', 'use-backup'] as const) {
  test(`SQLite personal restore preserves the existing ${conflict} identity, alias and exclusion rules`, async (t) => {
    const root = profile(t),
      { db, api } = localDatabase(t, root)
    const local = document(root)
    local.tracks.push(
      { id: 'unchanged', filePath: join(root, 'unchanged.flac'), custom: { retained: true } },
      { id: 'old-alias', filePath: join(root, 'alias.flac'), feedUrl: 'https://feed.test/same' }
    )
    db.replaceDocument(local)
    const before = db.getTracksByIds(['unchanged', 'cue-1'])
    const backup = incoming(root)
    const incomingLibrary = backup.data.library as LocalMusicLibraryDocument
    incomingLibrary.tracks.push(
      { id: 'new-alias', filePath: join(root, 'alias.flac'), feedUrl: 'https://feed.test/same' },
      { id: 'excluded', filePath: join(root, 'excluded.flac') }
    )
    incomingLibrary.exclusions[0].title = 'Incoming exclusion'
    const expected = mergePersonalDomain(
      'library',
      local,
      incomingLibrary,
      conflict
    ) as LocalMusicLibraryDocument
    const excluded = new Set(expected.exclusions.map((item) => item.filePath))
    const sorted = (tracks: unknown[]) =>
      [...tracks].sort((a, b) =>
        String((a as { id: string }).id).localeCompare(String((b as { id: string }).id))
      )
    await stagePersonalRestoreFromDatabase(root, backup, { ...options, conflict }, [], api)
    await applyPendingPersonalRestoreFromDatabase(root, api)
    const actual = db.exportDocument()
    assert.deepEqual(
      sorted(actual.tracks),
      sorted(
        expected.tracks.filter((track) => !excluded.has((track as { filePath: string }).filePath))
      )
    )
    assert.deepEqual(actual.exclusions, expected.exclusions)
    const after = db.getTracksByIds(['unchanged', 'cue-1'])
    assert.equal(after.versions.unchanged, before.versions.unchanged)
    assert.equal(
      after.versions['cue-1'],
      before.versions['cue-1'] + (conflict === 'use-backup' ? 1 : 0)
    )
    assert.equal(db.getTracksByIds(['old-alias', 'new-alias']).tracks.length, 1)
  })
}

test('a prepared legacy redo log is redirected into SQLite with an actual database recovery snapshot', async (t) => {
  const root = profile(t)
  keepStaleJson(root)
  stagePersonalRestore(root, incoming(root), options)
  assert.throws(
    () =>
      applyPendingPersonalRestore(root, () => {
        throw new Error('prepared only')
      }),
    /prepared only/
  )
  const { db, api } = localDatabase(t, root)
  db.replaceDocument(document(root, 'Current SQLite'))
  const original = readFileSync(join(root, 'music-library.json'), 'utf8')
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(db.queryTracks().tracks[0].title, 'Restored')
  assert.equal(readFileSync(join(root, 'music-library.json'), 'utf8'), original)
  const previous = JSON.parse(readFileSync(join(root, 'personal-restore-previous.json'), 'utf8'))
  assert.ok(existsSync(previous.data['music-library.json'].databaseSnapshot))
})

test('a restore transaction failure leaves tracks, versions and redo token retryable together', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  db.replaceDocument(document(root, 'Before failure'))
  const before = db.getTracksByIds(['cue-1'])
  await stagePersonalRestoreFromDatabase(root, incoming(root), options, [], api)
  db.sql.exec(
    "CREATE TRIGGER restore_full BEFORE UPDATE ON tracks BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END;"
  )
  await assert.rejects(applyPendingPersonalRestoreFromDatabase(root, api), /SQLITE_FULL/)
  assert.deepEqual(db.getTracksByIds(['cue-1']), before)
  assert.ok(existsSync(join(root, 'personal-restore-journal.json')))
  db.sql.exec('DROP TRIGGER restore_full')
  await applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(db.getTracksByIds(['cue-1']).tracks[0].title, 'Restored')
  assert.equal(db.getTracksByIds(['cue-1']).versions['cue-1'], before.versions['cue-1'] + 1)
})

test('all redo filenames are checked before any database or JSON write', async (t) => {
  const root = profile(t),
    { db, api } = localDatabase(t, root)
  const before = db.getMetadata()
  writeFileSync(
    join(root, 'personal-restore-journal.json'),
    JSON.stringify({
      writes: {
        'settings.json': { libraryFolders: ['must-not-be-written'] },
        'unexpected.json': {}
      }
    })
  )
  await assert.rejects(applyPendingPersonalRestoreFromDatabase(root, api), /未知文件/)
  assert.equal(existsSync(join(root, 'settings.json')), false)
  assert.deepEqual(db.getMetadata(), before)
})

test(
  'the actual database worker supports bounded export and durable restore replay after restart',
  { timeout: 30_000 },
  async (t) => {
    const root = profile(t),
      children: ChildProcess[] = []
    const open = () =>
      new LibraryDatabaseServiceClient({
        serviceEntry: fileURLToPath(
          new URL('../library/libraryDatabaseService.ts', import.meta.url)
        ),
        libraryFilePath: join(root, 'music-library.json'),
        fork(entry) {
          const child = fork(entry, [], {
            execArgv: ['--experimental-strip-types'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc']
          })
          children.push(child)
          return {
            postMessage: (message) => {
              child.send(message)
            },
            kill: () => {
              child.kill()
            },
            on: child.on.bind(child)
          }
        }
      })
    const clients: LibraryDatabaseServiceClient[] = []
    profileCleanup.get(root)!.push(async () => {
      clients.forEach((client) => client.destroy())
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    })
    const first = open()
    clients.push(first)
    const revision = (await first.getMetadata()).revision
    assert.equal((await first.previewPersonalLibrary(document(root))).incoming, 3)
    await first.restorePersonalLibrary(
      document(root, 'Worker restore'),
      'use-backup',
      'worker-restore',
      revision
    )
    const expected = await first.exportDocument()
    await assert.rejects(
      first.exportDocument({ maxBytes: 1 } as LibraryDocumentExportOptions),
      /容量限制/
    )
    first.destroy()
    if (children[0].exitCode === null && children[0].signalCode === null)
      await once(children[0], 'exit')
    const next = open()
    clients.push(next)
    await next.restorePersonalLibrary(
      document(root, 'Must not replace'),
      'use-backup',
      'worker-restore',
      revision
    )
    assert.deepEqual(await next.exportDocument(), expected)
  }
)
