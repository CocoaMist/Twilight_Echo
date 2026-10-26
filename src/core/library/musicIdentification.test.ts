import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_IDENTIFICATION_SCHEMA_SQL, LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import { collectTrackIdentityTags } from '../../main/library/trackIdentityTags.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import type {
  IdentificationCandidate,
  IdentificationProposal,
  MusicExternalReference
} from '../../shared/musicIdentification.ts'
import { isCoreRequest, coreOperation } from '../../shared/coreProtocol.ts'

const MBID = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
const ref = (
  value: string,
  provider = 'ncm',
  kind: MusicExternalReference['kind'] = 'artist'
): MusicExternalReference => ({
  provider,
  kind,
  idType: provider === 'musicbrainz' ? 'mbid' : 'native',
  value
})
const proposal = (...references: MusicExternalReference[]): IdentificationProposal => ({
  provider: references[0].provider,
  name: 'Artist',
  summary: 'A verifiable provider identity',
  references,
  matcherVersion: 'fixture-v1',
  evidence: {
    origin: 'search',
    matches: ['name'],
    missing: ['cross_reference'],
    conflicts: [],
    incomplete: true,
    provenance: 'fixture:provider-response'
  }
})
const review = (c: IdentificationCandidate) => ({
  candidateId: c.id,
  revision: c.revision,
  linkRevision: c.linkRevision
})
function publish(db: LibraryDatabase, id: string, ...proposals: IdentificationProposal[]) {
  return db.identificationPublish(db.identificationInput(id), proposals, 1000)
}
function confirm(db: LibraryDatabase, c: IdentificationCandidate) {
  return db.identificationDecide({ ...review(c), decision: 'confirm' }, 1001)
}
function seed(db: LibraryDatabase) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/music/one.flac',
        title: 'One',
        artist: 'Artist',
        album: 'Album'
      },
      {
        id: 'two',
        source: 'local',
        filePath: 'D:/music/two.flac',
        title: 'Two',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  let batch = db.catalogSync({ kind: 'begin', revision: 1 })
  batch = db.catalogSync({
    kind: 'append',
    ...batch,
    tracks: [
      {
        id: 'ncm:7',
        source: 'ncm',
        filePath: '',
        fileName: '',
        duration: 200,
        size: 0,
        cover: null,
        lyrics: null,
        title: 'One',
        artist: 'Artist',
        artists: [{ id: 42, name: 'Artist' }],
        album: 'Album',
        albumId: '42'
      }
    ]
  })
  db.catalogSync({ kind: 'commit', ...batch })
  return {
    local: db.catalogQuery({ kind: 'artist', source: 'local' }).items.map((e) => e.id),
    online: db.catalogQuery({ kind: 'artist', source: 'ncm' }).items[0].id
  }
}

test('the metadata inbox groups saved candidates by independent live entities with bounded SQL pagination and filters', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local: [a, b], online } = seed(db)
  publish(db, a, proposal(ref('one')), proposal(ref('two')))
  publish(db, b, proposal(ref('three')))
  publish(db, online, proposal(ref('four')))
  const before = db.getContentRevision(), jobs = db.metadataJobs({}).total
  const first = db.identificationInbox({ kind: 'artist', limit: 1 })
  const second = db.identificationInbox({ kind: 'artist', offset: 1, limit: 2 })
  assert.equal(first.total, 3)
  assert.equal(second.total, 3)
  const items = [...first.items, ...second.items]
  assert.equal(new Set(items.map(item => item.entity.id)).size, 3)
  assert.equal(items.find(item => item.entity.id === a)!.candidateCount, 2)
  assert.equal(items.find(item => item.entity.id === a)!.sample!.provider, 'local')
  assert.equal(items.find(item => item.entity.id === online)!.sample!.provider, 'ncm')
  assert.ok(items.every(item => !('filePath' in item.entity)))
  assert.equal(db.identificationInbox({ kind: 'recording' }).total, 0)
  const candidate = db.identificationCandidates({ entityId: a }).items[0]
  db.identificationDecide({ ...review(candidate), decision: 'reject' }, 2000)
  assert.equal(db.identificationInbox({ state: 'rejected' }).items[0].entity.id, a)
  assert.equal(db.identificationInbox({}).items.find(item => item.entity.id === a)!.candidateCount, 1)
  assert.equal(db.getContentRevision(), before)
  assert.equal(db.metadataJobs({}).total, jobs, 'opening the inbox never creates recognition work')
  db.sql.prepare('DELETE FROM catalog_memberships WHERE source_id IN (SELECT source_id FROM catalog_entity_sources WHERE entity_id=?)').run(online)
  assert.equal(db.identificationInbox({}).total, 2, 'search-only source snapshots are not library review items')
  const source = db.sql.prepare("SELECT s.track_id FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id WHERE b.entity_id=? AND s.provider='local' LIMIT 1").get(a)!
  db.sql.prepare('INSERT INTO catalog_pending(track_id) VALUES(?)').run(source.track_id)
  assert.equal(db.identificationInbox({}).items.some(item => item.entity.id === a), false)
  assert.equal(db.identificationInbox({}).items.some(item => item.entity.id === b), true)
})

