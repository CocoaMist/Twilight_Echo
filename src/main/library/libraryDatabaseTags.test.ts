import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { validMusicTagsPayload, normalizeMusicTagName } from '../../shared/musicTags.ts'
import type { TrackData } from '../../shared/track.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import type { MusicCredit } from '../../shared/musicCredits.ts'

const track = (id: string, extra: Partial<TrackData> = {}): TrackData => ({ id, source: 'local', title: `Song ${id}`, artist: 'Artist', album: 'Album',
  filePath: `D:/music/${id}.flac`, fileName: `${id}.flac`, duration: 100, size: 0, cover: null, lyrics: null, ...extra })
const seed = (db: LibraryDatabase, tracks: TrackData[]) => {
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  while (db.catalogStatus().localPending) db.catalogAdvance()
}
function fixture(t: test.TestContext, tracks = [track('a'), track('b')]) {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close()); seed(db, tracks)
  const create = (name = 'Night') => db.tagsCreate({ name, tagsRevision: db.tagsState().tagsRevision }, 100).tag
  const add = (tagId: string, entityId: string, present = true) => db.tagsMemberSet({ tagId, entityId, present,
    membersRevision: db.tagsMembers({ tagId }).tag.membersRevision }, 101).tag
  const recordings = db.sql.prepare('SELECT id FROM catalog_entities WHERE kind=\'recording\' ORDER BY id').all().map(r => String(r.id))
  const releases = db.sql.prepare('SELECT id FROM catalog_entities WHERE kind=\'release\' ORDER BY id').all().map(r => String(r.id))
  return { db, create, add, recordings, releases }
}

test('tags public validation bounds pages, names and search and rejects profiles, snapshots and forged tokens', () => {
  const token = { tagsRevision: 0, catalogRevision: 0, contentRevision: 0, linkRevision: 0 }
  for (const name of ['tags.members', 'tags.recordings']) {
    assert.equal(validMusicTagsPayload(name, { tagId: 'tag', token, limit: 100 }), true)
    for (const input of [{ tagId: 'tag', limit: 101 }, { tagId: 'tag', limit: 0 }, { tagId: 'tag', offset: -1 },
      { tagId: 'tag', profileId: 'other' }, { tagId: 'tag', token: { ...token, linkRevision: 1.5 } }]) assert.equal(validMusicTagsPayload(name, input), false)
  }
  assert.equal(validMusicTagsPayload('tags.play', { tagId: 'tag', token, sourceId: 'source' }), true)
  assert.equal(validMusicTagsPayload('tags.play', { tagId: 'tag', token, tracks: [] }), false)
  assert.equal(validMusicTagsPayload('tags.create', { name: '  ', tagsRevision: 0 }), false)
  assert.equal(validMusicTagsPayload('tags.create', { name: 'x'.repeat(81), tagsRevision: 0 }), false)
  assert.equal(validMusicTagsPayload('tags.list', { search: 'x'.repeat(161) }), false)
  assert.equal(validMusicTagsPayload('tags.member.set', { tagId: 'tag', entityId: 'one', present: true, membersRevision: 0, parentTagId: 'nested' }), false)
  assert.equal(normalizeMusicTagName(' ＮＩＧＨＴ  Jazz '), 'night jazz')
})

test('tag names are normalized and unique while name and member CAS revisions remain independent', t => {
  const { db, create, add, recordings: [one, two] } = fixture(t), tag = create(' Ｎｉｇｈｔ   Jazz ')
  assert.equal(tag.name, 'Night Jazz')
  assert.throws(() => create('night jazz'), { code: 'TAG_NAME_CONFLICT' })
  const renamed = db.tagsRename({ tagId: tag.id, nameRevision: tag.nameRevision, name: 'Late' }, 102).tag
  const member = db.tagsMemberSet({ tagId: tag.id, entityId: one, present: true, membersRevision: tag.membersRevision }, 103).tag
  assert.equal(member.name, 'Late'); assert.equal(member.nameRevision, renamed.nameRevision); assert.equal(member.membersRevision, 1)
  const renamedAgain = db.tagsRename({ tagId: tag.id, nameRevision: renamed.nameRevision, name: 'Later' }, 104).tag
  assert.equal(renamedAgain.membersRevision, 1)
  assert.throws(() => db.tagsRename({ tagId: tag.id, nameRevision: tag.nameRevision, name: 'Stale' }, 105), { code: 'STALE_REVISION' })
  assert.throws(() => db.tagsMemberSet({ tagId: tag.id, entityId: two, present: true, membersRevision: tag.membersRevision }, 105), { code: 'STALE_REVISION' })
  assert.equal(add(tag.id, one).membersRevision, 1, 'idempotent add is not a new mutation')
  assert.equal(db.tagsList({ search: 'LATER', limit: 1 }).items[0].id, tag.id)
  assert.throws(() => db.tagsCreate({ name: 'stale create', tagsRevision: 0 }, 106), { code: 'STALE_REVISION' })
})

