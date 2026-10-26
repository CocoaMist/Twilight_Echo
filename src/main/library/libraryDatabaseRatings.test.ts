import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabaseRatings } from './libraryDatabaseRatings.ts'
import { LibraryDatabaseIdentification } from './libraryDatabaseIdentification.ts'
import { validMusicRatingsPayload } from '../../shared/musicRatings.ts'
import type { IdentificationCandidate, IdentificationProposal, IdentificationHistoryReview } from '../../shared/musicIdentification.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import type { PlatformAlbumIdentity } from '../../shared/musicPlatformAlbum.ts'

const mbid = '11111111-1111-4111-8111-111111111111'
function owners(db: LibraryDatabase) {
  const owner = { sql: db.sql, transaction<T>(action: () => T): T {
    db.sql.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.sql.exec('COMMIT'); return result }
    catch (error) { db.sql.exec('ROLLBACK'); throw error }
  } }
  return { ratings: new LibraryDatabaseRatings(owner), identity: new LibraryDatabaseIdentification(owner) }
}
function fixture(t: test.TestContext, file = ':memory:') {
  const db = new LibraryDatabase(file)
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [1, 2, 3].map(n => ({
    id: `track${n}`, source: 'local', filePath: `D:/private/${n}/one.flac`, title: 'One', artist: 'Same artist', album: `Album ${n}`,
    identityTags: { version: 1, scope: 'audio_file', musicbrainz: { recordingId: mbid, artistIds: [], albumArtistIds: [] } }
  })) })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const recordings = db.catalogQuery({ kind: 'recording' }).items.map(row => row.id)
  const releases = db.catalogQuery({ kind: 'release' }).items.map(row => row.id)
  const artists = db.catalogQuery({ kind: 'artist' }).items.map(row => row.id)
  const projects = db.catalogQuery({ kind: 'album_project' }).items.map(row => row.id)
  const { ratings, identity } = owners(db)
  const set = (entityId: string, steps: number | null, now = 100) => ratings.set({ entityId, token: ratings.detail(entityId).token, steps }, now)
  const proposal = (kind: CatalogKind, value: string, typed = false): IdentificationProposal => ({
    provider: typed ? 'musicbrainz' : 'ncm', name: 'Verified', summary: '', matcherVersion: 'fixture-v1',
    references: [{ provider: typed ? 'musicbrainz' : 'ncm', kind, idType: typed ? 'mbid' : 'native', value }],
    evidence: { origin: typed ? 'explicit_id' : 'search', matches: ['id'], missing: [], conflicts: [], incomplete: false,
      provenance: 'fixture' }
  })
  const publish = (entityId: string, value = 'same', typed = false) => {
    const input = identity.input(entityId), p = proposal(input.kind, value, typed)
    if (typed) p.evidence.verification = { method: 'typed_id', reference: p.references[0], sourceIds: input.sources!.map(s => s.sourceId) }
    return identity.publish(input, [p], 200)[0]
  }
  const review = (candidate: IdentificationCandidate) => ({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision })
  const confirm = (candidate: IdentificationCandidate) => identity.decide({ ...review(candidate), decision: 'confirm' }, 201)
  const historyReview = (entityId: string, seq: number): IdentificationHistoryReview => {
    const page = identity.history({ entityId })
    return { entityId, historySeq: seq, linkRevision: page.current.link!.revision, inputVersion: page.inputVersion }
  }
  return { db, ratings, identity, recordings, releases, artists, projects, set, publish, review, confirm, historyReview }
}

test('public ratings payloads accept only integer half-star steps and reject profile/target injection', () => {
  const token = { ratingsRevision: 0, linkRevision: 0, targetKey: 'opaque' }
  for (const steps of [1, 5, 10, null]) assert.equal(validMusicRatingsPayload('ratings.set', { entityId: 'one', token, steps }), true)
  for (const steps of [0, 11, -1, 1.5, '5', undefined, NaN]) assert.equal(validMusicRatingsPayload('ratings.set', { entityId: 'one', token, steps }), false)
  assert.equal(validMusicRatingsPayload('ratings.detail', { entityId: 'one', profileId: 'other' }), false)
  assert.equal(validMusicRatingsPayload('ratings.set', { entityId: 'one', token: { ...token, profileId: 'other' }, steps: 5 }), false)
  assert.equal(validMusicRatingsPayload('ratings.history', { entityId: 'one', limit: 101 }), false)
})