test('compact decisions exclude confirmed and detached identities before SQL count and pagination', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local: [a, b], online } = seed(db)
  const [chosen] = publish(db, a, proposal(ref('one')), proposal(ref('two')))
  publish(db, b, proposal(ref('three')))
  publish(db, online, proposal(ref('four')))
  const initial = db.identificationInbox({ unresolvedOnly: true })
  assert.equal(initial.total, 3, 'same-name sources are independent decisions')
  assert.equal(initial.items.find(item => item.entity.id === a)!.candidateCount, 2)
  const detail = confirm(db, chosen)
  for (const offset of [0, 1]) {
    const pending = db.identificationInbox({ unresolvedOnly: true, limit: 1, offset })
    assert.equal(pending.total, 2)
    assert.equal(pending.items.length, 1)
    assert.notEqual(pending.items[0].entity.id, a)
  }
  assert.ok(db.identificationInbox({}).items.some(item => item.entity.id === a), 'advanced view retains alternative candidates')
  db.identificationDetach(detail.link!.id, detail.link!.revision, 2000)
  assert.equal(db.identificationInbox({ unresolvedOnly: true }).total, 2, 'explicit detachment does not reappear as a chore')
  assert.ok(db.identificationInbox({}).items.some(item => item.entity.id === a), 'advanced view retains detached candidates for deliberate re-identification')
})

test('inbox requests accept only bounded typed filters and remain library-read operations', (t) => {
  const request = (payload: unknown) => ({ kind: 'query', epoch: 'test', requestId: 'inbox', name: 'identification.inbox', payload })
  assert.equal(isCoreRequest(request({ kind: 'artist', limit: 100 })), true)
  assert.equal(isCoreRequest(request({ unresolvedOnly: true })), true)
  assert.equal(isCoreRequest(request({ unresolvedOnly: false })), true)
  for (const payload of [{ unresolvedOnly: 'true' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { kind: 'work' }, { state: 'anything' }, { entityId: 'arbitrary' }, { sql: 'SELECT *' }])
    assert.equal(isCoreRequest(request(payload)), false)
  assert.equal(coreOperation('identification.inbox')?.permission, 'library:read')
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  assert.throws(() => db.identificationInbox({ limit: 101 }), /无效/)
})

test('provider identities need no MBID; kind, namespace and ID type remain independent, and names never merge sources', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const {
      local: [a, b],
      online
    } = seed(db),
    revision = db.getContentRevision()
  assert.notEqual(a, b)
  const first = confirm(db, publish(db, online, proposal(ref('42')))[0])
  assert.ok(first.link!.targetId)
  assert.deepEqual(first.references, [ref('42')])
  assert.equal(
    db.identificationDetail(a).link,
    null,
    'native platform identity proves nothing about the same local name'
  )
  const local = confirm(db, publish(db, a, proposal(ref('42')))[0])
  assert.equal(local.link!.targetId, first.link!.targetId)
  const other = confirm(db, publish(db, b, proposal(ref('42', 'other')))[0])
  assert.notEqual(other.link!.targetId, first.link!.targetId)
  const renamedType = { ...ref('42'), idType: 'legacy' }
  assert.notEqual(
    confirm(db, publish(db, b, proposal(renamedType))[0]).link!.targetId,
    first.link!.targetId
  )
  assert.throws(
    () =>
      db.metadataEnqueue(
        { entityId: online, type: 'enrich', language: 'en', batchId: 'test' },
        2000
      ),
    /尚未关联 MusicBrainz/
  )
  assert.equal(db.getContentRevision(), revision)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM metadata_identity_refs').get()!.n, 3)
})

test('multi-candidate decisions and stable IDs survive reopen; rejecting another candidate never removes the chosen identity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identification-candidates-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const {
    local: [a]
  } = seed(db)
  const initial = publish(db, a, proposal(ref('42')), proposal(ref('99')))
  assert.equal(initial.length, 2)
  assert.deepEqual(publish(db, a, proposal(ref('42')), proposal(ref('99'))), initial)
  assert.equal(db.identificationCandidates({ entityId: a, limit: 1 }).total, 2)
  const target = confirm(db, initial[0]).link!.targetId
  const [rejected] = publish(db, a, proposal(ref('99')))
  db.identificationDecide({ ...review(rejected), decision: 'reject' }, 1002)
  assert.equal(db.identificationDetail(a).link!.targetId, target)
  db.close()
  db = new LibraryDatabase(path)
  db.sql.prepare('UPDATE catalog_entities SET title=? WHERE id=?').run('Renamed Artist', a)
  const changed = { ...proposal(ref('99')), provider: 'new-adapter', matcherVersion: 'fixture-v2' }
  const [again] = publish(db, a, changed)
  assert.equal(again.state, 'rejected')
  assert.equal(again.suppressed, true)
  const adopted = confirm(db, again)
  assert.notEqual(
    adopted.link!.targetId,
    target,
    'explicit human confirmation may re-adopt a previously rejected reference'
  )
  assert.equal(
    db.sql
      .prepare("SELECT count(*) AS n FROM metadata_identity_suppressions WHERE value='99'")
      .get()!.n,
    0
  )
})

