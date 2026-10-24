import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabaseFocus } from './libraryDatabaseFocus.ts'
import { validMusicFocusPayload, validMusicFocusQuery, validMusicFocusToken, validMusicFocusPlaybackPageQuery, musicFocusQueryKey, type MusicFocusQuery, type MusicFocusNode } from '../../shared/musicFocus.ts'
import type { TrackData } from '../../shared/track.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'

const track = (id: string, fields: Partial<TrackData> = {}): TrackData => ({ id, source: 'local', title: `Song ${id}`, artist: 'Artist', album: 'Album',
  filePath: `D:/music/${id}.flac`, fileName: `${id}.flac`, duration: 100, size: 0, cover: null, lyrics: null, ...fields })
const query = (where?: MusicFocusNode, fields: Partial<MusicFocusQuery> = {}): MusicFocusQuery => ({ version: 1, entity: 'recording', ...(where ? { where } : {}), ...fields })
function seed(db: LibraryDatabase, tracks: TrackData[]) {
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  while (db.genresAdvance().pending) { /* durable maintenance */ }
}
function stream(db: LibraryDatabase, tracks: TrackData[]) {
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  job = db.catalogSync({ kind: 'append', ...job, tracks })
  db.catalogSync({ kind: 'commit', ...job })
  while (db.genresAdvance().pending) { /* durable maintenance */ }
}
function fixture(t: test.TestContext, tracks = [track('a'), track('b'), track('c')]) {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close()); seed(db, tracks)
  const source = (id: string) => db.sql.prepare('SELECT * FROM catalog_sources WHERE track_id=?').get(id)!
  const rating = (id: string, steps: number | null) => { const entityId = String(source(id).recording_id); return db.ratingsSet({ entityId, steps, token: db.ratingsDetail(entityId).token }, 100) }
  const preference = (id: string, state: 'favorite' | 'ban' | 'none', kind: 'recording' | 'release' = 'recording') => {
    const entityId = String(source(id)[`${kind}_id`]); return db.preferencesSet({ entityId, state, token: db.preferencesDetail(entityId).token }, 101)
  }
  return { db, source, rating, preference }
}
function confirm(db: LibraryDatabase, entityIds: string[], kind: 'recording' | 'release', target = 'identity') {
  db.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)').run(target, 'fixture', kind, target, target)
  for (const id of entityIds) db.sql.prepare('INSERT INTO metadata_identity_links VALUES(?,?,?,1,?,\'confirmed\')').run(`link:${id}`, id, kind, target)
}

test('Focus shared count/page preserves empty offsets and nested dimension filters with unknown facets', t => {
  const { db } = fixture(t, [track('a', { format: 'flac', releaseDate: '2000-01-01' }),
    track('b', { format: 'mp3', releaseDate: '2020-01-01' }), track('c')])
  const all = db.focusQuery({ query: query(), offset: 100, limit: 1 })
  assert.equal(all.total, 3); assert.deepEqual(all.items, [])
  const filtered = query({ not: { any: [{ source: { format: 'FLAC' } },
    { classification: { dimension: 'management', values: ['identified'] } }] } })
  assert.equal(db.focusQuery({ query: filtered }).total, 2)
  assert.deepEqual(db.focusFacets({ query: filtered, facet: 'format' }).items.map(i => [i.value, i.count]).sort(), [['MP3', 1], ['unknown', 1]])
  const pastFacets = db.focusFacets({ query: filtered, facet: 'format', offset: 10 })
  assert.equal(pastFacets.total, 2); assert.deepEqual(pastFacets.items, [])
  const emptyFacets = db.focusFacets({ query: query({ source: { provider: 'not-present' } }), facet: 'provider' })
  assert.equal(emptyFacets.total, 0); assert.deepEqual(emptyFacets.items, [])
  const years = db.focusQuery({ query: query(undefined, { sort: [{ field: 'releaseYear', direction: 'desc' }] }) })
  assert.deepEqual(years.items.map(i => [i.title, i.releaseYear]), [['Song b', 2020], ['Song a', 2000], ['Song c', null]])
  const empty = db.focusQuery({ query: query({ source: { provider: 'not-present' } }) })
  assert.equal(empty.total, 0); assert.deepEqual(empty.items, [])
})

