import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { createSourceResolver } from '../../core/playback/sourceResolver.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { MUSIC_BACKUP_MAX_BYTES, validateMusicPersonalBackup, remapMusicPersonalBackupPaths, type MusicPersonalBackupDocument } from '../../shared/musicPersonalBackup.ts'

function fixture(t: test.TestContext, tracks = true) {
  const dir = mkdtempSync(join(tmpdir(), 'music-backup-')), db = new LibraryDatabase(join(dir, 'music-library.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { force: true, recursive: true }) })
  if (tracks) {
    db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [1, 2].map(n => ({
      id: `track-${n}`, filePath: `D:/Music/${n}/song.flac`, source: 'local', title: 'Same name', artist: 'Same artist', album: `Album ${n}`
    })) })
    while (db.catalogStatus().localPending) db.catalogAdvance()
  }
  const recordings = db.sql.prepare("SELECT id FROM catalog_entities WHERE kind='recording' ORDER BY id").all().map(r => String(r.id))
  return { db, recordings }
}
function personal(db: LibraryDatabase, recording: string) {
  db.ratingsSet({ entityId: recording, token: db.ratingsDetail(recording).token, steps: 8 }, 10)
  db.ratingsSet({ entityId: recording, token: db.ratingsDetail(recording).token, steps: null }, 11)
  db.preferencesSet({ entityId: recording, token: db.preferencesDetail(recording).token, state: 'ban' }, 12)
  db.preferencesSet({ entityId: recording, token: db.preferencesDetail(recording).token, state: 'none' }, 13)
  db.sql.prepare("INSERT INTO metadata_subjects(id) VALUES(?)").run(recording)
  db.sql.prepare('INSERT INTO metadata_overrides VALUES(?,?)').run(recording, JSON.stringify({ mode: 'clear', value: '', language: 'zh-Hans' }))
  db.sql.prepare("INSERT INTO personal_tags VALUES('default','tag-one','Evening','evening',1,1,10)").run()
  db.sql.prepare("INSERT INTO personal_tag_members VALUES('default','tag-one',?)").run(recording)
  db.sql.prepare("INSERT INTO personal_focus_queries VALUES('default','focus-one','Quiet','quiet',?,1,1,10)").run(JSON.stringify({ version: 1, entity: 'recording', where: { tag: { id: 'tag-one' } } }))
  db.sql.prepare("INSERT INTO metadata_entities VALUES('identity-one','musicbrainz','recording','11111111-1111-4111-8111-111111111111','Identity')").run()
  db.sql.prepare("INSERT INTO metadata_identity_refs VALUES('musicbrainz','recording','mbid','11111111-1111-4111-8111-111111111111','identity-one')").run()
  db.sql.prepare("INSERT INTO metadata_identity_links VALUES('link-one',?,'recording',2,NULL,'detached')").run(recording)
  db.sql.prepare("INSERT INTO metadata_identity_suppressions VALUES(?,'recording','musicbrainz','mbid','11111111-1111-4111-8111-111111111111','rejected',15)").run(recording)
  db.sql.prepare("INSERT INTO metadata_identity_history(link_id,candidate_id,state,target_id,evidence,changed_at) VALUES('link-one','candidate-old','rejected','identity-one',?,15)").run(JSON.stringify({ name: 'Identity', references: [], evidence: {}, inputVersion: 'old' }))
  db.sql.prepare("INSERT INTO catalog_entities VALUES('work-one','work','Suite','','source')").run()
  db.sql.prepare("INSERT INTO music_exploration_refs VALUES('musicbrainz','work','mbid','work-id','work-one')").run()
  const performance = db.explorationPerformanceSave({ title: 'My performance', workId: 'work-one', recordingIds: [recording, recording], revision: db.explorationState().revision })
  db.sql.prepare("INSERT INTO music_genres VALUES('user-genre','My genre','My genre','genre:jazz',1,1)").run()
  db.sql.prepare("INSERT INTO music_genre_aliases VALUES('*','my jazz','My jazz','user-genre',0,1,1)").run()
  const source = db.sql.prepare('SELECT id FROM catalog_sources WHERE recording_id=?').get(recording)!
  db.sql.prepare("INSERT INTO music_genre_overrides VALUES('source',?,?)").run(String(source.id), '["user-genre"]')
  db.sql.prepare("INSERT OR REPLACE INTO catalog_state VALUES(?,'123456')").run('membership_added:' + source.id)
  return performance.entity!.id
}
function restore(db: LibraryDatabase, music: MusicPersonalBackupDocument, restoreId = 'restore-one', conflict: 'keep-local' | 'use-backup' = 'use-backup') {
  return db.musicBackupRestore({ restoreId, conflict, music, expectedRevision: db.musicBackupRevision(), now: 100 })
}