test('album projects, recordings and releases have separate catalog entities and separately confirmed identities', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  const project = db.catalogQuery({ kind: 'album_project', source: 'ncm' }).items[0]
  const release = db.catalogQuery({ kind: 'release', source: 'ncm' }).items[0]
  const recording = db.catalogQuery({ kind: 'recording', source: 'ncm' }).items[0]
  assert.notEqual(project.id, release.id)
  const before = db.catalogSources({ entityId: release.id })
  const identified = confirm(
    db,
    publish(db, project.id, proposal(ref('42', 'ncm', 'album_project')))[0]
  )
  assert.equal(identified.kind, 'album_project')
  assert.equal(
    db.identificationDetail(release.id).link,
    null,
    'project recognition does not identify a pressing'
  )
  assert.equal(db.identificationDetail(recording.id).link, null)
  assert.throws(
    () => publish(db, release.id, proposal(ref('42', 'ncm', 'album_project'))),
    /无效的识别候选/
  )
  const pressing = confirm(db, publish(db, release.id, proposal(ref('42', 'ncm', 'release')))[0])
  assert.notEqual(identified.link!.targetId, pressing.link!.targetId)
  assert.deepEqual(
    db.catalogSources({ entityId: release.id }),
    before,
    'identity is never playback version permission'
  )
  assert.equal(
    db.catalogDetail(project.id).facts.some((f) => f.field === 'album' && f.value === 'Album'),
    true
  )
})

test('conflict preview prevents swallowing existing targets; a verified new reference can extend one target without losing overrides', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const {
    local: [a, b],
    online
  } = seed(db)
  const first = confirm(db, publish(db, a, proposal(ref('42')))[0])
  confirm(db, publish(db, b, proposal(ref(MBID, 'musicbrainz')))[0])
  const [conflict] = publish(db, online, proposal(ref('42'), ref(MBID, 'musicbrainz')))
  assert.deepEqual(db.identificationPreview(review(conflict)).conflicts, [
    'external_references_belong_to_different_targets'
  ])
  assert.throws(() => confirm(db, conflict), /不同身份/)
  assert.equal(db.identificationDetail(online).link!.state, 'unresolved')
  const detail = db.metadataDetail(a, 'en')
  db.metadataOverride(
    { entityId: a, revision: detail.revision, mode: 'value', value: 'My notes', language: 'en' },
    2000
  )
  const before = db.identificationInput(a)
  const extended = confirm(
    db,
    publish(db, a, proposal(ref('42'), ref('platform-alias', 'other')))[0]
  )
  assert.equal(extended.link!.targetId, first.link!.targetId)
  assert.equal(extended.references.length, 2)
  assert.equal(db.metadataDetail(a, 'en').introduction!.value, 'My notes')
  assert.ok(db.identificationInput(a).linkRevision > before.linkRevision)
  confirm(db, publish(db, a, proposal(ref('replacement', 'other')))[0])
  assert.equal(db.metadataDetail(a, 'en').introduction!.value, 'My notes')
  assert.equal(db.metadataDetail(b, 'en').override, null)
})

test('a target cannot silently acquire two different IDs in the same namespace', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const {
    local: [a]
  } = seed(db)
  const first = confirm(db, publish(db, a, proposal(ref('42'), ref(MBID, 'musicbrainz')))[0])
  const [candidate] = publish(
    db,
    a,
    proposal(ref('42'), ref('c8b031a2-8f55-4e9e-8057-561a3b9c4f38', 'musicbrainz'))
  )
  assert.deepEqual(db.identificationPreview(review(candidate)).conflicts, [
    'conflicting_ids_in_same_namespace'
  ])
  assert.throws(() => confirm(db, candidate), /不同身份/)
  assert.deepEqual(db.identificationDetail(a), first)
})

