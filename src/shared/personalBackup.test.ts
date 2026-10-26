import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyMusicBackupRecords } from './musicPersonalBackup.ts'
import {
  PERSONAL_DOMAINS, PERSONAL_V1_DOMAINS, personalDomainLabel, validatePersonalBackup,
  validPersonalExportOptions, personalBackupPathRoots, type PersonalBackup
} from './personalBackup.ts'
import { personalBackupJsonReplacer, personalBackupV2JsonReplacer } from './personalBackup.ts'

const envelope = (data: PersonalBackup['data'], version: 1 | 2 = 2): PersonalBackup => ({
  format: 'twilight-personal-data', version, createdAt: '2026-10-24T00:00:00.000Z', data
})
const music = () => ({ version: 1 as const, origin: 'portable-fixture', dictionaryVersion: 1, records: emptyMusicBackupRecords() })

test('v2 explicitly adds music while v1 retains its original unknown-domain rejection', () => {
  assert.equal(PERSONAL_V1_DOMAINS.length, 10)
  assert.equal(PERSONAL_DOMAINS.length, 11)
  assert.equal(validatePersonalBackup(envelope({ music: music() })), true)
  assert.equal(validatePersonalBackup(envelope({ music: music() }, 1)), false)
  assert.equal(validatePersonalBackup(envelope({ settings: {} } as PersonalBackup['data'])), false)
  const invalid = music()
  Object.assign(invalid.records, { privateCache: [] })
  assert.equal(validatePersonalBackup(envelope({ music: invalid })), false)
})

test('v2 playlists retain the system view identity but cannot restore another favorite member authority', () => {
  const playlist = { id: 'favorite-view', name: '收藏', isDefault: true, trackIds: [] as string[] }
  assert.equal(validatePersonalBackup(envelope({ playlists: [playlist] })), true)
  assert.equal(validatePersonalBackup(envelope({ playlists: [{ ...playlist, trackIds: ['song'] }] })), false)
  assert.equal(validatePersonalBackup(envelope({ playlists: [{ ...playlist, trackSnapshots: {} }] })), false)
  assert.equal(validatePersonalBackup(envelope({ playlists: [{ ...playlist, trackIds: ['song'] }] }, 1)), true)
  assert.equal(validatePersonalBackup(envelope({ playlists: [{ ...playlist, isDefault: false, trackIds: ['song', 'song'] }] })), true)
  assert.equal(personalDomainLabel('playlists', 1), '歌单与收藏')
  assert.equal(personalDomainLabel('playlists', 2), '歌单')
  assert.equal(personalDomainLabel('music', 2), '收藏与音乐整理')
})

test('export selection is optional, bounded, unique and limited to portable domains', () => {
  assert.equal(validPersonalExportOptions({}), true)
  assert.equal(validPersonalExportOptions({ domains: ['music', 'playlists'] }), true)
  for (const value of [{ domains: [] }, { domains: ['music', 'music'] }, { domains: ['settings'] }, { raw: true }, null])
    assert.equal(validPersonalExportOptions(value), false)
})

test('v2 retains embedded user covers and removes nonportable image grants without changing v1 snapshots', () => {
  const value = { cover: 'cover://cached', coverSmall: 'twilight-media://image/session',
    coverSource: 'https://limited.test/image', coverSmallSource: 'https://limited.test/small',
    nested: { cover: 'data:image/png;base64,AA==' }, title: 'cover://a user title' }
  assert.deepEqual(JSON.parse(JSON.stringify(value, personalBackupV2JsonReplacer)), {
    cover: null, coverSmall: null, nested: value.nested, title: value.title
  })
  assert.deepEqual(JSON.parse(JSON.stringify(value, personalBackupJsonReplacer)), value)
})

test('music-only path mapping roots use exact local parents, merge per volume and bound uncommon shares', () => {
  const data = music()
  data.records.sources = ['C:/Music/Album/a.flac', 'c:/music/Other/b.flac', '/Music/One/a.flac', '/music/Two/b.flac'].map((path, n) => ({
    id: String(n), source_key: JSON.stringify(['local', path]), provider: 'local', recording_id: 'r', release_id: null, album_key: null
  }))
  assert.deepEqual(personalBackupPathRoots(envelope({ music: data })).roots, ['C:/Music', '/'])
  assert.deepEqual(personalBackupPathRoots(envelope({ music: data, library: { folders: ['C:/Declared'] } })).roots, ['C:/Declared'])
  data.records.sources = Array.from({ length: 101 }, (_, n) => ({
    id: String(n), source_key: JSON.stringify(['local', `//server-${n}/share/album/song.flac`]), provider: 'local', recording_id: 'r', release_id: null, album_key: null
  }))
  const roots = personalBackupPathRoots(envelope({ music: data }))
  assert.equal(roots.roots.length, 100)
  assert.equal(roots.rootsTruncated, true)
})
