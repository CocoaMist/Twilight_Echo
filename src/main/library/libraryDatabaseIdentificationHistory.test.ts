import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabaseIdentification } from './libraryDatabaseIdentification.ts'
import {
  validIdentificationPayload,
  type IdentificationHistoryReview
} from '../../shared/musicIdentification.ts'

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'track',
        source: 'local',
        filePath: 'D:/private/one.flac',
        title: 'One',
        artist: 'Same name',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entity = db.catalogQuery({ kind: 'artist' }).items[0]
  const identity = new LibraryDatabaseIdentification({
    sql: db.sql,
    transaction: (action) => {
      db.sql.exec('BEGIN IMMEDIATE')
      try {
        const result = action()
        db.sql.exec('COMMIT')
        return result
      } catch (error) {
        db.sql.exec('ROLLBACK')
        throw error
      }
    }
  })
  const confirm = (value: string) => {
    const [candidate] = identity.publish(
      identity.input(entity.id),
      [
        {
          provider: 'ncm',
          name: `Artist ${value}`,
          summary: 'Saved provider response',
          matcherVersion: 'fixture1',
          references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value }],
          evidence: {
            origin: 'search',
            matches: ['name'],
            missing: ['cross_reference'],
            conflicts: [],
            incomplete: true,
            provenance: 'fixture'
          }
        }
      ],
      1000
    )
    identity.decide(
      {
        candidateId: candidate.id,
        revision: candidate.revision,
        linkRevision: candidate.linkRevision,
        decision: 'confirm'
      },
      1001
    )
    return identity
      .history({ entityId: entity.id })
      .items.find((item) => item.state === 'confirmed')!
  }
  const review = (historySeq: number): IdentificationHistoryReview => {
    const page = identity.history({ entityId: entity.id })
    return {
      entityId: entity.id,
      historySeq,
      linkRevision: page.current.link!.revision,
      inputVersion: page.inputVersion
    }
  }
  return { db, identity, entity, confirm, review }
}

test('history is bounded and read-only; restore compares typed IDs and writes an independent audited decision', (t) => {
  const { db, identity, entity, confirm, review } = fixture(t)
  db.metadataOverride(
    { entityId: entity.id, revision: 0, mode: 'value', language: 'en', value: 'My notes' },
    900
  )
  const originalTrack = db.sql.prepare('SELECT * FROM tracks').all()
  const first = confirm('42'),
    second = confirm('84')
  const before = db.sql.prepare('SELECT total_changes() n').get()!.n
  const page = identity.history({ entityId: entity.id, limit: 2 })
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 2)
  assert.deepEqual(
    page.items[1].references,
    first.references,
    'replacement event shows outgoing IDs, not incoming candidate IDs'
  )
  assert.equal(
    identity.history({ entityId: entity.id, offset: 2, limit: 2 }).items[0].seq,
    first.seq
  )
  const query = review(first.seq),
    preview = identity.restorePreview(query)
  assert.equal(preview.canRestore, true)
  assert.equal(preview.action, 'replace')
  assert.equal(preview.current.references[0].value, '84')
  assert.equal(preview.references[0].value, '42')
  assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, before)
  const candidates = db.sql.prepare('SELECT * FROM metadata_identity_candidates').all()
  identity.restore(query, 2000)
  assert.equal(identity.detail(entity.id).references[0].value, '42')
  assert.equal(identity.detail(entity.id).link!.confirmation!.mode, 'manual')
  const restored = identity.history({ entityId: entity.id }).items[0]
  assert.equal(restored.restoredFrom, first.seq)
  assert.equal(restored.state, 'confirmed')
  assert.notEqual(restored.seq, first.seq)
  assert.equal(identity.history({ entityId: entity.id }).items[1].references[0].value, '84')
  assert.throws(
    () => identity.restore(query, 2001),
    { code: 'STALE_REVISION' },
    'stale button cannot restore twice'
  )
  assert.equal(db.metadataDetail(entity.id, 'en').introduction!.value, 'My notes')
  assert.deepEqual(db.sql.prepare('SELECT * FROM tracks').all(), originalTrack)
  assert.equal(identity.restorePreview(review(restored.seq)).action, 'keep')
  assert.equal(identity.restorePreview(review(restored.seq)).canRestore, false)
  assert.equal(identity.restorePreview(review(second.seq)).canRestore, true)
  assert.deepEqual(
    db.sql
      .prepare('SELECT * FROM metadata_identity_candidates WHERE id=?')
      .get(String(candidates[0].id)),
    candidates[0],
    'restoring history does not silently refresh old candidate evidence'
  )
})