test('candidate/link/input fences are independent of manual text and unrelated catalog changes; detached identities stay suppressed', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const {
    local: [a, b]
  } = seed(db)
  let [candidate] = publish(db, a, proposal(ref('42')))
  db.metadataOverride({ entityId: a, revision: 0, mode: 'clear', language: 'en' }, 1002)
  db.sql.prepare('UPDATE catalog_entities SET title=? WHERE id=?').run('Unrelated', b)
  assert.equal(db.identificationPreview(review(candidate)).stale, false)
  const first = confirm(db, candidate)
  assert.throws(() => confirm(db, candidate), /变化/)
  db.identificationDetach(first.link!.id, first.link!.revision, 1003)
  assert.equal(db.identificationCandidates({ entityId: a }).items[0].suppressed, true)
  assert.equal(db.metadataDetail(a, 'en').override!.mode, 'clear')
  ;[candidate] = publish(db, a, proposal(ref('42')))
  assert.equal(candidate.suppressed, true)
  db.sql.prepare('UPDATE catalog_entities SET title=? WHERE id=?').run('Changed input', a)
  assert.equal(db.identificationPreview(review(candidate)).stale, true)
  assert.throws(() => confirm(db, candidate), /变化/)
  const old = db.identificationInput(a)
  db.sql.prepare('UPDATE catalog_entities SET title=? WHERE id=?').run('Changed again', a)
  db.sql.prepare('UPDATE catalog_entities SET title=? WHERE id=?').run(old.name, a)
  assert.throws(() => db.identificationPublish(old, [proposal(ref('new'))], 2000), /变化/)
  ;[candidate] = publish(db, a, proposal(ref('new')))
  db.sql
    .prepare(
      "UPDATE catalog_sources SET availability='missing' WHERE id IN (SELECT source_id FROM catalog_source_artists WHERE artist_id=?)"
    )
    .run(a)
  assert.equal(db.identificationPreview(review(candidate)).canConfirm, false)
})

test('invalid candidate batches roll back atomically and case-normalized MBIDs share their identity', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const {
    local: [a, b]
  } = seed(db)
  assert.throws(
    () => publish(db, a, proposal(ref('42')), proposal(ref('not-an-mbid', 'musicbrainz'))),
    /无效/
  )
  assert.equal(db.identificationCandidates({ entityId: a }).total, 0)
  assert.equal(db.identificationDetail(a).link, null)
  const one = confirm(db, publish(db, a, proposal(ref(MBID.toUpperCase(), 'musicbrainz')))[0])
  const two = confirm(db, publish(db, b, proposal(ref(MBID, 'musicbrainz')))[0])
  assert.equal(one.link!.targetId, two.link!.targetId)
  assert.deepEqual(one.references, [ref(MBID, 'musicbrainz')])
})

test('raw tag IDs, credits and fractional durations reach each layer; changed IDs invalidate candidates even after ABA', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local } = seed(db)
  const artist = local.find((id) => db.identificationInput(id).sources!.some((s) => s.trackId === 'one'))!
  const patch = (value: Record<string, unknown>) => {
    const page = db.getTracksByIds(['one'])
    db.patchTracks([{ id: 'one', expectedVersion: page.versions!.one, patch: value }])
    while (db.catalogStatus().localPending) db.catalogAdvance()
  }
  const tags = collectTrackIdentityTags({ artist: 'Artist', albumartist: 'Various Artists',
    musicbrainz_artistid: [MBID], musicbrainz_albumartistid: ['89ad4ac3-39f7-470e-963a-56509c546377'],
    musicbrainz_recordingid: 'c8b031a2-8f55-4e9e-8057-561a3b9c4f38'
  }, 201.123456, { title: 'One', artist: 'Artist' })
  patch({ identityTags: tags })
  const input = db.identificationInput(artist)
  assert.deepEqual(input.sources![0].tags, tags)
  assert.deepEqual(input.sources![0].artistIndexes, [0])
  const layers = ['recording', 'release', 'album_project'] as const
  for (const kind of layers) {
    const id = db.catalogQuery({ kind, source: 'local' }).items[0].id
    assert.ok(db.identificationInput(id).sources!.some((s) => s.tags.durationSeconds?.value === 201.123456))
  }
  const [candidate] = publish(db, artist, proposal(ref('fixture')))
  patch({ identityTags: { ...tags, musicbrainz: { ...tags.musicbrainz, artistIds: ['different'] } } })
  assert.equal(db.identificationPreview(review(candidate)).stale, true)
  patch({ identityTags: tags })
  assert.notEqual(db.identificationInput(artist).version, input.version)
  assert.throws(() => db.identificationPublish(input, [proposal(ref('late'))], 2000), /变化/)
  const after = db.identificationInput(artist)
  patch({ cover: 'cover://new.png', lyrics: 'New lyrics', addedAt: 5000 })
  assert.equal(db.identificationInput(artist).version, after.version, 'display enrichment is not an identity change')
  patch({ identityTags: tags })
  assert.equal(db.identificationInput(artist).version, after.version, 'repeated scans cannot churn unchanged credits')
  patch({ discNumber: 2, trackNumber: 3 })
  assert.notEqual(db.identificationInput(artist).version, after.version)
})

test('native artist credit positions are established by source aliases, not ambiguous display names', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { online, local: [local] } = seed(db)
  const input = db.identificationInput(online)
  assert.equal(input.sources![0].provider, 'ncm')
  assert.deepEqual(input.sources![0].artists, [{ id: 42, name: 'Artist' }])
  assert.deepEqual(input.sources![0].artistIndexes, [0])
  assert.equal(input.sources![0].tags.artist!.origin, 'legacy')
  assert.equal(db.identificationInput(local).sources![0].tags.artist!.origin, 'legacy')
  let batch = db.catalogSync({ kind: 'begin', revision: 2 })
  batch = db.catalogSync({ kind: 'append', ...batch, tracks: [{
    id: 'ncm:7', source: 'ncm', filePath: '', fileName: '', title: 'One', artist: 'Artist', album: 'Album',
    albumId: '42', artists: [{ id: 42, name: 'Artist' }, { id: 43, name: 'Artist' }],
    duration: 200, size: 0, cover: null, lyrics: null
  }] })
  db.catalogSync({ kind: 'commit', ...batch })
  const other = db.catalogQuery({ kind: 'artist', source: 'ncm' }).items.find((item) => item.id !== online)!
  assert.deepEqual(db.identificationInput(online).sources![0].artistIndexes, [0])
  assert.deepEqual(db.identificationInput(other.id).sources![0].artistIndexes, [1])
})