test('music exports only static personal records, clear receipts, ordered manual performances, and excludes automatic caches', t => {
  const { db, recordings } = fixture(t), performance = personal(db, recordings[0])
  db.sql.prepare("INSERT INTO metadata_facts VALUES('identity-one','wikipedia','introduction','en',?)").run(JSON.stringify({ value: 'restricted full text', streamUrl: 'https://session.invalid/secret' }))
  db.sql.exec("INSERT INTO music_exploration_sets VALUES('automatic-set','work-one','musicbrainz','related',1,0,'provider'); INSERT INTO catalog_aliases VALUES('provider-cache','cache','work-one')")
  const data = db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  const preview = db.musicBackupPreview(data), total = Object.values(data.records).reduce((n, rows) => n + rows.length, 0)
  assert.equal(preview.incoming, total)
  assert.equal(preview.current, total, 'both sides count the same portable records, not provider sets or only six personal tables')
  assert.equal(validateMusicPersonalBackup(data), true)
  assert.equal(data.records.ratings[0].steps, null)
  assert.equal(data.records.preferences[0].state, 'none')
  assert.equal(data.records.ratingHistory.length, 2)
  assert.equal(data.records.identityHistory[0].state, 'rejected')
  assert.equal(data.records.performances[0].owner_id, performance)
  assert.deepEqual(data.records.performanceRelations.filter(r => r.kind === 'performance_recording').map(r => r.position), [0, 1])
  assert.equal(JSON.stringify(data).includes('restricted full text'), false)
  assert.equal(JSON.stringify(data).includes('https://session.invalid'), false)
})

test('music-only restore keeps missing sources offline, retains references and histories, and re-exports the complete personal graph', async t => {
  const a = fixture(t), b = fixture(t, false); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), preview = b.db.musicBackupPreview(data)
  assert.equal(preview.missingSources, 2)
  assert.equal(preview.dependencies.includes('library:missing-sources'), true)
  await restore(b.db, data)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM tracks').get()!.n, 0)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM catalog_sources').get()!.n, 0)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM catalog_memberships').get()!.n, 0)
  assert.equal(b.db.sql.prepare('SELECT state FROM personal_preference_values').get()!.state, 'none')
  const exported = b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(validateMusicPersonalBackup(exported), true)
  assert.equal(b.db.musicBackupPreview(exported).current, Object.values(exported.records).reduce((n, rows) => n + rows.length, 0), 'offline source and membership records use the same deduplicated inventory')
  for (const name of ['sources', 'ratings', 'preferences', 'ratingHistory', 'preferenceHistory', 'identityHistory', 'suppressions', 'overrides', 'tags', 'tagMembers', 'focus', 'performances', 'performanceRelations', 'membershipAdded'] as const) {
    assert.equal(exported.records[name].length, data.records[name].length, name)
  }
  assert.ok(existsSync(`${b.db.filePath}.pre-restore-restore-one.sqlite`))
})

test('same exact sources map across different database IDs while same names never merge', async t => {
  const a = fixture(t), b = fixture(t); personal(a.db, a.recordings[0])
  assert.notEqual(a.recordings[0], b.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), preview = b.db.musicBackupPreview(data)
  assert.equal(preview.missingSources, 0)
  const map = preview.mappings.find(m => m.incomingId === a.recordings[0])!
  assert.equal(map.method, 'source')
  assert.notEqual(map.targetId, a.recordings[0])
  await restore(b.db, data)
  assert.equal(b.db.ratingsDetail(map.targetId).value?.steps, null)
  assert.equal(b.db.sql.prepare("SELECT count(*) n FROM catalog_entities WHERE kind='recording'").get()!.n, 2)
  assert.equal(b.db.sql.prepare("SELECT count(*) n FROM catalog_entities WHERE kind='artist'").get()!.n, 2, 'name-only artist anchors remain separate')
  const source = b.db.sql.prepare('SELECT id FROM catalog_sources WHERE recording_id=?').get(map.targetId)!
  assert.equal(b.db.sql.prepare('SELECT value FROM catalog_state WHERE key=?').get('membership_added:' + source.id)!.value, '123456')
  assert.equal(b.db.sql.prepare("SELECT target_id FROM music_genre_overrides WHERE target_kind='source'").get()!.target_id, source.id)
})

test('keep-local and use-backup choose explicit cleared fields without deleting independent values', async t => {
  const a = fixture(t), b = fixture(t); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), map = b.db.musicBackupPreview(data).mappings.find(m => m.incomingId === a.recordings[0])!
  b.db.ratingsSet({ entityId: map.targetId, token: b.db.ratingsDetail(map.targetId).token, steps: 10 }, 50)
  b.db.preferencesSet({ entityId: map.targetId, token: b.db.preferencesDetail(map.targetId).token, state: 'favorite' }, 50)
  assert.ok(b.db.musicBackupPreview(data).conflicts >= 2)
  await restore(b.db, data, 'keep', 'keep-local')
  assert.equal(b.db.ratingsDetail(map.targetId).value?.steps, 10)
  assert.equal(b.db.preferencesDetail(map.targetId).value?.state, 'favorite')
  await restore(b.db, data, 'replace', 'use-backup')
  assert.equal(b.db.ratingsDetail(map.targetId).value?.steps, null)
  assert.equal(b.db.preferencesDetail(map.targetId).value?.state, 'none')
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM personal_rating_history').get()!.n, 3, 'same portable audit rows are not duplicated by a second restore')
})

