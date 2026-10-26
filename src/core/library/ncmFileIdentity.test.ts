import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { collectTrackIdentityTags } from '../../main/library/trackIdentityTags.ts'
import { readNcmFileIdentity } from '../../main/library/ncmFileIdentity.ts'
import { ncmFileTagMatches, ncmFileReferences } from '../../shared/ncmFileIdentity.ts'
import { normalizeTrackIdentityTags } from '../../shared/trackIdentification.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { PlatformIdentificationProvider } from './musicIdentificationProvider.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'

const identity = {
  musicId: 123,
  musicName: 'Song',
  albumId: 456,
  album: 'Album',
  artist: [
    ['AC/DC', 42],
    ['Guest', 43]
  ],
  duration: 200000
}
function comment(value: unknown = identity) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from("#14ljk_!\\]&0U<'("), null)
  return (
    "163 key(Don't modify):" +
    Buffer.concat([cipher.update('music:' + JSON.stringify(value)), cipher.final()]).toString(
      'base64'
    )
  )
}
const common = () => ({
  title: 'Song',
  album: 'Album',
  artist: 'AC/DC/Guest',
  artists: ['AC/DC/Guest'],
  comment: [{ text: comment() }]
})
const tags = () => collectTrackIdentityTags(common(), 200.25, { title: '', artist: '' })
const adapter = () =>
  new PlatformIdentificationProvider('ncm', {
    inventory: () => [
      {
        id: 'ncm',
        enabled: true,
        configuration: 'test',
        supportedMethods: ['searchArtists', 'searchSongs', 'searchAlbums']
      }
    ],
    search: async () => {
      throw Error('file identity must not do name search')
    }
  })

test('file metadata retains only paired identity and accepts raw slash credits without splitting AC/DC', () => {
  const raw = readNcmFileIdentity([
    { text: comment({ ...identity, playbackUrl: 'private', albumPic: 'unused' }) }
  ])!
  assert.deepEqual(raw, {
    recordingId: '123',
    releaseId: '456',
    title: 'Song',
    album: 'Album',
    artists: [
      { name: 'AC/DC', id: '42' },
      { name: 'Guest', id: '43' }
    ],
    durationSeconds: 200
  })
  assert.equal(ncmFileTagMatches(tags()), true)
  assert.deepEqual(normalizeTrackIdentityTags(tags())?.ncm, raw)
})

test('corrupt, duplicate, oversized, stale and CUE tags never become native identities', () => {
  for (const value of [
    [],
    [comment(), comment()],
    [comment().slice(0, -3)],
    ["163 key(Don't modify):bad"],
    [comment({ ...identity, musicId: -1 })],
    [comment({ ...identity, artist: [] })],
    [comment() + 'a'.repeat(33000)]
  ])
    assert.equal(readNcmFileIdentity(value), undefined)
  for (const patch of [{ title: 'Different' }, { album: 'Different' }, { artists: ['Other'] }])
    assert.equal(
      collectTrackIdentityTags({ ...common(), ...patch }, 200.25, { title: '', artist: '' }).ncm,
      undefined
    )
  assert.equal(collectTrackIdentityTags(common(), 210, { title: '', artist: '' }).ncm, undefined)
  assert.equal(ncmFileTagMatches({ ...tags(), scope: 'cue_track' }), false)
  assert.equal(
    ncmFileTagMatches({ ...tags(), title: { value: 'Song', origin: 'filename' } }),
    false
  )
})

function seed(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'local',
        filePath: 'D:/Music/song.flac',
        source: 'local',
        title: 'Song',
        artist: 'AC/DC/Guest',
        artists: [{ name: 'AC/DC' }, { name: 'Guest' }],
        album: 'Album',
        duration: 200.25,
        identityTags: tags()
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return db
}

test('real parser observations survive catalog persistence and automatic jobs confirm each paired entity', async (t) => {
  const db = seed(t),
    provider = adapter()
  const request = {
    enabled: true,
    newImports: true,
    history: false,
    providers: [
      {
        id: provider.id,
        matcherVersion: provider.matcherVersion,
        kinds: ['artist', 'release', 'recording'] as CatalogKind[]
      }
    ]
  }
  while (db.identificationSchedule(request, 1000).more) {
    // Drain the bounded scheduling pages before claiming their queued jobs.
  }
  let count = 0
  for (let work = db.metadataClaim(1000); work; work = db.metadataClaim(1000)) {
    assert.equal(work.job.type, 'identify')
    const input = db.identificationInput(work.job.entityId)
    const result = await provider.recall(input, new AbortController().signal)
    assert.equal(result.proposals.length, 1)
    assert.equal(result.proposals[0].evidence.verification?.method, 'file_native')
    assert.equal(db.metadataFinish(work, { state: 'identified', ...result }, 1001, request), true)
    const detail = db.identificationDetail(input.entityId)
    assert.equal(detail.link?.state, 'confirmed')
    assert.equal(detail.link?.confirmation?.rule, 'file_native')
    assert.equal(
      detail.references[0].value,
      input.kind === 'artist'
        ? input.name === 'AC/DC'
          ? '42'
          : '43'
        : input.kind === 'release'
          ? '456'
          : '123'
    )
    count++
  }
  assert.equal(count, 4)
})

test('conflicting same-name IDs require review; incomplete input and combinations cannot pick the first artist', async (t) => {
  const db = seed(t)
  const entity = db
    .catalogQuery({ kind: 'artist', source: 'local' })
    .items.find((i) => i.title === 'AC/DC')!
  const input = db.identificationInput(entity.id),
    s = input.sources![0]
  const other = {
    ...s,
    sourceId: 'other',
    tags: {
      ...s.tags,
      ncm: {
        ...s.tags.ncm!,
        artists: [
          { id: '99', name: 'AC/DC' },
          { id: '43', name: 'Guest' }
        ]
      }
    }
  }
  const result = await adapter().recall(
    { ...input, sources: [s, other] },
    new AbortController().signal
  )
  assert.equal(result.proposals.length, 2)
  assert.ok(
    result.proposals.every(
      (p) => !p.evidence.verification && p.evidence.conflicts.includes('multiple_native_ids')
    )
  )
  assert.equal(ncmFileReferences({ ...input, sourcesTruncated: true }).size, 0)
  assert.equal(ncmFileReferences({ ...input, name: 'AC/DC/Guest' }).size, 0)
})