test('rating target Track context uses the catalog provider and exact bounded Track ID whitelist', () => {
  const query = { entityId: 'one', trackContext: { provider: 'example.provider-1', id: 'x'.repeat(8192) } }
  assert.equal(validMusicRatingsPayload('ratings.targets', query), true)
  for (const trackContext of [
    {}, { provider: 'local' }, { provider: 'local', id: '', extra: 'forged' },
    { provider: '', id: 'one' }, { provider: 'NCM', id: 'one' }, { provider: 'bad/provider', id: 'one' },
    { provider: 'x'.repeat(129), id: 'one' }, { provider: 'local', id: '' },
    { provider: 'local', id: 'x'.repeat(8193) }, { provider: 'local', id: 'one\0two' },
    { provider: 'local', id: 'one', kind: 'recording' }, { provider: 'local', id: 1 }
  ]) assert.equal(validMusicRatingsPayload('ratings.targets', { entityId: 'one', trackContext }), false)
  assert.equal(validMusicRatingsPayload('ratings.history', query), false, 'Track context is only a target-selection input')
})

test('half-stars, explicit clear tombstones, per-value revision and global stale fences persist in ordered history', t => {
  const { db, ratings, recordings: [id], set } = fixture(t)
  assert.equal(ratings.detail(id).value, null)
  const first = set(id, 7), staleToken = first.token
  assert.deepEqual(first.value, { steps: 7, revision: 1, updatedAt: 100 })
  const cleared = set(id, null, 101)
  assert.deepEqual(cleared.value, { steps: null, revision: 2, updatedAt: 101 })
  assert.ok(cleared.token.ratingsRevision > staleToken.ratingsRevision)
  assert.throws(() => ratings.set({ entityId: id, token: staleToken, steps: 9 }, 102), { code: 'STALE_REVISION' })
  assert.deepEqual(ratings.history({ entityId: id, limit: 1 }).items.map(v => [v.steps, v.reason]), [[null, 'clear']])
  assert.equal(ratings.history({ entityId: id, offset: 1, limit: 1 }).items[0].steps, 7)
  assert.equal(ratings.history({ entityId: id }).total, 2)
  const changes = db.sql.prepare('SELECT total_changes() n').get()!.n
  ratings.detail(id); ratings.history({ entityId: id })
  assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, changes, 'reads are side-effect free')
  assert.throws(() => db.sql.prepare("INSERT INTO personal_rating_values VALUES('default','bad','recording',1.5,1,1)").run(), /CHECK constraint/)
})

test('retained personal ratings remain editable after source membership removal and survive reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'te-ratings-'))
  const file = join(dir, 'library.sqlite')
  const db = new LibraryDatabase(file), { ratings } = owners(db)
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [{ id: 'track', source: 'local', filePath: 'D:/one.flac', title: 'One', artist: 'Artist', album: 'Album' }] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const id = db.catalogQuery({ kind: 'recording' }).items[0].id
  ratings.set({ entityId: id, token: ratings.detail(id).token, steps: 9 }, 300)
  db.sql.prepare('DELETE FROM catalog_memberships').run()
  db.sql.prepare("UPDATE catalog_sources SET availability='missing'").run()
  const old = ratings.detail(id)
  ratings.set({ entityId: id, token: old.token, steps: 8 }, 301)
  const revision = ratings.revision()
  db.close()
  const reopened = new LibraryDatabase(file)
  t.after(() => { reopened.close(); rmSync(dir, { recursive: true, force: true }) })
  const restored = owners(reopened).ratings
  assert.equal(restored.detail(id).value!.steps, 8)
  assert.equal(restored.revision(), revision)
  assert.equal(restored.history({ entityId: id }).total, 2)
})