test('lost ACK restoreId retries do not overwrite newer edits and stale previews cannot publish', async t => {
  const a = fixture(t), b = fixture(t); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), expectedRevision = b.db.musicBackupRevision()
  const bundle = { restoreId: 'lost-ack', conflict: 'use-backup' as const, music: data, expectedRevision, now: 100 }
  await b.db.musicBackupRestore(bundle)
  const row = b.db.sql.prepare('SELECT target_key FROM personal_rating_values').get()!, id = JSON.parse(String(row.target_key))[2]
  b.db.ratingsSet({ entityId: id, token: b.db.ratingsDetail(id).token, steps: 9 }, 110)
  const revision = b.db.musicBackupRevision(), count = b.db.sql.prepare('SELECT count(*) n FROM personal_rating_history').get()!.n
  await b.db.musicBackupRestore(bundle)
  assert.equal(b.db.ratingsDetail(id).value?.steps, 9)
  assert.deepEqual(b.db.musicBackupRevision(), revision)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM personal_rating_history').get()!.n, count)
  await assert.rejects(b.db.musicBackupRestore({ ...bundle, restoreId: 'stale' }), { code: 'STALE_REVISION' })
  assert.equal(existsSync(`${b.db.filePath}.pre-restore-stale.sqlite`), false)
})

test('a late SQLite error rolls back library, music, playlists, and restore receipt together', async t => {
  const a = fixture(t), b = fixture(t, false); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), revision = b.db.musicBackupRevision()
  b.db.sql.exec("CREATE TRIGGER fail_music_restore BEFORE INSERT ON personal_preference_values BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  await assert.rejects(b.db.musicBackupRestore({ restoreId: 'rollback', conflict: 'use-backup', expectedRevision: revision,
    library: a.db.exportDocument(), music: data, playlists: [{ id: 'p', name: 'Ordinary', trackIds: ['one'], createdAt: '2026-01-01' }] }), /fixture failure/)
  assert.deepEqual(b.db.musicBackupRevision(), revision)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM tracks').get()!.n, 0)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM catalog_entities').get()!.n, 0)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM personal_preference_playlists').get()!.n, 0)
  assert.equal(b.db.sql.prepare("SELECT count(*) n FROM meta WHERE key='music_backup_restore:rollback'").get()!.n, 0)
  assert.ok(existsSync(`${b.db.filePath}.pre-restore-rollback.sqlite`))
})

test('v2 playlists-only restore preserves favorite state and members; music restores the one favorite ordering authority', async t => {
  const a = fixture(t), b = fixture(t)
  const initial = [{ id: 'favorites', name: 'Favorites', isDefault: true, trackIds: ['track-2', 'track-1'], createdAt: '2026-01-01' }, { id: 'normal', name: 'Normal', trackIds: ['track-1'], createdAt: '2026-01-01' }]
  a.db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: initial }, 100)
  b.db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: initial }, 100)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal((JSON.parse(String(data.records.favorites[0].payload)) as unknown[]).length, 1, 'ordinary playlists have only the playlists domain authority')
  await b.db.musicBackupRestore({ restoreId: 'playlists-only', conflict: 'use-backup', expectedRevision: b.db.musicBackupRevision(),
    playlists: [{ ...initial[0], trackIds: [] }, { ...initial[1], name: 'Changed' }] })
  assert.deepEqual(b.db.preferencesPlaylistsLoad()!.data[0].trackIds, ['track-2', 'track-1'])
  assert.equal(b.db.preferencesPlaylistsLoad()!.data[1].name, 'Changed')
  const changed = b.db.preferencesPlaylistsLoad()!
  changed.data[0].trackIds.reverse()
  b.db.preferencesPlaylistsSave(changed.data, changed.revision, 101)
  await restore(b.db, data, 'music-order')
  assert.deepEqual(b.db.preferencesPlaylistsLoad()!.data[0].trackIds, ['track-2', 'track-1'])
  assert.equal(b.db.preferencesPlaylistsLoad()!.data[1].name, 'Changed')
})

test('same-origin history does not duplicate and path remapping binds only exact remapped sources', async t => {
  const a = fixture(t); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), count = a.db.sql.prepare('SELECT count(*) n FROM personal_rating_history').get()!.n
  await restore(a.db, data)
  assert.equal(a.db.sql.prepare('SELECT count(*) n FROM personal_rating_history').get()!.n, count)
  const mapped = remapMusicPersonalBackupPaths(data, [{ from: 'D:/Music', to: 'E:/Audio' }])
  assert.ok(String(mapped.records.sources[0].source_key).includes('e:/audio'))
  assert.equal(mapped.records.entities[0].title, data.records.entities[0].title)
  assert.equal(validateMusicPersonalBackup(mapped), true)
})

test('validation rejects arbitrary tables/columns, dangling refs, cycles, unsupported states, and explicit export budgets never truncate', t => {
  const a = fixture(t); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  const invalid: Array<(d: MusicPersonalBackupDocument) => void> = [
    d => { (d.records as unknown as Record<string, unknown>).arbitrary_table = [] },
    d => { d.records.entities[0].sql = 'DROP TABLE tracks' },
    d => { d.records.ratings[0].target_key = JSON.stringify(['entity', 'recording', 'missing']) },
    d => { d.records.preferences[0].state = 'deleted' },
    d => { d.records.genres[0].parent_id = d.records.genres[0].id },
    d => { d.records.overrides[0].payload = JSON.stringify({ mode: 'value', value: 'x', language: 'en', accessToken: 'secret' }) }
  ]
  for (const mutate of invalid) { const copy = structuredClone(data); mutate(copy); assert.equal(validateMusicPersonalBackup(copy), false) }
  assert.throws(() => a.db.musicBackupExport(100), /超过备份容量/)
  assert.equal(a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES).records.ratingHistory.length, 2)
})