test('Focus validates bounded AST, source comparisons, tokens and public write fields', () => {
  assert.equal(validMusicFocusQuery(query({ all: [] })), true)
  assert.equal(validMusicFocusQuery(query({ any: [] })), true)
  assert.equal(validMusicFocusQuery(query({ all: Array.from({ length: 64 }, () => ({ text: 'x' })) })), true)
  assert.equal(validMusicFocusQuery(query({ all: Array.from({ length: 65 }, () => ({ text: 'x' })) })), false)
  let deep: MusicFocusNode = { text: 'x' }; for (let i = 0; i < 8; i++) deep = { not: deep }
  assert.equal(validMusicFocusQuery(query(deep)), false)
  assert.equal(validMusicFocusPayload('focus.query', { query: query(), limit: 201 }), false)
  assert.equal(validMusicFocusPayload('focus.query', { query: query(), profileId: 'other' }), false)
  assert.equal(validMusicFocusPayload('focus.query', { query: query({ source: { bitDepth: { exists: false, gte: 24 } } }) }), false)
  assert.equal(validMusicFocusPayload('focus.play', { query: query(), token: {}, tracks: [] }), false)
  assert.equal(musicFocusQueryKey(query()), musicFocusQueryKey(query(undefined, { scope: 'library' })))
})

test('Focus NULL comparisons differ from complement and explicit missing personal/base/effective ratings', t => {
  const { db, rating } = fixture(t); rating('a', 8); rating('b', 6)
  const four = query({ rating: { target: 'self', mode: 'personal', gteStars: 4 } })
  const page = db.focusQuery({ query: four })
  assert.equal(page.total, 1); assert.equal(page.items[0].title, 'Song a'); assert.equal(validMusicFocusToken(page.token), true)
  assert.equal(db.focusQuery({ query: query({ not: four.where! }) }).total, 2)
  assert.equal(db.focusQuery({ query: query({ rating: { target: 'self', mode: 'personal', lteStars: 3 } }) }).total, 1)
  assert.equal(db.focusQuery({ query: query({ rating: { target: 'self', mode: 'personal', exists: false } }) }).total, 1)
  assert.equal(db.focusQuery({ query: query({ rating: { target: 'self', mode: 'base', provider: 'unused', gteStars: 0 } }) }).total, 0)
  assert.equal(db.focusQuery({ query: query({ rating: { target: 'self', mode: 'effective', exists: true } }) }).total, 2)
  const sorted = db.focusQuery({ query: query(undefined, { sort: [{ field: 'personalRating', direction: 'desc' }] }) })
  assert.deepEqual(sorted.items.map(v => v.title), ['Song a', 'Song b', 'Song c'])
})

test('same source leaf cannot combine local MP3 with streaming 24-bit; explicit leaves can match different sources', t => {
  const { db, source } = fixture(t, [track('a', { format: 'mp3', bitDepth: 16 })])
  stream(db, [track('ncm:42', { source: 'ncm', albumId: 'remote', format: 'flac', bitDepth: 24, filePath: '' })])
  confirm(db, [String(source('a').recording_id), String(source('ncm:42').recording_id)], 'recording')
  assert.equal(db.focusQuery({ query: query({ source: { provider: 'local', bitDepth: { gte: 24 } } }) }).total, 0)
  const both = query({ all: [{ source: { provider: 'local' } }, { source: { bitDepth: { gte: 24 } } }] })
  const found = db.focusQuery({ query: both }); assert.equal(found.total, 1); assert.equal(found.items[0].sourceCount, 2)
  const local = query({ all: [{ source: { provider: 'local' } }, { rating: { target: 'self', mode: 'personal', exists: false } }] })
  const localPage = db.focusQuery({ query: local })
  assert.equal(localPage.items[0].sourceCount, 1)
  assert.equal(db.focusPlaybackPage({ query: local, token: localPage.token }).items[0].provider, 'local')
  const high = query({ source: { bitDepth: { gte: 24 }, format: 'FLAC' } })
  assert.equal(db.focusPlaybackPage({ query: high }).items[0].provider, 'ncm')
  assert.equal(JSON.stringify(db.focusQuery({ query: high })).includes('D:/'), false)
  assert.equal(JSON.stringify(db.focusQuery({ query: high })).includes('trackId'), false)
})