test('v14 upgrades install source fences without replacing candidates, facts or source IDs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-source-fence-'))
  const path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const { local: [artist] } = seed(db)
  const [candidate] = publish(db, artist, proposal(ref('42')))
  const input = db.identificationInput(artist)
  db.sql.exec(LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL + 'PRAGMA user_version=14;')
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  assert.equal(db.identificationCandidates({ entityId: artist }).items[0].id, candidate.id)
  assert.equal(db.identificationInput(artist).version, input.version)
  db.sql.prepare("UPDATE catalog_sources SET payload=json_set(payload,'$.isrc','new-isrc') WHERE id=?")
    .run(input.sources![0].sourceId)
  assert.equal(db.identificationPreview(review(candidate)).stale, true)
  const backupFile = readdirSync(root).find((f) => f.includes('.v14-backup-'))!
  const backup = new DatabaseSync(join(root, backupFile))
  assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 14)
  assert.equal(backup.prepare('SELECT count(*) AS n FROM metadata_identity_candidates').get()!.n, 1)
  backup.close()
})

const earlyV14Schema = LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL + `
  DROP TRIGGER metadata_identification_input_changed;
  DROP TABLE metadata_identification_inputs;
  DROP INDEX metadata_link_history_identity;
  PRAGMA user_version=14;
`

test('early v14 profiles without the additive input fence upgrade with a backup and preserve library, queue and identity data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-early-v14-'))
  const path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const { local: [artist, other] } = seed(db)
  const confirmed = confirm(db, publish(db, artist, proposal(ref('42')))[0])
  db.metadataOverride({ entityId: artist, revision: db.metadataDetail(artist, 'en').revision,
    mode: 'value', value: 'Keep my introduction', language: 'en' }, 2000)
  const [candidate] = publish(db, other, proposal(ref('43')))
  // This variant captured candidate evidence before input revisions existed.
  db.sql.prepare("UPDATE metadata_identity_candidates SET payload=json_set(payload,'$.inputVersion',?) WHERE id=?")
    .run('early-v14-input', candidate.id)
  const savedCandidate = db.identificationCandidates({ entityId: other }).items[0]
  const queue = db.createLibraryQueue({ sort: 'insertion' }, 'one')
  const queuePage = db.readLibraryQueue(queue.id)
  const tracks = db.getTracksByIds(['one', 'two'])
  const revision = db.getContentRevision()
  db.sql.exec(earlyV14Schema)
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  assert.equal(db.getContentRevision(), revision)
  assert.deepEqual(db.getTracksByIds(['one', 'two']), tracks)
  assert.deepEqual(db.readLibraryQueue(queue.id), queuePage)
  assert.deepEqual(db.identificationDetail(artist), confirmed)
  assert.equal(db.metadataDetail(artist, 'en').introduction!.value, 'Keep my introduction')
  assert.deepEqual(db.identificationCandidates({ entityId: other }).items[0], savedCandidate)
  assert.equal(db.identificationPreview(review(savedCandidate)).stale, true)
  const before = db.identificationInput(artist)
  db.sql.prepare("UPDATE catalog_entities SET title=title||' edited' WHERE id=?").run(artist)
  assert.notEqual(db.identificationInput(artist).version, before.version)
  const backupPath = join(root, readdirSync(root).find(f => f.includes('.v14-backup-'))!)
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 14)
  assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='metadata_identification_inputs'").get(), undefined)
  assert.equal(backup.prepare('SELECT count(*) AS n FROM queue_entries').get()!.n, queue.total)
  backup.close()
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.getMetadata().trackCount, 2)
  assert.equal(readdirSync(root).filter(f => f.includes('.v14-backup-')).length, 1)
})

test('early v14 input-fence migration rolls back atomically if later DDL fails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-early-v14-rollback-'))
  const path = join(root, 'library.sqlite')
  const db = new LibraryDatabase(path)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  seed(db)
  db.sql.exec(earlyV14Schema)
  const exec = DatabaseSync.prototype.exec
  const failure = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TRIGGER metadata_identification_source_before'))
      throw new Error('Injected early v14 migration failure')
    return exec.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /Injected early v14 migration failure/)
  failure.mock.restore()
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 14)
  assert.equal(db.sql.prepare("SELECT name FROM sqlite_master WHERE name='metadata_identification_inputs'").get(), undefined)
  assert.equal(db.getMetadata().trackCount, 2)
  assert.ok(readdirSync(root).some(f => f.includes('.v14-backup-')))
})

