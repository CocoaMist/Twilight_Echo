import test from 'node:test'
import assert from 'node:assert/strict'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type {
  IdentificationCandidate,
  MusicExternalReference
} from '../../shared/musicIdentification.ts'
import { validIdentificationPayload } from '../../shared/musicIdentification.ts'
import { createIdentityReviewView } from '../../renderer/src/components/music-metadata/identityReviewView.ts'

const MB = '151bb385-1af0-40b6-9269-bf2ed982311f'
const usage = { display: true, cache: true, crossSource: true, export: false }
function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: ['Artist', 'Other'].map((artist, i) => ({
      id: String(i),
      source: 'local',
      filePath: `D:/test/${i}.flac`,
      title: 'Song',
      artist,
      album: 'Album'
    }))
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entityId = db.catalogQuery({ kind: 'artist', artistName: 'Artist' }).items[0].id
  const otherId = db.catalogQuery({ kind: 'artist', artistName: 'Other' }).items[0].id
  const publish = (id: string, provider = 'ncm', value = '42') =>
    db.identificationPublish(
      db.identificationInput(id),
      [
        {
          provider,
          matcherVersion: 'fixture',
          name: 'Artist',
          summary: 'Explicitly reviewed profile',
          references: [
            {
              provider,
              kind: 'artist',
              idType: provider === 'musicbrainz' ? 'mbid' : 'native',
              value
            }
          ],
          evidence: {
            origin: 'search',
            matches: ['name'],
            missing: ['review'],
            conflicts: [],
            incomplete: true,
            provenance: 'fixture'
          }
        }
      ],
      1000
    )[0]
  const review = (c: IdentificationCandidate) => ({
    candidateId: c.id,
    revision: c.revision,
    linkRevision: c.linkRevision
  })
  const first = publish(entityId, 'musicbrainz', MB)
  db.identificationDecide({ ...review(first), decision: 'confirm' }, 1001)
  return { db, entityId, otherId, publish, review }
}

test('explicit NCM attachment retains confirmed target, MB facts and manual content; the review UI sends the versioned opt-in', async (t) => {
  const { db, entityId, publish } = fixture(t)
  const original = db.identificationDetail(entityId)
  db.metadataOverride(
    {
      entityId,
      revision: db.metadataDetail(entityId, 'en').revision,
      language: 'en',
      mode: 'value',
      value: 'Personal notes'
    },
    1100
  )
  const candidate = publish(entityId)
  let sent: unknown
  const view = createIdentityReviewView({
    detail: async (id) => db.identificationDetail(id),
    candidates: async (q) => db.identificationCandidates(q),
    preview: async (q) => db.identificationPreview(q),
    decide: async (q) => {
      sent = q
      return db.identificationDecide(q, 1200)
    },
    detach: async () => {},
    start: async () => {},
    newId: () => 'review',
    changed: async () => {}
  })
  t.after(view.dispose)
  await view.setContext(entityId, 'local')
  await view.review(candidate)
  assert.equal(
    view.state.value.preview?.action,
    'replace',
    'existing replacement path remains explicit'
  )
  assert.equal(view.canAttachToCurrent.value, true)
  await view.decide('confirm', true)
  assert.equal((sent as { attachToCurrent?: boolean }).attachToCurrent, true)
  assert.equal(view.state.value.identity?.link?.targetId, original.link?.targetId)
  assert.deepEqual(view.state.value.identity?.references.map((r) => r.provider).sort(), [
    'musicbrainz',
    'ncm'
  ])
  assert.equal(db.metadataDetail(entityId, 'en').introduction?.value, 'Personal notes')
  assert.equal(db.identificationCandidates({ entityId, state: 'rejected' }).items.length, 0)
  const last = db.identificationHistory({ entityId, limit: 1 }).items[0]
  assert.deepEqual(last.references.map((r) => r.provider).sort(), ['musicbrainz', 'ncm'])

  const job = db.metadataEnqueue(
    {
      type: 'enrich',
      entityId,
      provider: 'platform.ncm',
      providerContext: 'native',
      language: 'zh-Hans',
      batchId: 'fallback'
    },
    1300
  )
  assert.equal(job.externalId, '42')
  const attribution = {
    provider: 'platform.ncm',
    externalId: '42',
    url: 'https://music.163.com/#/artist?id=42',
    revision: '',
    attribution: '网易云音乐',
    license: '',
    licenseUrl: '',
    retrievedAt: 1300
  }
  db.metadataFinish(
    db.metadataClaim(1300)!,
    {
      state: 'completed',
      outcome: 'matched',
      facts: [
        {
          field: 'introduction',
          value: 'NCM 中文',
          language: 'zh-Hans',
          attribution,
          sourceProvider: 'ncm',
          providerContext: 'native',
          usage
        },
        {
          field: 'introduction',
          value: 'Existing biography',
          language: 'en',
          attribution: { ...attribution, provider: 'wikipedia' }
        }
      ],
      artwork: [
        {
          field: 'artwork',
          scope: 'artist',
          resource: 'https://p4.music.126.net/portrait/42.jpg',
          targetId: '42',
          targetRef: { provider: 'ncm', kind: 'artist', idType: 'native', value: '42' },
          attribution,
          usage,
          providerContext: 'native'
        }
      ]
    },
    1301
  )
  let d = db.metadataDetail(entityId, 'zh-Hans', { platformContexts: { ncm: 'native' }, now: 1301 })
  db.metadataOverride({ entityId, revision: d.revision, language: 'zh-Hans', mode: 'reset' }, 1302)
  d = db.metadataDetail(entityId, 'zh-Hans', { platformContexts: { ncm: 'native' }, now: 1302 })
  assert.equal(d.introduction?.value, 'Existing biography')
  assert.equal(
    db.metadataArtwork(entityId, { artworkContexts: { 'platform.ncm': 'native' }, now: 1302 })[0]
      .targetRef?.provider,
    'ncm'
  )

  const publicJob = db.metadataEnqueue(
    {
      type: 'enrich',
      entityId,
      provider: 'public-artwork',
      providerContext: 'public',
      language: 'en',
      batchId: 'public'
    },
    1400
  )
  assert.equal(publicJob.externalId, MB)
  db.metadataFinish(
    db.metadataClaim(1400)!,
    {
      state: 'completed',
      outcome: 'matched',
      facts: [],
      artwork: [
        {
          field: 'artwork',
          scope: 'artist',
          resource: 'https://upload.wikimedia.org/portrait.jpg',
          targetId: MB,
          attribution: { ...attribution, provider: 'commons', externalId: MB },
          usage,
          providerContext: 'public'
        }
      ]
    },
    1401
  )
  assert.equal(
    db.metadataArtwork(entityId, {
      artworkContexts: { 'platform.ncm': 'native', 'public-artwork': 'public' },
      now: 1401
    })[0].attribution.provider,
    'commons'
  )
})