test('Focus genre descendants and all-filter facets DISTINCT targets, album direct overrides from-tracks', t => {
  const { db, source, rating } = fixture(t, [track('a', { genre: 'Bebop' }), track('b', { genre: 'Jazz' }), track('c', { genre: 'Rock', album: 'Other' })])
  const jazz = String(db.genresTree({ search: 'Jazz' }).items.find(v => v.nameEn === 'Jazz')!.id)
  const q = query({ genre: { id: jazz, includeDescendants: true } }); const page = db.focusQuery({ query: q })
  assert.equal(page.total, 2)
  const facet = db.focusFacets({ query: q, token: page.token, facet: 'genre' })
  assert.equal(facet.items.find(v => v.value === jazz)!.count, 2)
  const album = db.focusQuery({ query: { ...q, entity: 'release' } }); assert.equal(album.total, 1)
  const collection = String(db.sql.prepare('SELECT album_key FROM tracks WHERE id=\'a\'').get()!.album_key)
  const rock = String(db.genresTree({ search: 'Rock' }).items.find(v => v.nameEn === 'Rock')!.id)
  db.genresOverride({ target: { kind: 'collection', id: collection }, revision: db.getGenresRevision(), genreIds: [rock] })
  assert.equal(db.focusQuery({ query: { ...q, entity: 'release' } }).total, 0, 'direct album genre replaces inference')
  rating('a', 8)
  const filtered = query({ all: [q.where!, { rating: { target: 'self', mode: 'personal', gteStars: 4 } }] })
  assert.equal(db.focusFacets({ query: filtered, facet: 'provider' }).items[0].count, 1)
  assert.ok(source('a'))
})

test('Focus cached catalog is separate from actual membership and cannot play unavailable catalog results', t => {
  const { db } = fixture(t, [track('a')])
  const sourceId = String(db.sql.prepare('SELECT id FROM catalog_sources').get()!.id)
  db.sql.prepare('DELETE FROM catalog_memberships WHERE source_id=?').run(sourceId)
  assert.equal(db.focusQuery({ query: query() }).total, 0)
  const q = query(undefined, { scope: 'catalog' }), cached = db.focusQuery({ query: q })
  assert.equal(cached.total, 1); assert.equal(cached.items[0].playable, false); assert.equal(cached.items[0].sourceId, null)
  assert.equal(db.focusPlaybackPage({ query: q, token: cached.token }).total, 0)
  db.sql.prepare("INSERT INTO catalog_memberships VALUES('local',?)").run(sourceId)
  db.sql.prepare("INSERT INTO catalog_pending VALUES('a')").run()
  assert.equal(db.focusQuery({ query: query() }).total, 0)
  assert.equal(db.focusPlaybackPage({ query: q }).total, 0)
})