test('recording and release ratings are independent; artist and album project are not substitutes', t => {
  const { ratings, recordings: [song, other], releases: [album], artists, projects, set } = fixture(t)
  set(song, 7); set(album, 10)
  assert.equal(ratings.detail(song).value!.steps, 7)
  assert.equal(ratings.detail(other).value, null, 'same tags and recording MBID alone do not share')
  assert.equal(ratings.detail(album).value!.steps, 10)
  for (const id of [...artists, ...projects]) assert.throws(() => ratings.detail(id), /只能为歌曲或具体专辑/)
})

test('manual playback versions only navigate to distinct physical rating targets and never merge their ratings', t => {
  const { db, ratings, identity, recordings, releases, set } = fixture(t)
  recordings.forEach((id, index) => set(id, index + 1))
  releases.forEach((id, index) => set(id, index + 5))
  const rows = db.sql.prepare('SELECT source_key,album_key FROM catalog_sources ORDER BY id LIMIT 2').all()
  const document = emptyMusicVersions()
  document.tracks.versions = [{ id: 'songs', label: 'Manual songs', sources: rows.map(r => String(r.source_key)), preferredSource: null }]
  document.albums.versions = [{ id: 'albums', label: 'Manual albums', sources: rows.map(r => String(r.album_key)), preferredSource: null }]
  db.catalogProjectVersions(document, 1)
  for (const kind of ['recording', 'release'] as const) {
    const manual = db.catalogQuery({ kind }).items.find(row => row.identity === 'manual')!
    assert.ok(manual)
    assert.throws(() => ratings.detail(manual.id), /播放版本仅用于导航/)
    const candidate = identity.publish(identity.input(manual.id), [{
      provider: 'ncm', name: 'Manual', summary: '', matcherVersion: 'v1', references: [{ provider: 'ncm', kind, idType: 'native', value: kind }],
      evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: true, provenance: 'fixture' }
    }], 300)[0]
    assert.equal(identity.preview({ candidateId: candidate.id, revision: 1, linkRevision: 0 }).ratingImpact, undefined)
    assert.throws(() => identity.decide({ candidateId: candidate.id, revision: 1, linkRevision: 0, decision: 'confirm',
      ratingResolution: { revision: ratings.revision(), choice: 'clear' } }, 301), /此身份不支持个人评分选择/)
    const page = ratings.targets({ entityId: manual.id, limit: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)
    const next = ratings.targets({ entityId: manual.id, offset: 1, limit: 1 })
    assert.notEqual(next.items[0].id, page.items[0].id)
    assert.equal(next.items[0].kind, kind)
    assert.notEqual(ratings.detail(next.items[0].id).value!.steps, ratings.detail(page.items[0].id).value!.steps)
    for (const item of [...page.items, ...next.items]) assert.equal(ratings.targets({ entityId: item.id }).items[0].id, item.id)
  }
  assert.equal(validMusicRatingsPayload('ratings.targets', { entityId: 'x', kind: 'release' }), false)
})

test('source rating targets require a real provider/Track match even for identical names and removed memberships', t => {
  const { db, ratings } = fixture(t)
  const rows = db.sql.prepare('SELECT track_id,recording_id,release_id FROM catalog_sources WHERE provider=\'local\' ORDER BY track_id').all()
  const one = rows[0], other = rows[1]
  for (const physical of ['recording_id', 'release_id'] as const) {
    const entityId = String(one[physical]), context = { provider: 'local', id: String(one.track_id) }
    assert.equal(ratings.targets({ entityId, trackContext: context }).items[0].id, entityId)
    assert.equal(ratings.targets({ entityId, trackContext: { ...context, id: String(other.track_id) } }).total, 0)
    assert.equal(ratings.targets({ entityId, trackContext: { ...context, provider: 'ncm' } }).total, 0)
    assert.equal(ratings.targets({ entityId, trackContext: { ...context, id: 'not-an-indexed-track' } }).total, 0)
    assert.equal(ratings.targets({ entityId }).total, 1)
  }
  db.sql.prepare('DELETE FROM catalog_memberships').run()
  db.sql.prepare("UPDATE catalog_sources SET availability='missing'").run()
  assert.equal(ratings.targets({ entityId: String(one.recording_id), trackContext: { provider: 'local', id: String(one.track_id) } }).total, 1)
})