test('v14 compatibility never accepts partial input fences, missing identity data or newer incomplete schemas', (t) => {
  for (const ddl of [
    'DROP TRIGGER metadata_identification_input_changed;',
    'DROP TRIGGER metadata_identification_input_changed; DROP TABLE metadata_identification_inputs; CREATE TABLE metadata_identification_inputs(entity_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);',
    'DROP TRIGGER metadata_identification_input_changed; DROP TABLE metadata_identification_inputs; DROP TABLE metadata_identity_refs;',
    'DROP TRIGGER metadata_identification_input_changed; DROP TABLE metadata_identification_inputs; PRAGMA user_version=15;'
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'identity-invalid-v14-'))
    const path = join(root, 'library.sqlite')
    const db = new LibraryDatabase(path)
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
    seed(db)
    db.sql.exec(LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL + 'PRAGMA user_version=14;' + ddl)
    const version = db.sql.prepare('PRAGMA user_version').get()!.user_version
    assert.throws(() => new LibraryDatabase(path), /Unrecognized or incomplete/)
    assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, version)
    assert.equal(readdirSync(root).filter(f => f.includes('-backup-')).length, 0)
  }
})

test('manual source grouping invalidates only changed membership, including moving sources away and back', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  const source = db.sql.prepare("SELECT * FROM catalog_sources WHERE provider='ncm'").get()!
  const recording = String(source.recording_id)
  const release = String(source.release_id)
  const project = String(db.sql.prepare('SELECT project_id FROM catalog_release_projects WHERE release_id=?').get(release)!.project_id)
  const inputs = [recording, release, project].map((id) => db.identificationInput(id))
  const document = emptyMusicVersions()
  document.tracks.versions.push({ id: 'manual-track', label: 'Track grouping', sources: [String(source.source_key)], preferredSource: null })
  document.albums.versions.push({ id: 'manual-album', label: 'Album grouping', sources: [String(source.album_key)], preferredSource: null })
  db.catalogProjectVersions(document, 1)
  const manual = db.catalogQuery({ kind: 'recording', search: 'Track grouping' }).items[0].id
  const first = db.identificationInput(manual)
  db.catalogProjectVersions(document, 2)
  assert.equal(db.identificationInput(manual).version, first.version, 'identical grouping is not a changed input')
  db.catalogProjectVersions(emptyMusicVersions(), 3)
  for (const input of inputs) assert.notEqual(db.identificationInput(input.entityId).version, input.version)
  db.catalogProjectVersions(document, 4)
  assert.notEqual(db.identificationInput(manual).version, first.version)
})

test('v15 source-fence DDL failure rolls back the partial index and triggers, preserving a v14 backup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-fence-rollback-'))
  const path = join(root, 'library.sqlite')
  const db = new LibraryDatabase(path)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  seed(db)
  db.sql.exec(LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL + 'PRAGMA user_version=14;')
  const exec = DatabaseSync.prototype.exec
  const failure = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TRIGGER metadata_identification_source_before')) {
      exec.call(this, sql.slice(0, sql.indexOf('CREATE TRIGGER metadata_identification_source_after')))
      throw new Error('Injected source fence DDL failure')
    }
    return exec.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /Injected source fence DDL/)
  failure.mock.restore()
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 14)
  assert.equal(db.sql.prepare("SELECT name FROM sqlite_master WHERE name='metadata_identification_source_before'").get(), undefined)
  assert.equal(db.sql.prepare("SELECT name FROM sqlite_master WHERE name='catalog_source_album_key'").get(), undefined)
  assert.equal(db.getMetadata().trackCount, 2)
  const backup = new DatabaseSync(join(root, readdirSync(root).find((f) => f.includes('.v14-backup-'))!))
  assert.equal(backup.prepare('SELECT count(*) AS n FROM tracks').get()!.n, 2)
  backup.close()
})