test('Focus history uses exact source IDs and confirmed identity maximum, including no-record rows and frozen asOf', t => {
  const { db, source } = fixture(t)
  const now = Date.now()
  db.sql.prepare('INSERT INTO library_history VALUES(?,?)').run(JSON.stringify(['focus-source-v1', 'local', 'a']), now - 100 * 86400000)
  db.sql.prepare('INSERT INTO library_history VALUES(?,?)').run(JSON.stringify(['focus-source-v1', 'local', 'b']), now - 1 * 86400000)
  db.sql.prepare('INSERT INTO library_history VALUES(?,?)').run('unrelated-same-title', now)
  const q = query({ notPlayedWithinDays: 90 })
  const page = db.focusQuery({ query: q }); assert.equal(page.total, 2)
  assert.equal(db.focusQuery({ query: query({ lastPlayed: { exists: false } }) }).total, 1)
  confirm(db, [String(source('a').recording_id), String(source('b').recording_id)], 'recording')
  const confirmed = db.focusQuery({ query: query() }); assert.equal(confirmed.total, 2)
  assert.equal(confirmed.items.filter(v => v.lastPlayed === now - 86400000).length, 1)
  assert.equal(db.focusQuery({ query: q }).total, 1)
  const later = db.focusQuery({ query: q, token: db.focusQuery({ query: q }).token })
  assert.ok(later.token.asOf <= Date.now())
})

test('Focus history never borrows a different provider raw ID or a legacy ambiguous row', t => {
  const { db } = fixture(t, [])
  stream(db, [track('42', { source: 'foo', albumId: 'a', filePath: '' }), track('bar:42', { source: 'bar', albumId: 'b', filePath: '' })])
  db.sql.prepare('INSERT INTO library_history VALUES(?,?)').run('42', 9000)
  db.sql.prepare('INSERT INTO library_history VALUES(?,?)').run(JSON.stringify(['focus-source-v1', 'foo', '42']), 5000)
  const page = db.focusQuery({ query: query() })
  assert.equal(page.items.find(v => v.provider === 'foo')!.lastPlayed, 5000)
  assert.equal(page.items.find(v => v.provider === 'bar')!.lastPlayed, null)
  db.sql.prepare('INSERT INTO library_history VALUES(?,?)').run(JSON.stringify(['focus-source-v1', 'bar', '42']), 7000)
  assert.equal(db.focusQuery({ query: query() }).items.find(v => v.provider === 'bar')!.lastPlayed, 7000)
})

test('Focus tags expand albums dynamically without inferring album tags from tagged songs', t => {
  const { db, source } = fixture(t, [track('a'), track('b')])
  const albumTag = db.tagsCreate({ name: 'Album tag', tagsRevision: 0 }, 1).tag
  db.tagsMemberSet({ tagId: albumTag.id, entityId: String(source('a').release_id), present: true, membersRevision: 0 }, 2)
  assert.equal(db.focusQuery({ query: query({ tag: { id: albumTag.id } }) }).total, 2)
  assert.equal(db.focusQuery({ query: query({ tag: { id: albumTag.id } }, { entity: 'release' }) }).total, 1)
  const songTag = db.tagsCreate({ name: 'Song tag', tagsRevision: db.tagsState().tagsRevision }, 3).tag
  db.tagsMemberSet({ tagId: songTag.id, entityId: String(source('a').recording_id), present: true, membersRevision: 0 }, 4)
  assert.equal(db.focusQuery({ query: query({ tag: { id: songTag.id } }, { entity: 'release' }) }).total, 0)
  seed(db, [track('a'), track('b'), track('c')])
  assert.equal(db.focusQuery({ query: query({ tag: { id: albumTag.id } }) }).total, 3)
})

test('Focus automatic ban is source precise for recording, selected release and confirmed main artists', t => {
  const { db, source, preference } = fixture(t, [track('a'), track('b', { album: 'Other' }), track('c', { album: 'Third' })])
  preference('a', 'ban')
  const allowed = query({ automaticPlaybackBlocked: false }), banned = query({ automaticPlaybackBlocked: true })
  assert.equal(db.focusQuery({ query: allowed }).total, 2); assert.equal(db.focusQuery({ query: banned }).total, 1)
  preference('b', 'ban', 'release'); assert.equal(db.focusQuery({ query: allowed }).total, 1)
  const artist = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source('c').id))!.artist_id)
  db.sql.prepare("INSERT INTO metadata_entities VALUES('artist-identity','fixture','artist','artist','Artist')").run()
  db.sql.prepare("INSERT INTO metadata_identity_links VALUES('artist-link',?,'artist',1,'artist-identity','confirmed')").run(artist)
  db.preferencesSet({ entityId: artist, state: 'ban', token: db.preferencesDetail(artist).token }, 102)
  assert.equal(db.focusQuery({ query: allowed }).total, 0)
  assert.equal(db.focusPlaybackPage({ query: banned }).total, 3, 'explicit blocked Focus remains manually playable')
})