test('exact song/release/person references are members, not album projects or manual playback versions', t => {
  const { db, create, add, recordings: [one], releases: [album] } = fixture(t), tag = create()
  add(tag.id, one); add(tag.id, album)
  const unsupported = db.sql.prepare("SELECT id FROM catalog_entities WHERE kind='album_project'").all().map(r => String(r.id))
  db.sql.prepare("INSERT INTO catalog_entities VALUES('manual','recording','Manual','Artist','manual')").run()
  for (const entityId of [...unsupported, 'manual']) {
    assert.throws(() => add(tag.id, entityId), /标签只支持|请选择具体/)
    assert.throws(() => db.tagsEntity({ entityId }), /标签只支持|请选择具体/)
  }
  assert.equal(db.tagsMembers({ tagId: tag.id }).total, 2)
  assert.equal(db.tagsEntity({ entityId: one }).total, 1)
  const artists = db.sql.prepare("SELECT id FROM catalog_entities WHERE kind='artist' ORDER BY id").all().map(r => String(r.id))
  add(tag.id, artists[0])
  assert.equal(db.tagsEntity({ entityId: artists[0] }).total, 1)
  assert.equal(db.tagsEntity({ entityId: artists[1] }).total, 0, 'same-name people retain distinct source anchors')
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 2, 'person membership does not add participant recordings to song/release expansion')
})

test('person/work tags retain exact anchors, count real participation and never implicitly expand playback', t => {
  const { db, create, add, recordings, releases: [release] } = fixture(t)
  const work = { provider: 'mb', kind: 'work' as const, idType: 'mbid', value: 'work-1' }
  const person = { provider: 'mb', kind: 'artist' as const, idType: 'mbid', value: 'person-1' }
  const otherPerson = { ...person, value: 'person-2' }
  const attribution = { provider: 'mb', externalId: 'relation', url: 'https://musicbrainz.org', license: 'CC0', licenseUrl: '', attribution: 'MusicBrainz', revision: '1', retrievedAt: 1 }
  const credit: MusicCredit = { personRef: person, targetRef: work, name: 'Same Person', role: 'composer', rawRole: 'composer', relationTypeId: 'composer',
    direction: 'backward', order: 0, joinphrase: '', attributes: [], begin: '', end: '', attribution }
  db.explorationIngest({ owner: work, provider: 'mb', setKey: 'work-credits', truncated: false,
    nodes: [{ reference: work, title: 'Work' }, { reference: person, title: 'Same Person' }, { reference: otherPerson, title: 'Same Person' }],
    relations: [{ from: person, to: work, kind: 'credit', order: 0, credit, attribution }] })
  const id = (value: string) => String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(value)!.entity_id)
  const tag = create('People and works'), workId = id(work.value), personId = id(person.value)
  add(tag.id, workId); add(tag.id, personId)
  const before = db.tagsMembers({ tagId: tag.id })
  assert.equal(before.items.every(item => !item.inLibrary), true)
  db.explorationPerformanceSave({ title: 'Explicit performance', workId, recordingIds: recordings, revision: db.explorationState().revision })
  assert.throws(() => db.tagsMembers({ tagId: tag.id, token: before.token }), { code: 'STALE_REVISION' })
  const members = db.tagsMembers({ tagId: tag.id })
  assert.deepEqual(members.items.map(item => [item.kind, item.sourceCount, item.inLibrary]), [['artist', 2, true], ['work', 2, true]])
  assert.equal(db.tagsEntity({ entityId: id(otherPerson.value) }).total, 0, 'same-name external identities never share membership')
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 0)
  assert.equal(db.tagsPlaybackPage({ tagId: tag.id }).total, 0)
  add(tag.id, release)
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 2, 'only an explicit release reference expands its songs')
  seed(db, [])
  assert.equal(db.tagsMembers({ tagId: tag.id }).items.every(item => !item.inLibrary), true)
  assert.equal(db.tagsEntity({ entityId: workId }).total, 1, 'offline work remains manageable')
  add(tag.id, workId, false)
  assert.equal(db.tagsEntity({ entityId: workId }).total, 0)
})