test('POSIX path mappings are case-sensitive and Windows mappings preserve canonical exact source identities', t => {
  const { db } = fixture(t), data = db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  data.records.sources[0].source_key = '["local","/music/One.flac",null,null]'
  const untouched = remapMusicPersonalBackupPaths(data, [{ from: '/Music', to: '/Audio' }])
  assert.equal(untouched.records.sources[0].source_key, data.records.sources[0].source_key)
  const changed = remapMusicPersonalBackupPaths(data, [{ from: '/music', to: '/Audio' }])
  assert.equal(changed.records.sources[0].source_key, '["local","/Audio/One.flac",null,null]')
  const windows = remapMusicPersonalBackupPaths(db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), [{ from: 'd:/MUSIC', to: 'E:/Audio' }])
  assert.ok(windows.records.sourceAliases.some(row => row.namespace === 'source.recording' && String(row.key).includes('e:/audio')))
  assert.ok(windows.records.sourceAliases.some(row => row.namespace === 'source.release' && String(row.key).includes('e:')))
})

test('music-only favorites cannot play an imported path or collide with an unrelated same Track ID; real source import reattaches order and genre history', async t => {
  const a = fixture(t), b = fixture(t, false), snapshots = Object.fromEntries((a.db.exportDocument().tracks as import('../../shared/libraryDatabase.ts').LibraryTrackRecord[]).map(track => [track.id, track as unknown as import('../../shared/track.ts').TrackData]))
  a.db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: [{ id: 'favorites', name: 'Favorites', isDefault: true, trackIds: ['track-2', 'track-1'], trackSnapshots: snapshots, createdAt: '2026-01-01' }] }, 100)
  const source = a.db.sql.prepare("SELECT id FROM catalog_sources WHERE track_id='track-1'").get()!
  a.db.sql.prepare("INSERT INTO music_genre_overrides VALUES('source',?,'[\"genre:jazz\"]')").run(String(source.id))
  a.db.sql.prepare("INSERT OR REPLACE INTO catalog_state VALUES(?,'7654321')").run('membership_added:' + source.id)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, data)
  const view = b.db.preferencesPlaylistsLoad()!.data[0]
  assert.equal(view.trackIds.length, 2)
  assert.equal(view.trackIds.every(id => id.startsWith('offline_favorite_')), true)
  assert.equal(Object.values(view.trackSnapshots!).every(snapshot => snapshot.filePath === '' && snapshot.source === 'local'), true)
  for (const snapshot of Object.values(view.trackSnapshots!)) assert.equal(await createSourceResolver().resolve(snapshot), null)
  const portable = b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.deepEqual((JSON.parse(String(portable.records.favorites[0].payload)) as Array<{ trackIds: string[] }>)[0].trackIds, ['track-2', 'track-1'])
  b.db.replaceDocument(a.db.exportDocument())
  while (b.db.catalogStatus().localPending) b.db.catalogAdvance()
  const rebound = b.db.preferencesPlaylistsLoad()!.data[0]
  assert.deepEqual(rebound.trackIds, ['track-2', 'track-1'])
  const actualSource = b.db.sql.prepare("SELECT id FROM catalog_sources WHERE track_id='track-1'").get()!
  assert.equal(b.db.catalogResolve(String(actualSource.id), b.db.catalogStatus().revision)!.filePath, 'D:/Music/1/song.flac')
  assert.equal(b.db.sql.prepare("SELECT target_id FROM music_genre_overrides WHERE target_kind='source'").get()!.target_id, actualSource.id)
  assert.equal(b.db.sql.prepare('SELECT value FROM catalog_state WHERE key=?').get('membership_added:' + actualSource.id)!.value, '7654321')
  const reboundData = b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(b.db.musicBackupPreview().current, Object.values(reboundData.records).reduce((n, rows) => n + rows.length, 0), 'reattached portable references are counted once')
})

test('tag members and manual movement lists are selected whole fields, not unions, and name conflicts are visible before staging', async t => {
  const a = fixture(t); personal(a.db, a.recordings[0])
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), performance = data.records.performances[0], set = String(performance.id)
  a.db.sql.prepare("INSERT INTO personal_tag_members VALUES('default','tag-one',?)").run(a.recordings[1])
  a.db.sql.prepare("INSERT INTO music_exploration_relations VALUES('later',?, ?,?,'performance_recording',2,'{\"attribution\":null}')").run(set, String(performance.owner_id), a.recordings[1])
  await restore(a.db, data, 'tag-keep', 'keep-local')
  assert.equal(a.db.sql.prepare('SELECT count(*) n FROM personal_tag_members').get()!.n, 2)
  assert.equal(a.db.sql.prepare("SELECT count(*) n FROM music_exploration_relations WHERE kind='performance_recording'").get()!.n, 3)
  await restore(a.db, data, 'tag-backup')
  assert.equal(a.db.sql.prepare('SELECT count(*) n FROM personal_tag_members').get()!.n, 1)
  assert.equal(a.db.sql.prepare("SELECT count(*) n FROM music_exploration_relations WHERE kind='performance_recording'").get()!.n, 2)
  const b = fixture(t, false)
  b.db.sql.prepare("INSERT INTO personal_tags VALUES('default','another-tag','Evening','evening',1,0,0)").run()
  const preview = b.db.musicBackupPreview(data)
  assert.equal(preview.referenceConflicts.some(c => c.kind === 'tag' && c.title === 'Evening'), true)
  assert.ok(preview.dependencies.includes('music:identity-reference-conflict'))
  await assert.rejects(restore(b.db, data), { code: 'IDENTITY_CONFLICT' })
})