test('explicit local source and unblocked conditions cannot borrow eligibility from another release source', t => {
  const { db, source, preference } = fixture(t, [track('a')])
  stream(db, [track('ncm:42', { source: 'ncm', albumId: 'other-release', filePath: '' })])
  confirm(db, [String(source('a').recording_id), String(source('ncm:42').recording_id)], 'recording')
  preference('a', 'ban', 'release')
  const q = query({ all: [{ source: { provider: 'local' } }, { automaticPlaybackBlocked: false }] })
  assert.equal(db.focusQuery({ query: q }).total, 0)
  assert.equal(db.focusPlaybackPage({ query: q }).total, 0)
  const cloud = query({ all: [{ source: { provider: 'ncm' } }, { automaticPlaybackBlocked: false }] })
  assert.equal(db.focusPlaybackPage({ query: cloud }).items[0].provider, 'ncm')
  const nested = query({ all: [{ source: { provider: 'local' } }, { all: [{ source: { provider: 'ncm' } }, { automaticPlaybackBlocked: false }] }] })
  assert.equal(db.focusPlaybackPage({ query: nested }).items[0].provider, 'ncm', 'mandatory ban eligibility survives source unions')
})

test('Focus year filters use actual dates, and query/list/playback share stable sorting, counts and page token', t => {
  const { db } = fixture(t, [track('a', { releaseDate: '2001' }), track('b', { releaseDate: '2005-02-28' }), track('c', { releaseDate: '2005-02-30' })])
  const q = query({ year: { target: 'release', gte: 2000 } }, { sort: [{ field: 'releaseYear', direction: 'desc' }] })
  const first = db.focusQuery({ query: q, limit: 1 }), second = db.focusQuery({ query: q, token: first.token, limit: 1, offset: 1 })
  assert.equal(first.total, 2); assert.equal(second.total, 2); assert.equal(first.items[0].title, 'Song b'); assert.equal(second.items[0].title, 'Song a')
  const play = db.focusPlaybackPage({ query: q, token: first.token }); assert.equal(play.total, 2); assert.deepEqual(play.items.map(v => v.track.id), ['b', 'a'])
  assert.equal(db.focusQuery({ query: query({ year: { target: 'release', exists: false } }) }).total, 1)
})

test('Focus release playback respects disc and track sequence within the sorted release', t => {
  const { db } = fixture(t, [track('a', { discNumber: 2, trackNumber: 1 }), track('b', { discNumber: 1, trackNumber: 2 }), track('c', { discNumber: 1, trackNumber: 1 })])
  const q = query(undefined, { entity: 'release' }), page = db.focusQuery({ query: q })
  assert.equal(page.total, 1)
  assert.deepEqual(db.focusPlaybackPage({ query: q, token: page.token }).items.map(v => v.track.id), ['c', 'b', 'a'])
})

test('every playable release anchor selects its exact source in the final deduplicated queue when releases fully overlap', t => {
  const { db, source } = fixture(t, [track('a', { album: 'First' }), track('b', { album: 'Second' })])
  confirm(db, [String(source('a').recording_id), String(source('b').recording_id)], 'recording')
  for (const [id, at] of [['a', '10'], ['b', '20']]) db.sql.prepare("UPDATE catalog_state SET value=? WHERE key='membership_added:'||?").run(at, String(source(id).id))
  const q = query(undefined, { entity: 'release' }), page = db.focusQuery({ query: q }), play = db.focusPlaybackPage({ query: q, token: page.token })
  assert.equal(page.total, 2); assert.equal(play.total, 1)
  assert.equal(play.items[0].sourceId, source('a').id)
  for (const item of page.items) {
    assert.equal(item.playable, true)
    const anchored = db.focusPlaybackPage({ query: q, token: page.token, anchorSourceId: item.sourceId! })
    assert.equal(anchored.total, 1)
    assert.equal(anchored.items[0].sourceId, item.sourceId, `${item.title} must retain its exact clicked source`)
    assert.deepEqual(anchored.token, page.token)
    assert.equal(item.sourceCount, 1)
  }
  assert.equal(page.items.find(item => item.title === 'Second')!.sourceId, source('b').id)
})