test('album membership is a reference, new imported tracks expand dynamically, and song tags do not tag albums', t => {
  const { db, create, add, recordings: [one], releases: [album] } = fixture(t, [track('a')])
  const albumTag = create('Album collection'), songTag = create('Song collection')
  add(albumTag.id, album); add(songTag.id, one)
  assert.equal(db.tagsMembers({ tagId: albumTag.id }).total, 1)
  assert.equal(db.tagsRecordings({ tagId: albumTag.id }).total, 1)
  assert.equal(db.tagsEntity({ entityId: album }).items.some(tag => tag.id === songTag.id), false)
  const frozen = db.tagsRecordings({ tagId: albumTag.id }).token
  seed(db, [track('a'), track('b')])
  assert.equal(db.tagsRecordings({ tagId: albumTag.id }).total, 2)
  assert.equal(db.tagsMembers({ tagId: albumTag.id }).total, 1, 'never copy album tracks to member rows')
  assert.equal(db.tagsRecordings({ tagId: songTag.id }).total, 1)
  assert.throws(() => db.tagsRecordings({ tagId: albumTag.id, token: frozen }), { code: 'STALE_REVISION' })
})

test('tag collection deduplicates only same physical recording or current confirmed same-kind identity', t => {
  const { db, create, add, recordings: [one, two], releases: [album] } = fixture(t), tag = create()
  add(tag.id, album); add(tag.id, one); add(tag.id, two)
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 2, 'names, albums and unconfirmed metadata do not merge recordings')
  db.sql.prepare("INSERT INTO metadata_entities VALUES('identity','fixture','recording','42','Same')").run()
  for (const id of [one, two]) db.sql.prepare("INSERT INTO metadata_identity_links VALUES(?,?,'recording',1,'identity','confirmed')").run(`link:${id}`, id)
  const merged = db.tagsRecordings({ tagId: tag.id })
  assert.equal(merged.total, 1); assert.equal(merged.items[0].sourceCount, 2)
  assert.equal(db.tagsMembers({ tagId: tag.id }).total, 3, 'confirmation never transfers exact tag references')
  db.sql.prepare("UPDATE metadata_identity_links SET state='detached',revision=revision+1 WHERE entity_id=?").run(two)
  assert.throws(() => db.tagsRecordings({ tagId: tag.id, token: merged.token }), { code: 'STALE_REVISION' })
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 2)
  assert.equal(db.tagsEntity({ entityId: two }).total, 1)
  db.sql.prepare("UPDATE metadata_identity_links SET target_id='identity',state='confirmed',revision=revision+1 WHERE entity_id=?").run(two)
  db.sql.prepare("UPDATE metadata_entities SET kind='release' WHERE id='identity'").run()
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 2, 'wrong-kind metadata identity never deduplicates')
})

test('tag recording expansion excludes cached nonmembers and pending/stale local rows; private page alone contains paths', t => {
  const { db, create, add, recordings: [one] } = fixture(t, [track('a')]), tag = create()
  add(tag.id, one)
  const publicPage = db.tagsRecordings({ tagId: tag.id })
  assert.equal(JSON.stringify(publicPage).includes('D:/'), false)
  assert.equal(JSON.stringify(publicPage).includes('trackId'), false)
  assert.equal(db.tagsPlaybackPage({ tagId: tag.id }).items[0].track.filePath, 'D:/music/a.flac')
  db.sql.prepare("INSERT INTO catalog_pending VALUES('a')").run()
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 0)
  db.sql.prepare('DELETE FROM catalog_pending').run()
  db.sql.prepare('DELETE FROM catalog_memberships').run()
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 0)
  assert.equal(db.tagsMembers({ tagId: tag.id }).items[0].inLibrary, false)
})

test('earlier streaming membership is not displaced by local; an explicit preferred candidate wins inside the frozen collection', t => {
  const { db, create, add, recordings: [local] } = fixture(t, [track('a')]), tag = create()
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [track('ncm:42', { source: 'ncm', ncmSongId: 42, albumId: 'remote-album', filePath: '' })] })
  db.catalogSync({ kind: 'commit', ...job })
  const remote = String(db.sql.prepare("SELECT recording_id FROM catalog_sources WHERE provider='ncm'").get()!.recording_id)
  add(tag.id, local); add(tag.id, remote)
  db.sql.prepare("INSERT INTO metadata_entities VALUES('same-song','fixture','recording','42','Same')").run()
  for (const id of [local, remote]) db.sql.prepare("INSERT INTO metadata_identity_links VALUES(?,?,'recording',1,'same-song','confirmed')").run(`link:${id}`, id)
  const sources = db.sql.prepare('SELECT id,provider,source_key FROM catalog_sources').all()
  for (const source of sources) db.sql.prepare("UPDATE catalog_state SET value=? WHERE key='membership_added:'||?").run(source.provider === 'ncm' ? '10' : '20', String(source.id))
  assert.equal(db.tagsRecordings({ tagId: tag.id }).items[0].provider, 'ncm')
  const document = emptyMusicVersions()
  document.tracks.versions = [{ id: 'confirmed-version', label: 'Same', sources: sources.map(row => String(row.source_key)),
    preferredSource: String(sources.find(row => row.provider === 'local')!.source_key) }]
  db.catalogProjectVersions(document, 1)
  assert.equal(db.tagsRecordings({ tagId: tag.id }).items[0].provider, 'local')
  assert.equal(db.tagsMembers({ tagId: tag.id }).total, 2, 'manual navigation does not replace physical members')
})