test('NCM attachment cannot merge existing targets, overwrite another NCM identity or accept stale reviews', (t) => {
  const { db, entityId, otherId, publish, review } = fixture(t)
  const other = publish(otherId)
  db.identificationDecide({ ...review(other), decision: 'confirm' }, 1100)
  let candidate = publish(entityId)
  assert.equal(db.identificationPreview(review(candidate)).canAttachToCurrent, undefined)
  assert.throws(
    () =>
      db.identificationDecide(
        { ...review(candidate), decision: 'confirm', attachToCurrent: true },
        1101
      ),
    /无法补充/
  )
  candidate = publish(entityId, 'ncm', '43')
  const original = db.identificationDetail(entityId).link!.targetId
  db.identificationDecide(
    { ...review(candidate), decision: 'confirm', attachToCurrent: true },
    1102
  )
  assert.equal(db.identificationDetail(entityId).link?.targetId, original)
  assert.throws(
    () =>
      db.identificationDecide(
        { ...review(candidate), decision: 'confirm', attachToCurrent: true },
        1103
      ),
    /已变化|过期/
  )
  candidate = publish(entityId, 'ncm', '44')
  assert.equal(db.identificationPreview(review(candidate)).canAttachToCurrent, undefined)
  assert.throws(
    () =>
      db.identificationDecide(
        { ...review(candidate), decision: 'confirm', attachToCurrent: true },
        1104
      ),
    /无法补充/
  )
  const wrong = publish(entityId, 'discogs', '45')
  assert.equal(db.identificationPreview(review(wrong)).canAttachToCurrent, undefined)
  assert.equal(
    validIdentificationPayload('identification.decide', {
      ...review(wrong),
      decision: 'reject',
      attachToCurrent: true
    }),
    false
  )
  assert.equal(
    validIdentificationPayload('identification.decide', {
      ...review(wrong),
      decision: 'confirm',
      attachToCurrent: false
    }),
    false
  )
  const refs = db.identificationDetail(entityId).references as MusicExternalReference[]
  assert.deepEqual(refs.map((r) => r.value).sort(), [MB, '43'].sort())
})