test('partially overlapping release anchor overrides only its recording source across frozen playback pages', t => {
  const { db, source } = fixture(t, [track('a', { album: 'First', trackNumber: 1 }), track('b', { album: 'Second', trackNumber: 1 }), track('c', { album: 'Second', trackNumber: 2 })])
  confirm(db, [String(source('a').recording_id), String(source('b').recording_id)], 'recording')
  for (const [id, at] of [['a', '10'], ['b', '20'], ['c', '30']]) db.sql.prepare("UPDATE catalog_state SET value=? WHERE key='membership_added:'||?").run(at, String(source(id).id))
  const q = query(undefined, { entity: 'release' }), page = db.focusQuery({ query: q }), play = db.focusPlaybackPage({ query: q, token: page.token })
  assert.equal(page.total, 2); assert.equal(play.total, 2)
  const second = page.items.find(item => item.title === 'Second')!
  assert.equal(second.sourceCount, 2)
  assert.equal(second.sourceId, source('b').id)
  assert.deepEqual(play.items.map(item => item.track.id), ['a', 'c'])
  const anchoredFirst = db.focusPlaybackPage({ query: q, token: page.token, anchorSourceId: second.sourceId!, limit: 1 })
  const anchoredSecond = db.focusPlaybackPage({ query: q, token: page.token, anchorSourceId: second.sourceId!, limit: 1, offset: 1 })
  assert.equal(anchoredFirst.total, 2); assert.equal(anchoredSecond.total, 2)
  assert.deepEqual([...anchoredFirst.items, ...anchoredSecond.items].map(item => item.track.id), ['b', 'c'])
  assert.deepEqual(anchoredFirst.token, page.token)
  assert.deepEqual(anchoredSecond.token, page.token)
})

test('private playback anchors cannot widen matched source scope or enter public query DTOs', t => {
  const { db, source } = fixture(t, [track('a')])
  stream(db, [track('ncm:42', { source: 'ncm', albumId: 'other', filePath: '' })])
  confirm(db, [String(source('a').recording_id), String(source('ncm:42').recording_id)], 'recording')
  const q = query({ source: { provider: 'local' } }), page = db.focusQuery({ query: q }), anchor = String(source('ncm:42').id)
  const outside = db.focusPlaybackPage({ query: q, token: page.token, anchorSourceId: anchor })
  assert.equal(outside.items[0].provider, 'local')
  assert.equal(outside.items.some(item => item.sourceId === anchor), false)
  assert.equal(validMusicFocusPayload('focus.query', { query: q, anchorSourceId: anchor }), false)
  assert.equal(validMusicFocusPayload('focus.facets', { query: q, facet: 'provider', anchorSourceId: anchor }), false)
  assert.equal(validMusicFocusPlaybackPageQuery({ query: q, anchorSourceId: anchor }), true)
  for (const value of ['', 'x'.repeat(129), null, 1]) {
    assert.equal(validMusicFocusPlaybackPageQuery({ query: q, anchorSourceId: value }), false)
    assert.throws(() => db.focusPlaybackPage({ query: q, anchorSourceId: value as string }), { code: 'INVALID_PAYLOAD' })
  }
})