test('Rhine user imports, manual clears, notes, bindings and restorable history survive without provider prose or tasks', async t => {
  const a = fixture(t), b = fixture(t, false), plugin = 'com.twilightecho.experience.rhine-lab', entity = a.db.sql.prepare("SELECT id FROM catalog_entities WHERE kind='release' LIMIT 1").get()!.id
  const imported = { description: 'User imported', descriptionSource: { method: 'external-ai', name: 'User', url: '' }, localNote: 'My note', producers: [{ name: 'Manual person', role: 'mix', source: 'manual' }, { name: 'Provider person', role: 'mix', source: 'QQ Music' }] }
  a.db.sql.prepare("INSERT INTO metadata_legacy_documents VALUES(?,'published',1,2,2,0,'{\"albums\":{}}',2)").run(plugin)
  a.db.sql.prepare("INSERT INTO metadata_legacy_albums VALUES(?,'one',?,'bound')").run(plugin, JSON.stringify(imported))
  a.db.sql.prepare("INSERT INTO metadata_legacy_albums VALUES(?,'restricted',?,'unassigned')").run(plugin, JSON.stringify({ description: 'Restricted provider text', descriptionSource: { name: 'Platform', url: 'https://provider.invalid' }, localNote: '' }))
  a.db.sql.prepare("INSERT INTO metadata_legacy_inputs VALUES(?,'one',2)").run(plugin)
  a.db.sql.prepare("INSERT INTO metadata_legacy_bindings VALUES(?,'one',?,'{\"collectionId\":\"dir:d:/music\",\"trackIds\":[\"track-1\"]}')").run(plugin, String(entity))
  a.db.sql.prepare('INSERT INTO metadata_legacy_history VALUES(?,1,?,?)').run(plugin, JSON.stringify({ albums: { one: imported } }), JSON.stringify([{ legacy_id: 'one', entity_id: entity, evidence: '{}' }]))
  a.db.legacyMusicEdit(plugin, { revision: 2, value: { albums: { one: { ...imported, description: '', localNote: 'New note' }, restricted: { description: 'Restricted provider text', descriptionSource: { name: 'Platform', url: 'https://provider.invalid' }, localNote: '' } } } })
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(a.db.musicBackupPreview(data).current, Object.values(data.records).reduce((n, rows) => n + rows.length, 0))
  assert.equal(JSON.stringify(data).includes('Restricted provider text'), false)
  assert.equal(JSON.stringify(data).includes('Provider person'), false)
  await restore(b.db, data)
  const document = b.db.legacyMusicRead(plugin)!
  const values = document.value.albums as Record<string, { description?: string; localNote?: string }>
  assert.equal(values.one.description, '')
  assert.equal(values.one.localNote, 'New note')
  assert.equal(values.restricted.description, undefined)
  assert.equal(b.db.legacyMusicHistory(plugin).total, 2)
  assert.equal(b.db.legacyMusicInventory(plugin).items.find(i => i.id === 'one')!.bindings.length, 1)
  b.db.legacyMusicRestore(plugin, 1, document.revision)
  assert.equal((b.db.legacyMusicRead(plugin)!.value.albums as Record<string, { description: string }>).one.description, 'User imported')
})

test('mixed local and backup genre parents cannot commit a cycle', async t => {
  const a = fixture(t), b = fixture(t, false)
  a.db.sql.exec("INSERT INTO music_genres VALUES('node-a','A','A',NULL,1,1); INSERT INTO music_genres VALUES('node-b','B','B','node-a',1,0)")
  b.db.sql.exec("INSERT INTO music_genres VALUES('node-b','B','B',NULL,1,0); INSERT INTO music_genres VALUES('node-a','A','A','node-b',1,1)")
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  data.records.genres.find(g => g.id === 'node-a')!.parent_id = 'node-b'
  data.records.genres.find(g => g.id === 'node-b')!.parent_id = null
  // Backup itself is acyclic; untouched built-in node-b's local edge closes the merged cycle.
  b.db.sql.prepare("UPDATE music_genres SET parent_id='node-a' WHERE id='node-b'").run()
  b.db.sql.prepare("UPDATE music_genres SET parent_id=NULL WHERE id='node-a'").run()
  assert.equal(validateMusicPersonalBackup(data), true)
  assert.equal(b.db.musicBackupPreview(data, 'use-backup').referenceConflicts.some(c => c.kind === 'genre'), true)
  assert.equal(b.db.musicBackupPreview(data, 'keep-local').referenceConflicts.some(c => c.kind === 'genre'), false)
  const revision = b.db.musicBackupRevision()
  await assert.rejects(restore(b.db, data), /流派层级形成循环/)
  assert.deepEqual(b.db.musicBackupRevision(), revision)
})

