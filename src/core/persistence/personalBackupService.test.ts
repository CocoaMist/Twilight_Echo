import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import {
  PERSONAL_DOMAINS,
  PERSONAL_V1_DOMAINS,
  remapPersonalPaths,
  type PersonalData
} from '../../shared/personalBackup.ts'
import type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
import { CorePersonalBackupService } from './personalBackupService.ts'
import { createPersonalBackupRepository } from './personalBackup.ts'
import { PERSONAL_BACKUP_LIMIT, type PersonalRestoreOptions } from '../../shared/personalBackup.ts'
import { emptyMusicBackupRecords, type MusicPersonalBackupDocument } from '../../shared/musicPersonalBackup.ts'
import type { TrackData } from '../../shared/track.ts'

import { personalBackupFixture as backup } from './personalBackup.fixture.ts'

function profile(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'core-personal-backup-'))
  const library = new LibraryDatabase(join(root, 'music-library.sqlite'))
  const state = new CoreStateDatabase(join(root, 'core-state.sqlite'))
  state.begin('upgrade', { version: 1, counts: emptyCoreStateCounts() })
  state.commit('upgrade')
  t.after(() => {
    library.close()
    state.close()
    rmSync(root, { recursive: true, force: true })
  })
  const database: PersonalLibraryDatabase & {
    corePersonalRestore(): Promise<{ id: string | null; applied: boolean }>
  } = {
    exportDocument: async (...args) => library.exportDocument(...args),
    restoreDocument: (...args) => library.restoreDocument(...args),
    restorePersonalLibrary: (...args) => library.restorePersonalLibrary(...args),
    previewPersonalLibrary: async (...args) => library.previewPersonalLibrary(...args),
    getMetadata: async () => library.getMetadata(),
    exportPlaybackQueue: async (...args) => library.exportPlaybackQueue(...args),
    corePersonalRestore: async () => state.restorePersonalData()
  }
  const data = (): PersonalData => {
    const rows = state.read('versions').rows
    const versions = {
      version: 1,
      tracks: { versions: [] as unknown[], families: [] as unknown[] },
      albums: { versions: [] as unknown[], families: [] as unknown[] }
    }
    for (const row of rows) {
      const [scope, kind] = row.key.split(':') as ['tracks' | 'albums', 'versions' | 'families']
      versions[scope][kind].push(row.value)
    }
    return {
      statistics: {
        days: Object.fromEntries(
          state.read('statistics-days').rows.map((row) => [row.key, row.value])
        ),
        tracks: Object.fromEntries(
          state.read('statistics-tracks').rows.map((row) => [row.key, row.value])
        )
      },
      ...(rows.length ? { versions } : {})
    }
  }
  let serial = 0,
    flushes = 0
  const repository = createPersonalBackupRepository()
  const input = join(root, 'incoming.json'),
    output = join(root, 'export.json')
  const service = new CorePersonalBackupService({
    root,
    database,
    personalData: data,
    flush: async () => {
      flushes++
    },
    chooseFile: async (kind) => (kind === 'import' ? input : output),
    chooseFolder: async () => 'D:/Music',
    authorizeRoots: async (roots) => {
      assert.deepEqual(roots, ['D:/Music'])
      return roots
    },
    newId: () => `preview:${++serial}`
  })
  return {
    root,
    library,
    state,
    database,
    repository,
    service,
    input,
    output,
    data,
    flushes: () => flushes
  }
}

function musicProfile(t: test.TestContext) {
  const f = profile(t)
  Object.assign(f.database, {
    preferencesPlaylistsLoad: async () => f.library.preferencesPlaylistsLoad(),
    preferencesPlaylistsRestore: (...args: Parameters<LibraryDatabase['preferencesPlaylistsRestore']>) => Promise.resolve(f.library.preferencesPlaylistsRestore(...args)),
    musicBackupRevision: async () => f.library.musicBackupRevision(),
    musicBackupExport: async (maxBytes: number) => f.library.musicBackupExport(maxBytes),
    musicBackupPreview: async (...args: Parameters<LibraryDatabase['musicBackupPreview']>) => f.library.musicBackupPreview(...args),
    musicBackupRestore: (...args: Parameters<LibraryDatabase['musicBackupRestore']>) => f.library.musicBackupRestore(...args)
  })
  f.library.replaceDocument(backup().data.library as Parameters<LibraryDatabase['replaceDocument']>[0])
  while (f.library.catalogStatus().localPending) f.library.catalogAdvance()
  const recording = f.library.catalogQuery({ kind: 'recording' }).items[0].id
  const track = f.library.exportDocument().tracks[0] as TrackData
  f.library.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-10-24T00:00:00.000Z', data: [
    { id: 'default-view', name: '我收藏的音乐', isDefault: true, createdAt: '2026-10-24T00:00:00.000Z', trackIds: [track.id], trackSnapshots: { [track.id]: track } },
    { id: 'ordinary', name: '普通歌单', createdAt: '2026-10-24T00:00:00.000Z', trackIds: [track.id, track.id] }
  ] }, 100)
  const rate = (steps: number | null) => f.library.ratingsSet({ entityId: recording, token: f.library.ratingsDetail(recording).token, steps }, Date.now())
  rate(7)
  return { ...f, recording, rate }
}