test('shared-artist context is bounded and advertises truncation without dropping later-source fences', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  let batch = db.catalogSync({ kind: 'begin', revision: 2 })
  batch = db.catalogSync({ kind: 'append', ...batch, tracks: Array.from({ length: 70 }, (_, index) => ({
    id: `ncm:${index}`, source: 'ncm', title: `Song ${index}`, artist: 'Shared artist', album: 'Album',
    albumId: 'same-album', artists: [{ id: 888, name: 'Shared artist' }],
    filePath: '', fileName: '', duration: 200, size: 0, cover: null, lyrics: null
  })) })
  db.catalogSync({ kind: 'commit', ...batch })
  const artist = db.catalogQuery({ kind: 'artist', source: 'ncm', search: 'Shared artist' }).items[0].id
  const before = db.identificationInput(artist)
  assert.equal(before.sources!.length, 64)
  assert.equal(before.sourcesTruncated, true)
  const omitted = db.sql.prepare(`SELECT source_id FROM catalog_source_artists WHERE artist_id=?
    AND source_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(artist, JSON.stringify(before.sources!.map((s) => s.sourceId)))!
  db.sql.prepare("UPDATE catalog_sources SET payload=json_set(payload,'$.trackNumber',99) WHERE id=?").run(String(omitted.source_id))
  assert.notEqual(db.identificationInput(artist).version, before.version)
})

test('v13 migration keeps target UUIDs, facts, manual values, job demands and rejects; project backfill is bounded and resumable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identification-v13-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const {
    local: [a, b]
  } = seed(db)
  const first = confirm(db, publish(db, a, proposal(ref(MBID, 'musicbrainz')))[0])
  const targetId = first.link!.targetId!
  db.metadataOverride(
    {
      entityId: a,
      revision: db.metadataDetail(a, 'en').revision,
      mode: 'value',
      value: 'Kept notes',
      language: 'en'
    },
    2000
  )
  const job = db.metadataEnqueue(
    { type: 'enrich', entityId: a, language: 'en', batchId: 'durable' },
    2001
  )
  const work = db.metadataClaim(2001)!
  const fact = {
    field: 'introduction',
    value: 'Saved biography',
    language: 'en',
    attribution: {
      provider: 'wikipedia',
      externalId: '7',
      revision: '8',
      url: 'https://en.wikipedia.org/wiki/Artist',
      license: 'CC-BY-SA-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'Wikipedia contributors',
      retrievedAt: 1000
    }
  }
  db.sql
    .prepare('INSERT INTO metadata_facts VALUES(?,?,?,?,?)')
    .run(targetId, 'wikipedia', 'introduction', 'en', JSON.stringify(fact))
  db.sql
    .prepare(
      "INSERT INTO metadata_link_history(entity_id,mbid,state,evidence,changed_at) VALUES(?,?,'rejected','{}',2002)"
    )
    .run(b, MBID)
  // Restore actual M2.1 provenance, not just its version pragma.
  db.sql
    .prepare("UPDATE metadata_entities SET provider='musicbrainz',external_id=? WHERE id=?")
    .run(MBID, targetId)
  db.sql
    .prepare('UPDATE metadata_jobs SET input=? WHERE id=?')
    .run(
      JSON.stringify(db.sql.prepare('SELECT * FROM metadata_entities WHERE id=?').get(targetId)),
      job.id
    )
  db.sql.exec(LEGACY_IDENTIFICATION_SCHEMA_SQL + 'PRAGMA user_version=13;')
  const revision = db.getContentRevision()
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  assert.equal(db.identificationDetail(a).link!.targetId, targetId)
  assert.deepEqual(db.identificationDetail(a).references, [ref(MBID, 'musicbrainz')])
  assert.equal(db.metadataDetail(a, 'en').introduction!.value, 'Kept notes')
  assert.deepEqual(db.metadataDetail(a, 'en').facts, [fact])
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].generation, work.job.generation)
  db.metadataRecover(3000)
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].generation, work.job.generation + 1)
  const resumed = db.metadataClaim(3000)!
  assert.equal(
    db.metadataFinish(resumed, { state: 'completed', outcome: 'matched', facts: [] }, 3001),
    true
  )
  assert.equal(
    db.sql.prepare('SELECT batch_id FROM metadata_demands WHERE job_id=?').get(job.id)!.batch_id,
    'durable'
  )
  assert.equal(publish(db, b, proposal(ref(MBID, 'musicbrainz')))[0].suppressed, true)
  assert.equal(db.catalogQuery({ kind: 'album_project' }).total, 0)
  db.catalogAdvance(1)
  assert.equal(db.catalogQuery({ kind: 'album_project' }).total, 1)
  db.close()
  db = new LibraryDatabase(path)
  while (db.catalogStatus().localPending) db.catalogAdvance(1)
  assert.equal(
    db.catalogQuery({ kind: 'album_project' }).total,
    db.catalogQuery({ kind: 'release' }).total
  )
  assert.equal(db.getContentRevision(), revision)
  const backup = new DatabaseSync(
    join(root, readdirSync(root).find((f) => f.includes('.v13-backup-'))!)
  )
  assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 13)
  assert.equal(backup.prepare('SELECT id FROM metadata_entities').get()!.id, targetId)
  backup.close()
})

test('v14 DDL failure restores the v13 schema and records a usable snapshot', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identification-rollback-')),
    path = join(root, 'library.sqlite')
  const db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(db)
  db.sql.exec(LEGACY_IDENTIFICATION_SCHEMA_SQL + 'PRAGMA user_version=13;')
  const exec = DatabaseSync.prototype.exec
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE metadata_identity_refs')) {
        exec.call(this, sql.slice(0, sql.indexOf('CREATE TABLE metadata_identity_links')))
        throw new Error('Injected identity DDL failure')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /Injected identity DDL/)
  failure.mock.restore()
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 13)
  assert.equal(
    db.sql.prepare("SELECT name FROM sqlite_master WHERE name='metadata_identity_refs'").get(),
    undefined
  )
  assert.equal(db.getMetadata().trackCount, 2)
  assert.equal(
    readdirSync(root).some((f) => f.includes('.v13-backup-')),
    true
  )
})

test('migration exposes valid old review jobs but never refreshes stale candidate evidence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identification-old-review-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const {
    local: [a, b]
  } = seed(db)
  const jobs = [a, b].map((entityId) => {
    const job = db.metadataEnqueue(
      { type: 'resolve', entityId, mbid: MBID, language: 'en', batchId: 'old-review' },
      1000
    )
    const work = db.metadataClaim(1000)!
    db.metadataFinish(
      work,
      {
        state: 'needs_review',
        candidate: {
          mbid: MBID,
          name: 'Artist',
          disambiguation: '',
          type: 'Person',
          wikidataId: null,
          evidence: {
            provider: 'musicbrainz',
            externalId: MBID,
            url: `https://musicbrainz.org/artist/${MBID}`,
            license: 'CC0-1.0',
            licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
            attribution: 'MusicBrainz contributors',
            revision: '',
            retrievedAt: 1000
          }
        }
      },
      1001
    )
    return job
  })
  db.sql.prepare('UPDATE catalog_entities SET title=? WHERE id=?').run('A different person', b)
  const online = db.catalogQuery({ kind: 'artist', source: 'ncm' }).items[0].id
  const target = confirm(db, publish(db, online, proposal(ref(MBID, 'musicbrainz')))[0]).link!
    .targetId!
  const enrich = db.metadataEnqueue(
    { type: 'enrich', entityId: online, language: 'en', batchId: 'needs-review' },
    1002
  )
  db.metadataFinish(
    db.metadataClaim(1002)!,
    { state: 'needs_review', candidate: null, reason: 'identity_mismatch' },
    1003
  )
  db.sql
    .prepare("UPDATE metadata_entities SET provider='musicbrainz',external_id=? WHERE id=?")
    .run(MBID, target)
  db.sql.exec(LEGACY_IDENTIFICATION_SCHEMA_SQL + 'PRAGMA user_version=13;')
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.identificationCandidates({ entityId: a }).total, 1)
  assert.equal(db.identificationCandidates({ entityId: b }).total, 0)
  assert.equal(db.metadataJobs({ jobId: enrich.id }).items[0].state, 'needs_review')
  assert.equal(db.metadataJobs({ jobId: jobs[1].id }).items[0].state, 'needs_review')
  assert.throws(
    () =>
      db.metadataDecide(
        { jobId: jobs[1].id, generation: jobs[1].generation, decision: 'confirm' },
        2000
      ),
    /变化/
  )
  const candidate = db.identificationCandidates({ entityId: a }).items[0]
  assert.equal(db.identificationPreview(review(candidate)).canConfirm, true)
  confirm(db, candidate)
  assert.equal(db.metadataJobs({ jobId: jobs[0].id }).items[0].state, 'completed')
})