test('opened local and streaming Tracks select different physical rating targets inside the same manual version', t => {
  const { db, ratings } = fixture(t)
  let batch = db.catalogSync({ kind: 'begin', revision: 1 })
  batch = db.catalogSync({ kind: 'append', ...batch, tracks: [{
    id: 'track1', source: 'ncm', filePath: '', fileName: '', title: 'One', artist: 'Same artist', album: 'Album 1',
    albumId: 'stream-album', duration: 200, size: 0, cover: null, lyrics: null
  }] })
  db.catalogSync({ kind: 'commit', ...batch })
  const rows = db.sql.prepare('SELECT source_key,provider,track_id,recording_id,release_id FROM catalog_sources').all()
  const local = rows.find(row => row.provider === 'local' && row.track_id === 'track1')!
  const stream = rows.find(row => row.provider === 'ncm' && row.track_id === 'track1')!
  const third = rows.find(row => row.provider === 'local' && row.track_id === 'track2')!
  const outside = rows.find(row => row.provider === 'local' && row.track_id === 'track3')!
  const document = emptyMusicVersions()
  document.tracks.versions = [{ id: 'same-song', label: 'Same title', sources: [local, stream, third].map(row => String(row.source_key)), preferredSource: String(stream.source_key) }]
  db.catalogProjectVersions(document, 2)
  const entityId = db.catalogQuery({ kind: 'recording' }).items.find(row => row.identity === 'manual')!.id
  assert.equal(ratings.targets({ entityId }).total, 3, 'legacy unfiltered query still lists every physical target')
  assert.equal(ratings.targets({ entityId, trackContext: { provider: 'local', id: 'track1' } }).items[0].id, local.recording_id)
  assert.equal(ratings.targets({ entityId, trackContext: { provider: 'ncm', id: 'track1' } }).items[0].id, stream.recording_id)
  assert.notEqual(local.recording_id, stream.recording_id, 'matching titles and Track IDs across providers never merge')
  assert.equal(ratings.targets({ entityId, trackContext: { provider: String(outside.provider), id: String(outside.track_id) } }).total, 0, 'real but unrelated indexed context cannot escape the original group')
  assert.equal(ratings.targets({ entityId: String(local.recording_id), trackContext: { provider: 'ncm', id: 'track1' } }).total, 0, 'physical source branch also rejects another group member')
  db.sql.prepare('DELETE FROM catalog_memberships').run()
  db.sql.prepare("UPDATE catalog_sources SET availability='missing'").run()
  assert.equal(ratings.targets({ entityId, trackContext: { provider: 'ncm', id: 'track1' } }).items[0].id, stream.recording_id)
})

test('late identity audit failure rolls carried rating, history and durable revision back with the link', t => {
  const { db, ratings, identity, recordings: [one], set, publish, confirm } = fixture(t)
  set(one, 7)
  const candidate = publish(one), before = ratings.revision()
  db.sql.exec("CREATE TRIGGER fail_rating_identity BEFORE INSERT ON metadata_identity_history WHEN new.state='confirmed' BEGIN SELECT RAISE(ABORT,'rating identity rollback'); END")
  assert.throws(() => confirm(candidate), /rating identity rollback/)
  assert.equal(identity.detail(one).link!.state, 'unresolved')
  assert.equal(ratings.detail(one).scope, 'entity')
  assert.equal(ratings.detail(one).value!.steps, 7)
  assert.equal(ratings.revision(), before)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM personal_rating_values').get()!.n, 1)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM personal_rating_history').get()!.n, 1)
  db.sql.exec('DROP TRIGGER fail_rating_identity')
  confirm(candidate)
  assert.equal(ratings.detail(one).scope, 'identity')
})