test('confirmed and detached identity history keeps usable snapshots and exact refs across different local IDs, with durable audit high-water marks', async t => {
  const a = fixture(t), b = fixture(t), entityId = a.recordings[0], input = a.db.identificationInput(entityId)
  const [candidate] = a.db.identificationPublish(input, [{ provider: 'ncm', name: 'Confirmed title', summary: '', references: [{ provider: 'ncm', kind: 'recording', idType: 'native', value: '123' }],
    evidence: { origin: 'search', matches: ['id'], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }, matcherVersion: 'fixture-v1' }], 10)
  const detail = a.db.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision, decision: 'confirm' }, 11)
  a.db.identificationDetach(detail.link!.id, detail.link!.revision, 12)
  a.db.sql.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='metadata_identity_history'").run()
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), map = b.db.musicBackupPreview(data).mappings.find(row => row.incomingId === entityId)!
  await restore(b.db, data)
  const history = b.db.identificationHistory({ entityId: map.targetId }), confirmed = history.items.find(row => row.state === 'confirmed')!
  assert.equal(confirmed.hasSnapshot, true)
  assert.deepEqual(confirmed.references, [{ provider: 'ncm', kind: 'recording', idType: 'native', value: '123' }])
  const current = b.db.identificationInput(map.targetId), request = { entityId: map.targetId, historySeq: confirmed.seq, linkRevision: current.linkRevision, inputVersion: current.version }
  assert.equal(b.db.identificationRestorePreview(request).canRestore, true)
  b.db.identificationRestore(request, 20)
  assert.equal(b.db.identificationDetail(map.targetId).link!.state, 'confirmed')
  assert.ok(b.db.identificationHistory({ entityId: map.targetId }).items[0].seq > 100)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM metadata_jobs').get()!.n, 0)
})

test('exact aliases to different local identities block preview and restore, and mapping output is bounded', async t => {
  const a = fixture(t), b = fixture(t, false)
  a.db.sql.exec("INSERT INTO metadata_entities VALUES('one','internal','artist','one','Same'); INSERT INTO metadata_identity_refs VALUES('ncm','artist','native','1','one'); INSERT INTO metadata_identity_refs VALUES('qq','artist','native','2','one')")
  b.db.sql.exec("INSERT INTO metadata_entities VALUES('one-local','internal','artist','one-local','Same'); INSERT INTO metadata_entities VALUES('two-local','internal','artist','two-local','Same'); INSERT INTO metadata_identity_refs VALUES('ncm','artist','native','1','one-local'); INSERT INTO metadata_identity_refs VALUES('qq','artist','native','2','two-local')")
  for (let n = 0; n < 110; n++) a.db.sql.prepare("INSERT INTO catalog_entities VALUES(?,'work',?,'','source')").run(`work-${n}`, `Title ${n}`)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), preview = b.db.musicBackupPreview(data)
  assert.equal(preview.mappings.length, 100)
  assert.equal(preview.mappingsTruncated, true)
  assert.ok(preview.mappingCount > 100)
  assert.equal(preview.referenceConflicts[0].title, 'Same')
  assert.deepEqual(preview.referenceConflicts[0].targetIds, ['one-local', 'two-local'])
  assert.equal(JSON.stringify(preview).includes('D:/Music'), false)
  await assert.rejects(restore(b.db, data), { code: 'IDENTITY_CONFLICT' })
})

test('suppression sets follow the selected identity state, including an explicitly empty confirmed set', async t => {
  const a = fixture(t), b = fixture(t), id = a.recordings[0], input = a.db.identificationInput(id)
  const [candidate] = a.db.identificationPublish(input, [{ provider: 'ncm', name: 'Same', summary: '', references: [{ provider: 'ncm', kind: 'recording', idType: 'native', value: '1' }],
    evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }, matcherVersion: 'v1' }], 1)
  a.db.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision, decision: 'confirm' }, 2)
  const confirmed = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), link = a.db.identificationDetail(id).link!
  a.db.identificationDetach(link.id, link.revision, 3)
  const detached = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, detached)
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM metadata_identity_suppressions').get()!.n, 1)
  await restore(b.db, confirmed, 'keep-detached', 'keep-local')
  assert.equal(b.db.sql.prepare('SELECT state FROM metadata_identity_links').get()!.state, 'detached')
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM metadata_identity_suppressions').get()!.n, 1)
  await restore(b.db, confirmed, 'confirm-backup')
  assert.equal(b.db.sql.prepare('SELECT state FROM metadata_identity_links').get()!.state, 'confirmed')
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM metadata_identity_suppressions').get()!.n, 0)
})

test('creation provenance cannot silently merge unreferenced identities or defer its storage conflict until apply', async t => {
  const a = fixture(t, false), b = fixture(t, false)
  a.db.sql.exec("INSERT INTO metadata_entities VALUES('incoming','musicbrainz','artist','legacy-id','Same')")
  b.db.sql.exec("INSERT INTO metadata_entities VALUES('existing','musicbrainz','artist','legacy-id','Same')")
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), preview = b.db.musicBackupPreview(data)
  assert.equal(preview.mappings[0].method, 'offline-anchor', 'creation provenance is not identity lookup authority')
  assert.deepEqual(preview.referenceConflicts[0].targetIds, ['existing'])
  assert.ok(preview.dependencies.includes('music:identity-reference-conflict'))
  await assert.rejects(restore(b.db, data), { code: 'IDENTITY_CONFLICT' })
  b.db.sql.exec("INSERT INTO metadata_entities VALUES('canonical','internal','artist','new-id','Same'); INSERT INTO metadata_identity_refs VALUES('ncm','artist','native','123','canonical')")
  data.records.identityRefs.push({ provider: 'ncm', kind: 'artist', id_type: 'native', value: '123', target_id: 'incoming' })
  assert.equal(b.db.musicBackupPreview(data).referenceConflicts.length, 0, 'an already-existing ref target keeps its own creation provenance')
  await restore(b.db, data, 'with-exact-ref')
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM metadata_entities').get()!.n, 2)
})