test('all ten domains round-trip through Core repositories, SQLite and the existing restart journal', async (t) => {
  const f = profile(t),
    incoming = backup()
  f.repository.writePersonalBackupFile(f.input, incoming)
  const preview = await f.service.preview()
  assert.deepEqual(
    preview!.rows.map((row) => row.domain),
    PERSONAL_V1_DOMAINS
  )
  const options = {
    domains: [...PERSONAL_DOMAINS],
    conflict: 'use-backup' as const,
    mappings: [{ from: 'C:/Old', to: 'D:/Music' }]
  }
  await assert.rejects(f.service.stage({ id: 'stale', options }), { code: 'STALE_REVISION' })
  assert.deepEqual(await f.service.stage({ id: preview!.id, options }), { restartRequired: true })
  assert.equal(f.library.getMetadata().trackCount, 0)
  assert.equal(f.state.read('versions').rows.length, 0)
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  await f.service.initialize()
  assert.equal(f.repository.readRendererRestore(f.root), null)
  assert.equal(existsSync(join(f.root, 'personal-restore-pending.json')), false)
  assert.equal(existsSync(join(f.root, 'music-library.json')), false)
  assert.equal(f.library.getMetadata().trackCount, 1)
  assert.equal(await f.service.export(), true)
  const restored = f.repository.readBackupFile(f.output)
  const expected = remapPersonalPaths(incoming.data, options.mappings) as PersonalData
  for (const domain of PERSONAL_DOMAINS.filter((domain) => domain !== 'library'))
    assert.deepEqual(restored.data[domain], expected[domain], domain)
  const library = restored.data.library as {
    tracks: unknown[]
    folders: string[]
    exclusions: unknown[]
  }
  assert.deepEqual(library.tracks, (expected.library as typeof library).tracks)
  assert.deepEqual(library.folders, ['D:/Music'])
  assert.deepEqual(library.exclusions, [])
  assert.equal(f.flushes(), 3)
  const previous = JSON.parse(readFileSync(join(f.root, 'personal-restore-previous.json'), 'utf8'))
  assert.match(previous.data['music-library.json'].databaseSnapshot, /pre-restore-/)
  await f.service.shutdown()
})

test('a legacy renderer journal merges after browser migration and its durable token prevents a lost ACK from overwriting later data', async (t) => {
  const f = profile(t)
  const request = {
    id: 'legacy-restore',
    conflict: 'use-backup',
    data: { statistics: backup().data.statistics, versions: backup().data.versions }
  }
  const journal = join(f.root, 'personal-restore-renderer.json')
  writeFileSync(journal, JSON.stringify(request))
  await f.service.initialize()
  const revision = f.state.read('statistics-days').revision
  f.state.write('statistics-days', [{ key: '2026-10-03', value: 500 }], revision)
  writeFileSync(journal, JSON.stringify(request))
  assert.deepEqual(await f.database.corePersonalRestore(), { id: request.id, applied: false })
  assert.equal(f.state.read('statistics-days').rows[0].value, 500)
  assert.equal(f.state.read('statistics-days').revision, revision + 1)
  assert.equal(existsSync(journal), false)
  await f.service.shutdown()
})

test('statistics and version restore rollback together; the retained journal succeeds after the actual database error is repaired', async (t) => {
  const f = profile(t)
  const journal = join(f.root, 'personal-restore-renderer.json')
  writeFileSync(
    journal,
    JSON.stringify({
      id: 'atomic-restore',
      conflict: 'keep-local',
      data: { statistics: backup().data.statistics, versions: backup().data.versions }
    })
  )
  const before = f.state.read('statistics-days')
  f.state.sql.exec(
    `CREATE TRIGGER fail_version BEFORE INSERT ON core_state WHEN NEW.domain='versions' BEGIN SELECT RAISE(ABORT, 'disk-full-fixture'); END`
  )
  await assert.rejects(f.service.initialize(), /disk-full-fixture/)
  assert.deepEqual(f.state.read('statistics-days'), before)
  assert.equal(f.state.sql.prepare('SELECT * FROM core_personal_restore').get(), undefined)
  assert.equal(existsSync(journal), true)
  f.state.sql.exec('DROP TRIGGER fail_version')
  await f.service.initialize()
  assert.equal(f.state.read('statistics-days').rows[0].value, 20)
  assert.equal(f.state.read('versions').rows[0].key, 'tracks:versions:version')
  await f.service.shutdown()
})

