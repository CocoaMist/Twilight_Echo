import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LibraryDatabasePreferences } from '../../main/library/libraryDatabasePreferences.ts'
import { CorePlaylistService } from './service.ts'
import { createPreferencesPlaylistRepository } from './preferencesRepository.ts'
import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import type { TrackData } from '../../shared/track.ts'
import type { Playlist } from '../../shared/playlists.ts'
import type { VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'

const track = (id: string): TrackData => ({ id, source: 'local', filePath: `D:/${id}.flac`, fileName: `${id}.flac`, title: 'Same', artist: 'Artist', album: 'Album', duration: 180, size: 1, lyrics: null, cover: null })
const data = (tracks: TrackData[]): Playlist[] => [{ id: 'original-default', name: '我收藏的音乐', isDefault: true, trackIds: tracks.map(t => t.id), trackSnapshots: Object.fromEntries(tracks.map(t => [t.id, t])), createdAt: '2026-10-24T00:00:00Z' }]

test('migration adapter fences the complete legacy envelope twice, rejects incomplete/moving snapshots and never writes legacy JSON', async () => {
  const db = new LibraryDatabase(':memory:')
  try {
    let loads = 0
    const envelope: VersionedDataEnvelope<Playlist[]> = { version: 2, revision: 4, savedAt: 'old', data: data([track('one')]) }
    const api = { preferencesPlaylistsLoad: async () => db.preferencesPlaylistsLoad(), preferencesPlaylistsMigrate: async (...args: Parameters<typeof db.preferencesPlaylistsMigrate>) => db.preferencesPlaylistsMigrate(...args), preferencesPlaylistsSave: async (...args: Parameters<typeof db.preferencesPlaylistsSave>) => db.preferencesPlaylistsSave(...args) }
    const moving = createPreferencesPlaylistRepository({ database: api, now: () => 1, legacy: { load: async () => ({ ...envelope, revision: ++loads }) } })
    await assert.rejects(moving.load(), /原歌单发生变化/); assert.equal(db.preferencesPlaylistsLoad(), null)
    const incomplete = createPreferencesPlaylistRepository({ database: api, now: () => 1, legacy: { load: async () => envelope.data } })
    await assert.rejects(incomplete.load(), /完整、有版本/); assert.equal(db.preferencesPlaylistsLoad(), null)
    loads = 0
    const repository = createPreferencesPlaylistRepository({ database: api, now: () => 1, legacy: { load: async () => { loads++; return structuredClone(envelope) } } })
    const migrated = await repository.load(); assert.equal(migrated.revision, 4); assert.equal(loads, 2)
    const receipt = new LibraryDatabasePreferences({ sql: db.sql, transaction() { throw new Error('Receipt read must not mutate') } }).playlistsMigrationReceipt()!
    assert.equal(receipt.sourceRevision, 4); assert.equal(receipt.rawRowCount, 1); assert.equal(receipt.logicalMemberCount, 1)
    assert.equal(receipt.items[0].status, 'resolved')
    migrated.data.push({ id: 'ordinary', name: 'Regular', createdAt: 'now', trackIds: ['dup', 'dup'] })
    const saved = await repository.save(migrated.data, migrated.revision)
    assert.equal(loads, 2); assert.deepEqual(saved.data[1].trackIds, ['dup', 'dup'])
    assert.deepEqual(envelope.data, data([track('one')]))
  } finally { db.close() }
})

test('old favorite endpoints retain logical equivalence until explicit none/ban; toggle and paged favorite can replace a ban', async t => {
  const db = new LibraryDatabase(':memory:'), a = track('one'), b = track('two')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [a, b] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const repository = createPreferencesPlaylistRepository({ now: () => 100, legacy: { load: async () => ({ version: 2, revision: 0, savedAt: 'old', data: data([a]) }) }, database: {
    preferencesPlaylistsLoad: async () => db.preferencesPlaylistsLoad(), preferencesPlaylistsMigrate: async (...args) => db.preferencesPlaylistsMigrate(...args), preferencesPlaylistsSave: async (...args) => db.preferencesPlaylistsSave(...args)
  } })
  const service = new CorePlaylistService({
    runtime: { repository, now: () => 100, newId: () => 'new', clone: structuredClone, notify() {}, identity: createLogicalTrackModel(() => undefined), versions: { ensure() {}, revision: () => 0 } },
    preferencesTrackStates: async tracks => db.preferencesTrackStates(tracks),
    database: { syncPlaylistView: async (...args) => db.syncPlaylistView(...args), getMetadata: async () => db.getMetadata(), lookupTracksByPaths: async (...args) => db.lookupTracksByPaths(...args), getTracksByIds: async (...args) => db.getTracksByIds(...args), queryTracks: async (...args) => db.queryTracks(...args) },
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions }, changed() {}
  })
  t.after(async () => { await service.shutdown(); db.close() })
  await service.initialize()
  assert.equal(await service.isFavorite(b), true, 'old unscored neighbor retains original recording equivalence')
  const id = String(db.sql.prepare('SELECT recording_id FROM catalog_sources WHERE track_id=?').get(b.id)!.recording_id)
  const set = (state: 'ban' | 'none') => db.preferencesSet({ entityId: id, state, token: db.preferencesDetail(id).token }, 200)
  set('ban'); await service.refreshPreferences()
  assert.equal(await service.isFavorite(b), false)
  assert.deepEqual((await service.favorites(service.getRevision(), [a, b])).contains, [true, false])
  assert.equal(await service.toggleFavorite(b, () => {}), true)
  assert.equal(db.preferencesDetail(id).value!.state, 'favorite')
  set('ban'); await service.refreshPreferences()
  await service.editPages(service.getRevision(), { kind: 'favorite', favorite: true }, async append => { await append([{ id: b.id, track: b }]) })
  assert.equal(db.preferencesDetail(id).value!.state, 'favorite')
  set('none'); await service.refreshPreferences()
  await service.edit(service.getRevision(), { kind: 'favorite', favorite: true, tracks: [b] })
  assert.equal(db.preferencesDetail(id).value!.state, 'favorite')
  set('ban'); await service.refreshPreferences()
  await service.edit(service.getRevision(), { kind: 'favorite', favorite: false, tracks: [b] })
  assert.equal(db.preferencesDetail(id).value!.state, 'ban', 'old unfavorite never clears explicit ban')
})