test('database-local audit sequences remap restoredFrom and album-member parent receipts across export and replay', async t => {
  const a = fixture(t), b = fixture(t), entityId = String(a.db.sql.prepare("SELECT id FROM catalog_entities WHERE kind='artist' LIMIT 1").get()!.id), input = a.db.identificationInput(entityId)
  const [candidate] = a.db.identificationPublish(input, [{ provider: 'ncm', name: 'Confirmed title', summary: '', references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: 'sequence-test' }],
    evidence: { origin: 'search', matches: ['id'], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }, matcherVersion: 'fixture-v1' }], 10)
  const detail = a.db.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision, decision: 'confirm' }, 11)
  const first = a.db.identificationHistory({ entityId }).items[0]
  a.db.identificationDetach(detail.link!.id, detail.link!.revision, 12)
  const current = a.db.identificationInput(entityId)
  a.db.identificationRestore({ entityId, historySeq: first.seq, inputVersion: current.version, linkRevision: current.linkRevision }, 13)
  const restored = a.db.identificationHistory({ entityId }).items[0]
  // A historical album-member receipt has the same cross-event sequence shape.
  const row = a.db.sql.prepare('SELECT * FROM metadata_identity_history WHERE seq=?').get(restored.seq)!, audit = JSON.parse(String(row.evidence))
  audit.evidence.verification = { method: 'album_member', parent: { entityId, candidateId: candidate.id, historySeq: first.seq, linkRevision: 9 } }
  a.db.sql.prepare('UPDATE metadata_identity_history SET evidence=? WHERE seq=?').run(JSON.stringify(audit), restored.seq)
  a.db.sql.prepare('UPDATE metadata_link_history SET evidence=? WHERE changed_at=13').run(JSON.stringify(audit))
  b.db.sql.exec("INSERT INTO sqlite_sequence VALUES('metadata_identity_history',90); INSERT INTO sqlite_sequence VALUES('metadata_link_history',80)")
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, data)
  const imported = b.db.sql.prepare('SELECT seq,evidence FROM metadata_identity_history WHERE changed_at=13').get()!, original = b.db.sql.prepare('SELECT seq FROM metadata_identity_history WHERE changed_at=11').get()!, evidence = JSON.parse(String(imported.evidence))
  assert.ok(Number(original.seq) > 90)
  assert.equal(evidence.decision.restoredFrom, original.seq)
  assert.equal(evidence.evidence.verification.parent.historySeq, original.seq)
  assert.equal(evidence.evidence.verification.parent.linkRevision, 9, 'a portable receipt never refreshes an old link/input fence')
  const legacy = JSON.parse(String(b.db.sql.prepare('SELECT evidence FROM metadata_link_history WHERE changed_at=13').get()!.evidence))
  assert.equal(legacy.decision.restoredFrom, original.seq)
  assert.equal(legacy.evidence.verification.parent.historySeq, original.seq)
  const count = b.db.sql.prepare('SELECT count(*) n FROM metadata_identity_history').get()!.n
  await restore(b.db, data, 'audit-replay')
  assert.equal(b.db.sql.prepare('SELECT count(*) n FROM metadata_identity_history').get()!.n, count)
  const roundtrip = b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(a.db, roundtrip, 'audit-roundtrip')
  assert.equal(a.db.sql.prepare('SELECT count(*) n FROM metadata_identity_history').get()!.n, data.records.identityHistory.length)
  const duplicate = structuredClone(data); duplicate.records.identityHistory.push({ ...duplicate.records.identityHistory[0] })
  assert.equal(validateMusicPersonalBackup(duplicate), false)
})

test('reordered backups cannot let obsolete offline favorite receipts rebind a different current position', async t => {
  const a = fixture(t), b = fixture(t, false), document = a.db.exportDocument(), snapshots = Object.fromEntries((document.tracks as import('../../shared/libraryDatabase.ts').LibraryTrackRecord[]).map(track => [track.id, track as unknown as import('../../shared/track.ts').TrackData]))
  a.db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: [{ id: 'favorites', name: 'Favorites', isDefault: true, trackIds: ['track-2', 'track-1'], trackSnapshots: snapshots, createdAt: '2026-01-01' }] }, 100)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, data)
  const reordered = structuredClone(data), views = JSON.parse(String(reordered.records.favorites[0].payload))
  views[0].trackIds.reverse(); reordered.records.favorites[0].payload = JSON.stringify(views)
  await restore(b.db, reordered, 'reordered')
  b.db.replaceDocument({ ...document, tracks: (document.tracks as import('../../shared/libraryDatabase.ts').LibraryTrackRecord[]).filter(track => track.id === 'track-2') })
  while (b.db.catalogStatus().localPending) b.db.catalogAdvance()
  const view = b.db.preferencesPlaylistsLoad()!.data[0]
  assert.equal(view.trackIds.length, 2)
  assert.ok(view.trackIds[0].startsWith('offline_favorite_'))
  assert.equal(view.trackIds[1], 'track-2')
  assert.equal(await createSourceResolver().resolve(view.trackSnapshots![view.trackIds[0]]), null)
})