test('Focus source choice honors explicit preferred then actual membership time, never default local bias', t => {
  const { db, source } = fixture(t, [track('a')])
  stream(db, [track('ncm:42', { source: 'ncm', ncmSongId: 42, albumId: 'remote', filePath: '' })])
  confirm(db, [String(source('a').recording_id), String(source('ncm:42').recording_id)], 'recording')
  const sources = db.sql.prepare('SELECT * FROM catalog_sources').all()
  for (const s of sources) db.sql.prepare("UPDATE catalog_state SET value=? WHERE key='membership_added:'||?").run(s.provider === 'ncm' ? '10' : '20', String(s.id))
  assert.equal(db.focusPlaybackPage({ query: query() }).items[0].provider, 'ncm')
  const doc = emptyMusicVersions(); doc.tracks.versions = [{ id: 'manual', label: 'Version', sources: sources.map(s => String(s.source_key)), preferredSource: String(source('a').source_key) }]
  db.catalogProjectVersions(doc, 1)
  assert.equal(db.focusPlaybackPage({ query: query() }).items[0].provider, 'local')
  assert.equal(db.focusQuery({ query: query() }).items[0].sourceCount, 2)
})

test('Focus never merges recordings or release ratings through manual playback versions', t => {
  const { db, source, rating } = fixture(t, [track('a', { album: 'First' }), track('b', { album: 'Second' })])
  rating('a', 8); rating('b', 4)
  const doc = emptyMusicVersions(), sources = db.sql.prepare('SELECT * FROM catalog_sources ORDER BY track_id').all()
  doc.tracks.versions = [{ id: 'manual-song', label: 'Manual song', sources: sources.map(s => String(s.source_key)), preferredSource: null }]
  doc.albums.versions = [{ id: 'manual-album', label: 'Manual album', sources: sources.map(s => String(s.album_key)), preferredSource: null }]
  db.catalogProjectVersions(doc, 1)
  assert.equal(db.focusQuery({ query: query() }).total, 2)
  assert.equal(db.focusQuery({ query: query({ rating: { target: 'self', mode: 'personal', gteStars: 4 } }) }).total, 1)
  assert.equal(db.focusQuery({ query: query(undefined, { entity: 'release' }) }).total, 2)
  confirm(db, [String(source('a').release_id), String(source('b').release_id)], 'release', 'release-identity')
  const albums = db.focusQuery({ query: query(undefined, { entity: 'release' }) })
  assert.equal(albums.total, 1)
  assert.equal(db.focusPlaybackPage({ query: query(undefined, { entity: 'release' }), token: albums.token }).total, 2, 'album group expands physical recordings, not manual song navigation')
})

test('Focus classification metadata obeys current account, cross-source and usage restrictions', t => {
  const { db, source } = fixture(t, [track('a')])
  stream(db, [track('foo:42', { source: 'foo', albumId: 'other', filePath: '' })])
  confirm(db, [String(source('a').release_id), String(source('foo:42').release_id)], 'release', 'release-identity')
  const fact = { value: '2001', sourceProvider: 'foo', providerContext: 'account-one', usage: { display: true, cache: true, crossSource: false } }
  db.sql.prepare("INSERT INTO metadata_facts VALUES('release-identity','foo','releaseDate','und',?)").run(JSON.stringify(fact))
  const q = query({ year: { target: 'release', gte: 2000 } })
  assert.equal(db.focusQuery({ query: q }).total, 0)
  const context = { platformContexts: { foo: 'account-one' } }, page = db.focusQuery({ query: q }, context)
  assert.equal(page.total, 1); assert.equal(page.items[0].provider, 'foo')
  assert.equal(db.focusPlaybackPage({ query: q, token: page.token }, context).items[0].provider, 'foo')
  assert.throws(() => db.focusPlaybackPage({ query: q, token: page.token }, { platformContexts: { foo: 'account-two' } }), { code: 'STALE_REVISION' })
  db.sql.prepare("UPDATE metadata_facts SET payload=? WHERE target_id='release-identity'").run(JSON.stringify({ ...fact, usage: { display: true, cache: false, crossSource: true } }))
  assert.equal(db.focusQuery({ query: q }, context).total, 0)
})