test('capable Core defaults to v2, preserves ordinary occurrences and exports favorite members only in music', async (t) => {
  const f = musicProfile(t)
  assert.equal(await f.service.export(), true)
  const saved = f.repository.readBackupFile(f.output)
  assert.equal(saved.version, 2)
  const playlists = saved.data.playlists as Array<{ id: string; isDefault?: boolean; trackIds: string[]; trackSnapshots?: unknown }>
  assert.deepEqual(playlists.find((p) => p.isDefault)?.trackIds, [])
  assert.equal(playlists.find((p) => p.isDefault)?.trackSnapshots, undefined)
  assert.deepEqual(playlists.find((p) => p.id === 'ordinary')?.trackIds, ['song', 'song'])
  const music = saved.data.music as MusicPersonalBackupDocument
  assert.equal(music.records.ratings[0].steps, 7)
  assert.equal(music.records.preferences[0].state, 'favorite')
  assert.deepEqual(JSON.parse(String(music.records.favorites[0].payload))[0].trackIds, ['song'])
  await f.service.shutdown()
})

test('the explicit main compatibility export remains v1 even when its database supports music', async (t) => {
  const f = musicProfile(t)
  const saved = await f.repository.createPersonalBackupV1FromDatabase(f.root, {}, f.database)
  assert.equal(saved.version, 1)
  assert.equal(saved.data.music, undefined)
  const playlists = saved.data.playlists as Array<{ isDefault?: boolean; trackIds: string[] }>
  assert.deepEqual(playlists.find((p) => p.isDefault)!.trackIds, ['song'])
  await f.service.shutdown()
})

test('music-only export uses its explicit remaining 180 MiB budget and never reads an unselected library or playback file', async (t) => {
  const f = musicProfile(t)
  writeFileSync(join(f.root, 'playback-session.json'), '{unrelated malformed playback')
  f.database.exportDocument = async () => { throw new Error('unselected library must not be exported') }
  const produce = f.database.musicBackupExport!
  let capacity = 0
  f.database.musicBackupExport = async (maxBytes) => { capacity = maxBytes; return produce(maxBytes) }
  assert.equal(await f.service.export({ domains: ['music'] }), true)
  assert.ok(capacity > 16 * 1024 * 1024 && capacity < PERSONAL_BACKUP_LIMIT)
  const saved = f.repository.readBackupFile(f.output)
  assert.deepEqual(Object.keys(saved.data), ['music'])
  const previous = readFileSync(f.output, 'utf8')
  f.database.musicBackupExport = async () => { throw new Error('music 数据超过备份容量，未截断导出') }
  await assert.rejects(f.service.export({ domains: ['music'] }), /超过备份容量.*未截断/)
  assert.equal(readFileSync(f.output, 'utf8'), previous)
  f.repository.writePersonalBackupFile(f.input, saved)
  const preview = (await f.service.preview())!
  assert.deepEqual(preview.roots, ['c:/old'])
  await f.service.stage({ id: preview.id, options: { domains: ['music'], mappings: [], conflict: 'keep-local' } })
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  assert.equal(readFileSync(join(f.root, 'playback-session.json'), 'utf8'), '{unrelated malformed playback')
  await f.service.shutdown()
})

test('v2 preview rejects mixed revision reads instead of approving an older row summary with a newer fence', async (t) => {
  const f = musicProfile(t)
  await f.service.export({ domains: ['music'] })
  f.repository.writePersonalBackupFile(f.input, f.repository.readBackupFile(f.output))
  const preview = f.database.musicBackupPreview!
  f.database.musicBackupPreview = async (data, conflict) => {
    const result = await preview(data, conflict)
    f.rate(9)
    return result
  }
  await assert.rejects(f.service.preview(), { code: 'STALE_REVISION' })
  assert.equal(existsSync(join(f.root, 'personal-restore-pending.json')), false)
  await f.service.shutdown()
})