test('detached identity can be restored, but changed source inputs and pending or removed members cannot', (t) => {
  const { db, identity, entity, confirm, review } = fixture(t)
  const first = confirm('42'),
    link = identity.detail(entity.id).link!
  identity.detach(link.id, link.revision, 1002)
  const query = review(first.seq)
  assert.equal(identity.restorePreview(query).canRestore, true)
  identity.restore(query, 1003)
  const fresh = review(first.seq)
  db.patchTracks([{ id: 'track', expectedVersion: 1, patch: { title: 'Changed' } }])
  assert.equal(
    identity.restorePreview(fresh).stale,
    true,
    'pending local projections are not available evidence'
  )
  while (db.catalogStatus().localPending) db.catalogAdvance()
  assert.equal(
    identity.restorePreview(review(first.seq)).stale,
    true,
    'a new current fence does not refresh the historical evidence'
  )
  assert.throws(() => identity.restore(review(first.seq), 2000), { code: 'STALE_REVISION' })
  db.sql.prepare("DELETE FROM tracks WHERE id='track'").run()
  assert.equal(identity.restorePreview(fresh).stale, true)
  assert.throws(() => identity.history({ entityId: entity.id }), { code: 'STALE_REVISION' })
})

test('history restore rejects wrong owner, unavailable snapshot and conflicting target references', (t) => {
  const { db, identity, entity, confirm, review } = fixture(t)
  const first = confirm('42')
  confirm('84')
  assert.throws(
    () => identity.restorePreview({ ...review(first.seq), entityId: 'not-the-owner' }),
    /不存在/
  )
  const replaced = identity
    .history({ entityId: entity.id })
    .items.find((item) => item.state === 'replaced')!
  assert.equal(identity.restorePreview(review(replaced.seq)).canRestore, false)
  db.sql
    .prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)')
    .run('ncm', 'artist', 'native', 'conflict', first.targetId!)
  const preview = identity.restorePreview(review(first.seq))
  assert.equal(preview.canRestore, false)
  assert.ok(preview.conflicts.includes('conflicting_ids_in_same_namespace'))
  assert.throws(() => identity.restore(review(first.seq), 2000), { code: 'IDENTITY_CONFLICT' })
})

test('a failed audit write rolls back link, suppressions, compatibility projection and outbox together', (t) => {
  const { db, identity, entity, confirm, review } = fixture(t)
  const first = confirm('42')
  confirm('84')
  const tables = [
    'metadata_identity_links',
    'metadata_identity_suppressions',
    'metadata_identity_history',
    'metadata_subjects',
    'metadata_link_history',
    'metadata_identification_schedule'
  ]
  const snapshot = () => tables.map((table) => db.sql.prepare(`SELECT * FROM ${table}`).all())
  const before = snapshot(),
    query = review(first.seq)
  db.sql.exec(`CREATE TEMP TRIGGER reject_restore BEFORE INSERT ON metadata_identity_history
    WHEN new.state='confirmed' BEGIN SELECT raise(ABORT,'fixture audit failure'); END`)
  assert.throws(() => identity.restore(query, 2000), /fixture audit failure/)
  assert.deepEqual(snapshot(), before)
  assert.equal(identity.detail(entity.id).references[0].value, '84')
})

test('history requests validate bounded pagination and caller fences', () => {
  assert.equal(
    validIdentificationPayload('identification.history', { entityId: 'one', limit: 100 }),
    true
  )
  assert.equal(
    validIdentificationPayload('identification.history', { entityId: 'one', limit: 101 }),
    false
  )
  assert.equal(
    validIdentificationPayload('identification.history', { entityId: 'one', offset: -1 }),
    false
  )
  const request = { entityId: 'one', historySeq: 1, linkRevision: 0, inputVersion: 'snapshot' }
  for (const name of ['identification.restorePreview', 'identification.restore']) {
    assert.equal(validIdentificationPayload(name, request), true)
    assert.equal(validIdentificationPayload(name, { ...request, targetId: 'untrusted' }), false)
    assert.equal(validIdentificationPayload(name, { ...request, inputVersion: '' }), false)
    assert.equal(validIdentificationPayload(name, { ...request, historySeq: 0 }), false)
  }
})

test('the same history contract restores artist, recording, album project and release without changing source ownership', (t) => {
  const { db, identity } = fixture(t)
  const before = db.sql.prepare('SELECT * FROM catalog_entity_sources').all()
  for (const kind of ['artist', 'recording', 'album_project', 'release'] as const) {
    const entityId = db.catalogQuery({ kind }).items[0].id
    const [candidate] = identity.publish(
      identity.input(entityId),
      [
        {
          provider: 'ncm',
          name: kind,
          summary: '',
          matcherVersion: 'fixture1',
          references: [{ provider: 'ncm', kind, idType: 'native', value: kind }],
          evidence: {
            origin: 'search',
            matches: ['name'],
            missing: [],
            conflicts: [],
            incomplete: false,
            provenance: 'fixture'
          }
        }
      ],
      1000
    )
    identity.decide(
      {
        candidateId: candidate.id,
        revision: candidate.revision,
        linkRevision: candidate.linkRevision,
        decision: 'confirm'
      },
      1001
    )
    const first = identity.history({ entityId }).items[0],
      link = identity.detail(entityId).link!
    identity.detach(link.id, link.revision, 1002)
    const page = identity.history({ entityId })
    const request = {
      entityId,
      historySeq: first.seq,
      linkRevision: page.current.link!.revision,
      inputVersion: page.inputVersion
    }
    assert.equal(identity.restorePreview(request).canRestore, true, kind)
    assert.equal(identity.restore(request, 1003).references[0].kind, kind)
  }
  assert.deepEqual(db.sql.prepare('SELECT * FROM catalog_entity_sources').all(), before)
})