test('tags retain offline references and edits through source removal and database reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'te-tags-')), path = join(dir, 'library.sqlite')
  const db = new LibraryDatabase(path); seed(db, [track('a')])
  const entityId = db.catalogQuery({ kind: 'recording' }).items[0].id
  let tag = db.tagsCreate({ name: 'Offline', tagsRevision: 0 }, 1).tag
  tag = db.tagsMemberSet({ tagId: tag.id, entityId, present: true, membersRevision: 0 }, 2).tag
  seed(db, [])
  assert.equal(db.tagsMembers({ tagId: tag.id }).items[0].inLibrary, false)
  assert.equal(db.tagsRecordings({ tagId: tag.id }).total, 0)
  tag = db.tagsRename({ tagId: tag.id, name: 'Retained', nameRevision: tag.nameRevision }, 3).tag
  const token = db.tagsState(); db.close()
  const reopened = new LibraryDatabase(path)
  t.after(() => { reopened.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.deepEqual(reopened.tagsState(), token)
  assert.equal(reopened.tagsEntity({ entityId }).items[0].name, 'Retained')
  assert.equal(reopened.tagsMemberSet({ tagId: tag.id, entityId, present: false, membersRevision: tag.membersRevision }, 4).tag.memberCount, 0)
})

test('delete checks both revisions and removes only its own references', t => {
  const { db, create, add, recordings: [one, two] } = fixture(t), tag = create(), other = create('Other')
  add(tag.id, one); add(other.id, one)
  const before = db.tagsMembers({ tagId: tag.id }).tag
  add(tag.id, two)
  assert.throws(() => db.tagsDelete({ tagId: tag.id, nameRevision: before.nameRevision, membersRevision: before.membersRevision }), { code: 'STALE_REVISION' })
  const current = db.tagsMembers({ tagId: tag.id }).tag
  db.tagsDelete({ tagId: tag.id, nameRevision: current.nameRevision, membersRevision: current.membersRevision })
  assert.equal(db.tagsEntity({ entityId: one }).items[0].id, other.id)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 2)
  assert.equal(db.tagsList({}).total, 1)
})

test('all paged views fence each revision and entity membership pagination is complete', t => {
  const { db, create, add, recordings: [one] } = fixture(t)
  for (let n = 0; n < 3; n++) add(create(`Tag ${n}`).id, one)
  const first = db.tagsEntity({ entityId: one, limit: 2 }), second = db.tagsEntity({ entityId: one, offset: 2, limit: 2, token: first.token })
  assert.equal(first.total, 3); assert.equal(second.items.length, 1)
  assert.equal(new Set([...first.items, ...second.items].map(v => v.id)).size, 3)
  const changes = db.sql.prepare('SELECT total_changes() n').get()!.n
  db.tagsList({}); db.tagsMembers({ tagId: first.items[0].id }); db.tagsRecordings({ tagId: first.items[0].id })
  assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, changes, 'tag reads do not ingest or write')
  for (const key of ['tagsRevision', 'catalogRevision', 'contentRevision', 'linkRevision'] as const) {
    const token = { ...first.token, [key]: first.token[key] + 1 }
    assert.throws(() => db.tagsList({ token }), { code: 'STALE_REVISION' })
    assert.throws(() => db.tagsMembers({ tagId: first.items[0].id, token }), { code: 'STALE_REVISION' })
    assert.throws(() => db.tagsRecordings({ tagId: first.items[0].id, token }), { code: 'STALE_REVISION' })
  }
})

test('failed member transaction rolls back tag value and both revision receipts', t => {
  const { db, create, recordings: [one] } = fixture(t), tag = create(), before = db.tagsState()
  db.sql.exec(`CREATE TRIGGER deny_tag_revision BEFORE UPDATE ON personal_tags_state BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`)
  assert.throws(() => db.tagsMemberSet({ tagId: tag.id, entityId: one, present: true, membersRevision: 0 }, 102), /fixture rollback/)
  assert.deepEqual(db.tagsState(), before)
  assert.equal(db.tagsMembers({ tagId: tag.id }).total, 0)
  assert.equal(db.tagsMembers({ tagId: tag.id }).tag.membersRevision, 0)
})