test('two database connections cannot silently overwrite a newer rating or newly shared identity', t => {
  const dir = mkdtempSync(join(tmpdir(), 'te-ratings-concurrent-')), file = join(dir, 'library.sqlite')
  const first = new LibraryDatabase(file)
  first.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [{ id: 'one', source: 'local', filePath: 'D:/one.flac', title: 'One', artist: 'Artist', album: 'Album' }] })
  while (first.catalogStatus().localPending) first.catalogAdvance()
  const second = new LibraryDatabase(file), a = owners(first), b = owners(second)
  t.after(() => { second.close(); first.close(); rmSync(dir, { recursive: true, force: true }) })
  const id = first.catalogQuery({ kind: 'recording' }).items[0].id, staleToken = a.ratings.detail(id).token
  b.ratings.set({ entityId: id, token: b.ratings.detail(id).token, steps: 8 }, 100)
  assert.throws(() => a.ratings.set({ entityId: id, token: staleToken, steps: 3 }, 101), { code: 'STALE_REVISION' })
  const beforeIdentity = a.ratings.detail(id).token
  const [c] = b.identity.publish(b.identity.input(id), [{ provider: 'ncm', name: 'One', summary: '', matcherVersion: 'v1',
    references: [{ provider: 'ncm', kind: 'recording', idType: 'native', value: 'ncm:one' }],
    evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' } }], 200)
  b.identity.decide({ candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision, decision: 'confirm' }, 201)
  assert.throws(() => a.ratings.set({ entityId: id, token: beforeIdentity, steps: 3 }, 202), { code: 'STALE_REVISION' })
  assert.equal(a.ratings.detail(id).scope, 'identity')
  assert.equal(a.ratings.detail(id).value!.steps, 8)
})

test('identity carry preserves original records, shared writes propagate, and detach restores the original local rating', t => {
  const { ratings, identity, recordings: [one, two], set, publish, confirm, review } = fixture(t)
  set(one, 7)
  const candidate = publish(one), preview = identity.preview(review(candidate))
  assert.equal(preview.ratingImpact!.action, 'carry')
  confirm(candidate)
  assert.equal(ratings.detail(one).scope, 'identity')
  assert.equal(ratings.history({ entityId: one }).items[0].reason, 'identity_carry')
  const second = publish(two)
  assert.equal(identity.preview(review(second)).ratingImpact!.action, 'share')
  confirm(second)
  set(two, 9)
  assert.equal(ratings.detail(one).value!.steps, 9)
  const beforeDetach = ratings.detail(one), link = identity.detail(one).link!
  identity.detach(link.id, link.revision, 400)
  assert.equal(ratings.detail(one).scope, 'entity')
  assert.equal(ratings.detail(one).value!.steps, 7)
  assert.equal(ratings.detail(two).value!.steps, 9)
  assert.throws(() => ratings.set({ entityId: one, token: beforeDetach.token, steps: 10 }, 401), { code: 'STALE_REVISION' })
})

test('different personal values require an explicit, globally revision-fenced choice, including cleared tombstones', t => {
  const { ratings, identity, recordings: [one, two, three], set, publish, confirm, review } = fixture(t)
  set(one, 9); confirm(publish(one)); set(two, 5)
  const c = publish(two), request = review(c), preview = identity.preview(request)
  assert.equal(preview.canConfirm, true)
  assert.equal(preview.ratingImpact!.conflict, true)
  assert.throws(() => confirm(c), { code: 'RATING_CONFLICT' })
  assert.equal(identity.detail(two).link!.state, 'unresolved')
  set(three, 2)
  assert.throws(() => identity.decide({ ...request, decision: 'confirm', ratingResolution: { revision: preview.ratingImpact!.revision, choice: 'current' } }, 500), { code: 'STALE_REVISION' })
  const next = identity.preview(request)
  identity.decide({ ...request, decision: 'confirm', ratingResolution: { revision: next.ratingImpact!.revision, choice: 'target' } }, 501)
  assert.equal(ratings.detail(two).value!.steps, 9)
  set(three, null)
  const clear = publish(three), clearPreview = identity.preview(review(clear))
  assert.equal(clearPreview.ratingImpact!.current!.steps, null)
  assert.equal(clearPreview.ratingImpact!.conflict, true)
  identity.decide({ ...review(clear), decision: 'confirm', ratingResolution: { revision: clearPreview.ratingImpact!.revision, choice: 'current' } }, 502)
  assert.equal(ratings.detail(one).value!.steps, null)
  assert.equal(ratings.detail(two).value!.steps, null)
})

test('equal values share without rewriting, while an explicit clear choice records an audited shared tombstone', t => {
  const { ratings, identity, recordings: [one, two, three], set, publish, confirm, review } = fixture(t)
  set(one, 8); confirm(publish(one)); set(two, 8)
  const same = publish(two), before = ratings.detail(one).value
  assert.equal(identity.preview(review(same)).ratingImpact!.conflict, false)
  confirm(same)
  assert.deepEqual(ratings.detail(two).value, before)
  set(three, 4)
  const c = publish(three), impact = identity.preview(review(c)).ratingImpact!
  identity.decide({ ...review(c), decision: 'confirm', ratingResolution: { revision: impact.revision, choice: 'clear' } }, 600)
  assert.equal(ratings.detail(one).value!.steps, null)
  assert.equal(ratings.history({ entityId: one }).items[0].reason, 'identity_clear')
})

test('automatic typed identity confirmation stops at a personal-rating conflict instead of bypassing manual review', t => {
  const { ratings, identity, recordings: [one, two], set, publish, confirm, review } = fixture(t)
  set(one, 10); confirm(publish(one, mbid, true)); set(two, 3)
  const candidate = publish(two, mbid, true), input = identity.input(two)
  assert.equal(identity.preview(review(candidate)).ratingImpact!.conflict, true)
  assert.equal(identity.confirmVerified(input, [candidate], true, 'musicbrainz', 700), false)
  assert.equal(identity.detail(two).link!.state, 'unresolved')
  assert.equal(ratings.detail(two).value!.steps, 3)
  const equalCandidate = publish(two, mbid, true)
  set(two, 10)
  assert.equal(identity.confirmVerified(identity.input(two), [equalCandidate], true, 'musicbrainz', 701), true)
  assert.equal(ratings.detail(two).scope, 'identity')
})

test('album-member automatic identification leaves a differently rated child for review while confirming its album', t => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { ratings, identity } = owners(db)
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: ['album', 'existing'].map((id, index) => ({
    id, source: 'local', filePath: `D:/music/${id}/song.flac`, title: 'Song', artist: 'Artist', album: index ? 'Other' : 'Album', duration: 200,
    identityTags: { version: 1, scope: 'audio_file',
      title: { value: 'Song', origin: 'audio_tag' }, artists: { value: ['Artist'], origin: 'audio_tag' },
      album: { value: index ? 'Other' : 'Album', origin: 'audio_tag' }, durationSeconds: { value: 200, origin: 'audio_tag' },
      discNumber: { value: 1, origin: 'audio_tag' }, discTotal: { value: 1, origin: 'audio_tag' },
      trackNumber: { value: 1, origin: 'audio_tag' }, trackTotal: { value: 1, origin: 'audio_tag' } }
  })) })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const rows = db.sql.prepare('SELECT track_id,recording_id,release_id FROM catalog_sources').all()
  const child = String(rows.find(r => r.track_id === 'album')!.recording_id), existing = String(rows.find(r => r.track_id === 'existing')!.recording_id)
  const albumId = String(rows.find(r => r.track_id === 'album')!.release_id)
  for (const [entityId, steps] of [[child, 3], [existing, 10]] as const) ratings.set({ entityId, token: ratings.detail(entityId).token, steps }, 100)
  const [target] = identity.publish(identity.input(existing), [{
    provider: 'ncm', name: 'Song', summary: '', matcherVersion: 'v1', references: [{ provider: 'ncm', kind: 'recording', idType: 'native', value: 'ncm:song-id' }],
    evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }
  }], 200)
  identity.decide({ candidateId: target.id, revision: target.revision, linkRevision: target.linkRevision, decision: 'confirm' }, 201)
  const input = identity.input(albumId), snapshot = identity.albumMemberSnapshot(input)
  const album: PlatformAlbumIdentity = { schemaVersion: 1, provider: 'ncm', id: 'album-id', title: 'Album', artists: [{ name: 'Artist', id: 'artist-id' }],
    complete: true, trackCount: 1, tracks: [{ id: 'song-id', title: 'Song', artists: [{ name: 'Artist', id: 'artist-id' }], durationSeconds: 200, disc: 1, position: 1, isrcs: [] }] }
  const reference = { provider: 'ncm', kind: 'release' as const, idType: 'native', value: 'album-id' }
  const candidates = identity.publish(input, [{ provider: 'ncm', name: 'Album', summary: '', matcherVersion: 'v1', references: [reference], evidence: {
    origin: 'album_tracks', matches: ['complete'], missing: [], conflicts: [], incomplete: false, provenance: 'fixture',
    verification: { method: 'platform_album_tracks', reference, sourceIds: input.sources!.map(s => s.sourceId), album, matchedAlbumIds: ['album-id'], toleranceSeconds: 2 }
  } }], 300)
  assert.equal(identity.confirmVerified(input, candidates, true, 'platform.ncm', 301), true)
  const members = identity.confirmAlbumMembers(input, candidates, snapshot, 301)!
  assert.equal(members.find(m => m.entityId === child)!.state, 'needs_review')
  assert.equal(identity.detail(child).link!.state, 'unresolved')
  assert.equal(ratings.detail(child).value!.steps, 3)
  assert.equal(ratings.detail(existing).value!.steps, 10)
  const candidate = identity.candidates({ entityId: child }).items[0]
  const preview = identity.preview({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision })
  assert.equal(preview.canConfirm, true)
  assert.equal(preview.ratingImpact!.conflict, true)
})