test('Focus query token fences every durable dependency, query identity, scope, context and expiry', t => {
  const { db } = fixture(t, [track('a')]); let now = 1000
  const focus = new LibraryDatabaseFocus({ sql: db.sql, transaction: action => {
    db.sql.exec('BEGIN'); try { const r = action(); db.sql.exec('COMMIT'); return r } catch (e) { db.sql.exec('ROLLBACK'); throw e }
  }, contentRevision: () => db.getContentRevision(), metadataRevision: () => db.getClassificationMetadataRevision(), albumAliases: () => new Map(), resolve: (id, revision) => db.catalogResolve(id, revision), now: () => now })
  const q = query(), page = focus.query({ query: q })
  for (const key of ['savedRevision', 'catalogRevision', 'contentRevision', 'genresRevision', 'metadataRevision', 'ratingsRevision', 'preferencesRevision', 'tagsRevision', 'linkRevision', 'historyRevision'] as const) {
    assert.throws(() => focus.query({ query: q, token: { ...page.token, [key]: page.token[key] + 1 } }), { code: 'STALE_REVISION' })
  }
  assert.throws(() => focus.query({ query: query({ text: 'other' }), token: page.token }), { code: 'STALE_REVISION' })
  assert.throws(() => focus.query({ query: query(undefined, { scope: 'catalog' }), token: page.token }), { code: 'STALE_REVISION' })
  assert.throws(() => focus.query({ query: q, token: page.token }, { platformContexts: { ncm: 'account' } }), { code: 'STALE_REVISION' })
  const sourceId = String(db.sql.prepare('SELECT recording_id FROM catalog_sources').get()!.recording_id)
  confirm(db, [sourceId], 'recording')
  db.sql.prepare("INSERT INTO metadata_facts VALUES('identity','fixture','releaseDate','und',?)").run(JSON.stringify({ value: '2001', usage: { display: true, cache: true, expiresAt: 2000 } }))
  const expiring = focus.query({ query: q }); assert.equal(expiring.token.expiresAt, 2000)
  now = 2000; assert.throws(() => focus.query({ query: q, token: expiring.token }), { code: 'STALE_REVISION' })
})

test('saved Focus has independent normalized name/query CAS, persists offline/restart, delete checks both revisions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'te-focus-')), path = join(dir, 'library.sqlite'), db = new LibraryDatabase(path)
  const saved = db.focusSavedCreate({ name: ' Ｎｉｇｈｔ  Jazz ', query: query(), savedRevision: 0 }, 1)
  assert.equal(saved.item.name, 'Night Jazz')
  assert.throws(() => db.focusSavedCreate({ name: 'night jazz', query: query(), savedRevision: 1 }, 2), { code: 'FOCUS_NAME_CONFLICT' })
  const renamed = db.focusSavedRename({ id: saved.item.id, name: 'Late', nameRevision: 1 }, 3)
  const updated = db.focusSavedUpdate({ id: saved.item.id, query: query({ text: 'Jazz' }), queryRevision: 1 }, 4)
  assert.equal(updated.item.nameRevision, renamed.item.nameRevision); assert.equal(updated.item.queryRevision, 2)
  assert.throws(() => db.focusSavedDelete({ id: saved.item.id, nameRevision: 1, queryRevision: 2 }), { code: 'STALE_REVISION' })
  assert.equal(db.focusSavedUpdate({ id: saved.item.id, query: updated.item.query, queryRevision: 2 }, 5).savedRevision, updated.savedRevision)
  const state = db.focusState(); db.close()
  const reopened = new LibraryDatabase(path); t.after(() => { reopened.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.deepEqual(reopened.focusState(), state); assert.equal(reopened.focusSavedList({ search: 'LATE' }).items[0].query.where && 'text' in reopened.focusSavedList({}).items[0].query.where!, true)
  reopened.focusSavedDelete({ id: saved.item.id, nameRevision: updated.item.nameRevision, queryRevision: updated.item.queryRevision })
  assert.equal(reopened.focusSavedList({}).total, 0)
})