test('Core refuses an ambiguous inspected music mapping before staging, but can restore a different selected domain', async (t) => {
  const f = musicProfile(t)
  await f.service.export()
  f.repository.writePersonalBackupFile(f.input, f.repository.readBackupFile(f.output))
  const preview = f.database.musicBackupPreview!
  f.database.musicBackupPreview = async (data, conflict) => {
    const result = await preview(data, conflict)
    return data ? { ...result, dependencies: [...result.dependencies, 'music:identity-reference-conflict'],
      referenceConflicts: [{ incomingId: f.recording, kind: 'recording', title: 'Ambiguous', targetIds: ['one', 'two'] }] } : result
  }
  const selected = (await f.service.preview())!
  const options: PersonalRestoreOptions = { domains: selected.rows.map((row) => row.domain), mappings: [], conflict: 'keep-local' }
  await assert.rejects(f.service.stage({ id: selected.id, options }), { code: 'IDENTITY_CONFLICT' })
  assert.equal(existsSync(join(f.root, 'personal-restore-pending.json')), false)
  const playlistsOnly: PersonalRestoreOptions = { ...options, domains: ['playlists'] }
  await f.service.repreview({ id: selected.id, options: playlistsOnly })
  await f.service.stage({ id: selected.id, options: playlistsOnly })
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  await f.service.shutdown()
})

test('a valid music domain above the old 16 MiB fallback is accepted without clipping records', (t) => {
  const f = profile(t), records = emptyMusicBackupRecords()
  for (let n = 0; n < 3; n++) {
    records.entities.push({ id: `artist-${n}`, kind: 'artist', title: `Artist ${n}`, artist: '', identity: 'manual' })
    records.overrides.push({ entity_id: `artist-${n}`, payload: JSON.stringify({ mode: 'value', value: 'x'.repeat(6 * 1024 * 1024), language: 'en' }) })
  }
  const saved = f.repository.parsePersonalBackup(JSON.stringify({ format: 'twilight-personal-data', version: 2,
    createdAt: '2026-10-24T00:00:00.000Z', data: { music: { version: 1, origin: 'large-music', dictionaryVersion: 1, records } } }))
  assert.equal((saved.data.music as MusicPersonalBackupDocument).records.overrides.length, 3)
})

test('v2 binds the inspected options and revisions; restart conflicts become a directly recoverable review instead of a startup loop', async (t) => {
  const f = musicProfile(t)
  await f.service.export()
  f.repository.writePersonalBackupFile(f.input, f.repository.readBackupFile(f.output))
  const first = (await f.service.preview())!
  const options: PersonalRestoreOptions = { domains: ['music'], conflict: 'use-backup', mappings: [{ from: 'C:/Old', to: 'D:/Music' }] }
  await assert.rejects(f.service.stage({ id: first.id, options }), { code: 'STALE_REVISION' })
  const inspect = f.database.musicBackupPreview!
  const inspected: { data?: MusicPersonalBackupDocument; conflict?: string } = {}
  f.database.musicBackupPreview = async (data, conflict) => { inspected.data = data; inspected.conflict = conflict; return inspect(data, conflict) }
  const next = await f.service.repreview({ id: first.id, options })
  assert.equal(next.id, first.id)
  assert.ok(next.music)
  assert.deepEqual(next.roots, ['C:/Old'])
  assert.ok(inspected.data?.records.sources.every((row) => String(row.source_key).includes('d:/music/')))
  assert.equal(inspected.conflict, 'use-backup')
  assert.equal(next.dependencies?.find((edge) => edge.domain === 'music' && edge.requires === 'library')?.selected, false)
  f.rate(9)
  await assert.rejects(f.service.stage({ id: first.id, options }), { code: 'STALE_REVISION' })
  assert.equal(existsSync(join(f.root, 'personal-restore-pending.json')), false)
  await f.service.repreview({ id: first.id, options })
  await f.service.stage({ id: first.id, options })
  const pending = JSON.parse(readFileSync(join(f.root, 'personal-restore-pending.json'), 'utf8'))
  assert.equal(typeof pending.restoreId, 'string')
  assert.deepEqual(pending.musicExpectedRevision, f.library.musicBackupRevision())
  f.rate(10)
  await assert.rejects(f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database), { code: 'STALE_REVISION' })
  assert.equal(JSON.parse(readFileSync(join(f.root, 'personal-restore-journal.json'), 'utf8')).id, pending.restoreId)
  const path = f.repository.deferStalePersonalRestore(f.root)!
  assert.equal(f.repository.readBackupFile(path).version, 2)
  assert.equal(existsSync(join(f.root, 'personal-restore-pending.json')), false)
  assert.equal(existsSync(join(f.root, 'personal-restore-journal.json')), false)
  await f.service.initialize()
  assert.equal(f.service.recoveryAvailable(), true)
  const reviewed = (await f.service.recoverPreview())!
  const restore = { ...options, mappings: [] }
  await f.service.repreview({ id: reviewed.id, options: restore })
  await f.service.stage({ id: reviewed.id, options: restore })
  assert.equal(f.service.recoveryAvailable(), false)
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  assert.equal(f.library.ratingsDetail(f.recording).value!.steps, 7)
  await f.service.shutdown()
})