test('adding a verified MB reference makes the legacy enrichment path available to every linked platform/local subject', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const {
    local: [a],
    online
  } = seed(db)
  confirm(db, publish(db, online, proposal(ref('42')))[0])
  confirm(db, publish(db, a, proposal(ref('42'), ref(MBID, 'musicbrainz')))[0])
  assert.equal(db.metadataDetail(online, 'en').link!.mbid, MBID)
  const onlineJob = db.metadataEnqueue(
    { entityId: online, type: 'enrich', language: 'en', batchId: 'online' },
    2000
  )
  const localJob = db.metadataEnqueue(
    { entityId: a, type: 'enrich', language: 'en', batchId: 'local' },
    2000
  )
  assert.equal(onlineJob.id, localJob.id)
  assert.equal(onlineJob.externalId, MBID)
})

test('public identification APIs accept bounded references to stored candidates, never uploaded provider results', () => {
  const request = (name: string, payload: unknown, kind = 'query') => ({
    kind,
    name,
    payload,
    requestId: '1',
    epoch: 'core'
  })
  assert.equal(isCoreRequest(request('catalog.query', { kind: 'album_project' })), true)
  assert.equal(
    isCoreRequest(request('identification.candidates', { entityId: 'artist', limit: 100 })),
    true
  )
  assert.equal(
    isCoreRequest(request('identification.candidates', { entityId: 'artist', limit: 101 })),
    false
  )
  assert.equal(
    isCoreRequest(
      request('identification.preview', { candidateId: 'candidate', revision: 1, linkRevision: 0 })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('identification.preview', {
        candidateId: 'candidate',
        revision: 1,
        linkRevision: 0,
        references: [ref('42')]
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'identification.decide',
        { candidateId: 'candidate', revision: 1, linkRevision: 0, decision: 'confirm' },
        'command'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('identification.decide', { candidateId: 'candidate', decision: 'confirm' }, 'command')
    ),
    false
  )
  assert.equal(coreOperation('identification.decide')!.permission, 'library:write')
  assert.equal(coreOperation('identification.detail')!.permission, 'library:read')
})