test('music backup preserves duplicate favorite occurrences through live, offline and exact-source return', async t => {
  const a = fixture(t), live = fixture(t), offline = fixture(t, false), document = a.db.exportDocument()
  const snapshots = Object.fromEntries((document.tracks as import('../../shared/libraryDatabase.ts').LibraryTrackRecord[]).map(track => [track.id, track as unknown as import('../../shared/track.ts').TrackData]))
  const ids = ['track-2', 'track-1', 'track-1', 'missing-original', 'track-2']
  a.db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: [
    { id: 'favorites', name: 'Favorites', isDefault: true, createdAt: '2026-01-01', trackIds: ids, trackSnapshots: snapshots }
  ] }, 100)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(validateMusicPersonalBackup(data), true)
  const exportedIds = (db: LibraryDatabase) => (JSON.parse(String(db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES).records.favorites[0].payload)) as import('../../shared/playlists.ts').Playlist[])[0].trackIds
  assert.deepEqual(exportedIds(a.db), ids)
  await restore(live.db, data, 'duplicate-live')
  const liveIds = live.db.preferencesPlaylistsLoad()!.data[0].trackIds
  assert.deepEqual(liveIds.slice(0, 3), ids.slice(0, 3))
  assert.ok(liveIds[3].startsWith('offline_favorite_'))
  assert.equal(liveIds[4], 'track-2')
  assert.deepEqual(exportedIds(live.db), ids)
  await restore(offline.db, data, 'duplicate-offline')
  const retained = offline.db.preferencesPlaylistsLoad()!.data[0]
  assert.equal(retained.trackIds.length, ids.length)
  assert.equal(new Set(retained.trackIds).size, ids.length, 'each offline occurrence has an independent retained anchor')
  assert.deepEqual(exportedIds(offline.db), ids)
  offline.db.replaceDocument(document)
  while (offline.db.catalogStatus().localPending) offline.db.catalogAdvance()
  const reattached = offline.db.preferencesPlaylistsLoad()!.data[0]
  assert.deepEqual(reattached.trackIds.slice(0, 3), ids.slice(0, 3))
  assert.ok(reattached.trackIds[3].startsWith('offline_favorite_'))
  assert.equal(reattached.trackIds[4], 'track-2')
  assert.deepEqual(exportedIds(offline.db), ids)
  const recording = String(offline.db.sql.prepare("SELECT recording_id FROM catalog_sources WHERE track_id='track-1'").get()!.recording_id)
  offline.db.preferencesSet({ entityId: recording, state: 'none', token: offline.db.preferencesDetail(recording).token }, 101)
  assert.equal(offline.db.preferencesDetail(recording).value?.state, 'none')
  assert.equal(versionSourceKey(reattached.trackSnapshots!['track-1']), offline.db.sql.prepare("SELECT source_key FROM catalog_sources WHERE track_id='track-1'").get()!.source_key)
  assert.deepEqual(offline.db.preferencesPlaylistsLoad()!.data[0].trackIds, ['track-2', reattached.trackIds[3], 'track-2'])
})

test('a cross-provider Track ID collision retains its exact offline favorite instead of dropping or misplaying it', async t => {
  const a = fixture(t), b = fixture(t)
  const online = (id: string): import('../../shared/track.ts').TrackData => ({
    id, source: 'ncm', ncmSongId: 7, title: 'Online', artist: 'Other', album: 'Platform',
    filePath: '', fileName: '', size: 0, duration: 200, cover: null, lyrics: null
  })
  const sync = (db: LibraryDatabase, track: import('../../shared/track.ts').TrackData, revision: number) => {
    let job = db.catalogSync({ kind: 'begin', revision })
    job = db.catalogSync({ kind: 'append', ...job, tracks: [track] })
    db.catalogSync({ kind: 'commit', ...job })
  }
  sync(a.db, online('original-online-id'), 1)
  sync(b.db, online('track-1'), 1)
  const local = a.db.getTracksByIds(['track-1']).tracks[0] as unknown as import('../../shared/track.ts').TrackData
  a.db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: [{
    id: 'favorites', name: 'Favorites', isDefault: true, createdAt: '2026-01-01',
    trackIds: ['track-1', 'original-online-id'], trackSnapshots: { 'track-1': local, 'original-online-id': online('original-online-id') }
  }] }, 100)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, data, 'collision-favorite')
  const view = b.db.preferencesPlaylistsLoad()!.data[0]
  assert.equal(view.trackIds.length, 2)
  assert.equal(view.trackIds[0], 'track-1')
  assert.ok(view.trackIds[1].startsWith('offline_favorite_'))
  assert.equal(view.trackSnapshots!['track-1'].source, 'local')
  assert.equal(await createSourceResolver().resolve(view.trackSnapshots![view.trackIds[1]]), null)
  sync(b.db, online('track-1'), 2)
  assert.deepEqual(b.db.preferencesPlaylistsLoad()!.data[0], view, 'source return cannot replace the other provider snapshot')
  const exported = b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.deepEqual(JSON.parse(String(exported.records.favorites[0].payload))[0].trackIds, ['track-1', 'original-online-id'])
})