test('restoring only v2 playlists never changes favorite, ban or rating authority', async (t) => {
  const f = musicProfile(t)
  await f.service.export({ domains: ['playlists'] })
  const saved = f.repository.readBackupFile(f.output)
  assert.equal(saved.data.music, undefined)
  f.repository.writePersonalBackupFile(f.input, saved)
  f.library.preferencesSet({ entityId: f.recording, token: f.library.preferencesDetail(f.recording).token, state: 'ban' }, 200)
  f.rate(10)
  const before = f.library.musicBackupExport(PERSONAL_BACKUP_LIMIT).records
  const selected = (await f.service.preview())!
  const options: PersonalRestoreOptions = { domains: ['playlists'], mappings: [], conflict: 'use-backup' }
  await f.service.repreview({ id: selected.id, options })
  await f.service.stage({ id: selected.id, options })
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  const after = f.library.musicBackupExport(PERSONAL_BACKUP_LIMIT).records
  assert.deepEqual(after.preferences, before.preferences)
  assert.deepEqual(after.ratings, before.ratings)
  assert.deepEqual(after.preferenceHistory, before.preferenceHistory)
  assert.equal(f.library.preferencesDetail(f.recording).value!.state, 'ban')
  assert.deepEqual(f.library.preferencesPlaylistsLoad()!.data.find((p) => p.isDefault)!.trackIds, [])
  assert.equal(existsSync(join(f.root, 'playlists.json')), false)
  await f.service.shutdown()
})

test('v2 SQLite bundle precedes every file, and a lost ACK plus interrupted file redo cannot reapply personal values', async (t) => {
  const f = musicProfile(t)
  await f.service.export()
  const saved = f.repository.readBackupFile(f.output)
  saved.data.lyrics = backup().data.lyrics
  ;(saved.data.library as { tracks: Array<{ title: string }> }).tracks[0].title = 'Restored by one bundle'
  f.repository.writePersonalBackupFile(f.input, saved)
  f.rate(10)
  const selected = (await f.service.preview())!
  const options: PersonalRestoreOptions = { domains: ['library', 'playlists', 'music', 'lyrics'], mappings: [], conflict: 'use-backup' }
  // This fixture has no new folder permission: the existing root is already authorized.
  options.mappings = [{ from: 'C:/Old', to: 'D:/Music' }]
  await f.service.repreview({ id: selected.id, options })
  await f.service.stage({ id: selected.id, options })
  const restore = f.database.musicBackupRestore!
  let attempts = 0
  f.database.musicBackupRestore = async (bundle) => {
    const result = await restore(bundle)
    if (++attempts === 1) throw new Error('lost worker ACK')
    return result
  }
  await assert.rejects(f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database), /lost worker ACK/)
  assert.equal(existsSync(join(f.root, 'lyrics-management.json')), false)
  assert.equal(existsSync(join(f.root, 'settings.json')), false)
  assert.equal(f.library.queryTracks().tracks[0].title, 'Restored by one bundle')
  f.library.ratingsSet({ entityId: f.recording, token: f.library.ratingsDetail(f.recording).token, steps: 8 }, 300)
  const afterCommit = f.library.musicBackupExport(PERSONAL_BACKUP_LIMIT).records.ratingHistory
  await assert.rejects(f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database, (name) => {
    if (name === 'lyrics-management.json') throw new Error('file write interrupted')
  }), /file write interrupted/)
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  assert.equal(f.library.ratingsDetail(f.recording).value!.steps, 8)
  assert.deepEqual(f.library.musicBackupExport(PERSONAL_BACKUP_LIMIT).records.ratingHistory, afterCommit)
  assert.equal(existsSync(join(f.root, 'lyrics-management.json')), true)
  assert.equal(existsSync(join(f.root, 'playlists.json')), false)
  const previous = JSON.parse(readFileSync(join(f.root, 'personal-restore-previous.json'), 'utf8'))
  assert.equal(existsSync(previous.data['music-library.sqlite'].databaseSnapshot), true)
  assert.equal(existsSync(join(f.root, 'personal-restore-journal.json')), false)
  await f.service.shutdown()
})