test('historical restore uses the same rating conflict and revision rules and leaves all identity writes atomic', t => {
  const { db, ratings, identity, recordings: [one, two], set, publish, confirm, historyReview } = fixture(t)
  set(one, 7); confirm(publish(one, 'first'))
  const receipt = identity.history({ entityId: one }).items[0]
  const link = identity.detail(one).link!
  identity.detach(link.id, link.revision, 800)
  set(one, 2)
  confirm(publish(two, 'first'))
  set(two, 10)
  const request = historyReview(one, receipt.seq), preview = identity.restorePreview(request)
  assert.equal(preview.canRestore, true)
  assert.equal(preview.ratingImpact!.conflict, true)
  const links = db.sql.prepare('SELECT * FROM metadata_identity_links').all(), events = identity.history({ entityId: one }).total
  assert.throws(() => identity.restore(request, 801), { code: 'RATING_CONFLICT' })
  assert.deepEqual(db.sql.prepare('SELECT * FROM metadata_identity_links').all(), links)
  assert.equal(identity.history({ entityId: one }).total, events)
  set(two, 9)
  assert.throws(() => identity.restore({ ...request, ratingResolution: { revision: preview.ratingImpact!.revision, choice: 'current' } }, 802), { code: 'STALE_REVISION' })
  const fresh = identity.restorePreview(request)
  identity.restore({ ...request, ratingResolution: { revision: fresh.ratingImpact!.revision, choice: 'current' } }, 803)
  assert.equal(ratings.detail(one).value!.steps, 2)
  assert.equal(ratings.detail(two).value!.steps, 2)
  const restored = identity.history({ entityId: one }).items[0]
  assert.equal(restored.restoredFrom, receipt.seq)
})
