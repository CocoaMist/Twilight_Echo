import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryQuery, LibraryTrackRecord } from '../../../../shared/libraryDatabase.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'
import { createAggregatePlaylistModel } from '../../../../shared/aggregatePlaylistView.ts'
import { playlistRuntime } from '../coreTestFixtures.ts'
let { buildAggregateRows, collectAggregateSources, resolveAggregateQueue } =
  createAggregatePlaylistModel(playlistRuntime().identity)
import { createLibraryPlaylistView } from './libraryPlaylistView.ts'
import { versionSourceKey } from '../../../../shared/trackSourceIdentity.ts'
import type { RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import { RecordingCompatibilityGroup } from '../../../../shared/recordingGroup.ts'
import { createRecordingIdentityRules } from '../../../../shared/recordingIdentity.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'
import { validateLibraryQuery } from '../../../../main/library/libraryDatabaseValidation.ts'

const track = (id: string, patch: Record<string, unknown> = {}) =>
  libraryTrack({
    id,
    filePath: `D:/Music/${id}.flac`,
    title: '月光',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'local',
    ...patch
  })
async function fixture(t: TestContext, inputs: Track[], versions: RecordingVersion[] = []) {
  ;({ buildAggregateRows, collectAggregateSources, resolveAggregateQueue } =
    createAggregatePlaylistModel(playlistRuntime(versions).identity))
  const db = new LibraryDatabase(':memory:')
  const local = [
    ...new Map(
      inputs.filter((track) => track.source === 'local').map((track) => [track.id, track])
    ).values()
  ]
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: local as unknown as LibraryTrackRecord[],
    folders: [],
    exclusions: []
  })
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => db.syncPlaylistView(request)
  })
  await owner.setPlaylist(
    {
      id: 'p',
      trackIds: inputs.map((track) => track.id),
      trackSnapshots: Object.fromEntries(inputs.map((track) => [track.id, track]))
    },
    { revision: 1, versions, preserveSources: true }
  )
  t.after(async () => {
    await owner.dispose()
    db.close()
  })
  return {
    db,
    owner,
    query: { playlistView: owner.state.value.id!, sort: 'playlist', aggregate: {} } as LibraryQuery
  }
}
function all(db: LibraryDatabase, query: LibraryQuery) {
  const first = db.queryTracks(query),
    tracks = first.tracks.slice(),
    metadata = first.aggregate!.rows.slice(),
    entryIds = first.entryIds!.slice()
  for (let offset = 200; offset < first.total; offset += 200) {
    const page = db.queryTracks({ ...query, offset })
    tracks.push(...page.tracks)
    metadata.push(...page.aggregate!.rows)
    entryIds.push(...page.entryIds!)
  }
  return { ...first, tracks, metadata, entryIds }
}
test('SQLite recording rows, selected variants, hidden sources, search, order and full playback match the original aggregate rules', async (t) => {
  const inputs: Track[] = []
  for (let i = 0; i < 430; i++) {
    const title = `月光 ${i}`
    inputs.push(
      track(`remote:${i}`, { title, source: 'remote', format: 'mp3' }),
      track(`local${i}`, { title, format: 'flac' }),
      track(`ncm:${i}`, { title, source: 'ncm', ncmSongId: i, duration: 184 })
    )
  }
  inputs.push(
    inputs[9],
    track('ncm:second', { title: '月光 0', source: 'ncm', ncmSongId: 9999 }),
    track('long', { title: '月光 0', duration: 200 }),
    track('live', { title: '月光 0', album: 'Live' })
  )
  const { db, query } = await fixture(t, inputs)
  for (const hiddenSources of [[], ['local'], ['remote', 'ncm'], ['unknown']])
    for (const search of ['', '月光 4', '月 光', 'ARTIST', 'Album', 'no-match']) {
      const variantPreferences = { local0: 'ncm', local9: 'unknown' }
      const expectedAll = buildAggregateRows({ tracks: inputs, hiddenSources, variantPreferences })
      const expected = expectedAll.filter((row) =>
        `${row.title} ${row.artist} ${row.album}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      )
      const actual = all(db, { ...query, search, aggregate: { hiddenSources, variantPreferences } })
      assert.equal(actual.total, expected.length)
      assert.equal(actual.aggregate!.rowCount, expectedAll.length)
      assert.equal(actual.aggregate!.memberCount, inputs.length)
      assert.deepEqual(
        actual.tracks.map((track) => track.id),
        expected.map((row) => row.selectedVariant.track.id)
      )
      assert.deepEqual(
        actual.metadata.map((row) => ({
          anchor: row.anchorTrackId,
          all: row.variantCount,
          visible: row.visibleVariantCount,
          pinned: row.variantPinned,
          unavailable: row.preferenceUnavailable
        })),
        expected.map((row) => ({
          anchor: row.anchorTrackId,
          all: row.allVariants.length,
          visible: row.visibleVariants.length,
          pinned: row.variantPinned,
          unavailable: row.preferenceUnavailable
        }))
      )
      if (expected.length) {
        const chosen = Math.min(300, expected.length - 1)
        const queue = db.createLibraryQueue(
          {
            ...query,
            search,
            aggregate: { hiddenSources, variantPreferences },
            playlistEntryId: actual.entryIds[chosen]
          },
          expected[chosen].selectedVariant.track.id
        )
        assert.equal(queue.total, resolveAggregateQueue(expected).length)
        const queued: string[] = []
        for (let offset = 0; offset < queue.total; offset += 200)
          queued.push(...db.readLibraryQueue(queue.id, offset).items.map((item) => item.track!.id))
        assert.deepEqual(
          queued,
          resolveAggregateQueue(expected).map((track) => track.id)
        )
        db.deleteLibraryQueue(queue.id, queue.revision)
        while (db.needsQueryMaintenance) db.maintainQueryState()
      }
    }
  const sources = db.queryTracks({
    ...query,
    aggregate: { hiddenSources: ['gone'], sourceCounts: true }
  })
  assert.deepEqual(sources.aggregate!.sources, collectAggregateSources(inputs, ['gone']))
  assert.equal(sources.tracks.length, 0)
})

test('explicit recording preferences, unavailable preferred sources and CUE identities remain intact', async (t) => {
  const cue = track('cue:2', {
      subTrack: 'cue:2',
      cueRange: { startSeconds: 10, endSeconds: 20 },
      title: 'Local'
    }),
    neighbor = track('cue:1', {
      filePath: cue.filePath,
      subTrack: 'cue:1',
      cueRange: { startSeconds: 0, endSeconds: 10 },
      title: 'Local'
    }),
    remote = track('ncm:7', { source: 'ncm', title: 'Different title' }),
    absent = track('other:1', { source: 'other' })
  const versions = [
    {
      id: 'version',
      sources: [versionSourceKey(cue), versionSourceKey(remote), versionSourceKey(absent)],
      preferredSource: versionSourceKey(absent)
    }
  ]
  const inputs = [cue, neighbor, remote]
  const { db, query } = await fixture(t, inputs, versions)
  const expected = buildAggregateRows({ tracks: inputs }),
    page = all(db, query)
  assert.deepEqual(
    page.tracks.map((t) => t.id),
    expected.map((row) => row.selectedVariant.track.id)
  )
  assert.deepEqual(
    page.metadata.map((row) => row.preferenceUnavailable),
    expected.map((row) => row.preferenceUnavailable)
  )
  assert.equal(page.metadata[0].preferenceUnavailable, true)
  assert.throws(
    () => db.createLibraryQueue({ ...query, playlistEntryId: page.entryIds[0] }, page.tracks[0].id),
    /not in/
  )
  const queue = db.createLibraryQueue(query)
  assert.equal(queue.total, 1)
  const pinned = db.queryTracks({
    ...query,
    aggregate: { variantPreferences: { [page.metadata[0].anchorTrackId]: 'ncm' } }
  })
  assert.equal(pinned.tracks[0].id, 'ncm:7')
  assert.equal(pinned.aggregate!.rows[0].variantPinned, true)
  assert.equal(pinned.aggregate!.rows[0].preferenceUnavailable, false)
})

test('duration/provider/hint sufficient statistics exactly match pairwise recording compatibility', () => {
  const rules = createRecordingIdentityRules(() => undefined)
  let seed = 73
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed
  }
  for (let run = 0; run < 100; run++) {
    const group = new RecordingCompatibilityGroup(),
      members: Track[] = []
    for (let i = 0; i < 150; i++) {
      const provider = ['local', 'ncm', 'other'][next() % 3]
      const candidate = track(`${provider}:${next() % 9}`, {
        source: provider,
        duration: [0, 175, 180, 183, 190, 200, undefined, NaN][next() % 8],
        album: next() % 3 ? 'Album' : 'Live',
        ...(provider === 'ncm' ? { ncmSongId: next() % 3 } : {})
      })
      const expected = members.every((member) => rules.canShareTrackIdentity(member, candidate))
      assert.equal(group.accepts(candidate), expected)
      if (expected) {
        group.add(candidate)
        members.push(candidate)
      }
    }
  }
})

test('variant windows preserve exact occurrence order and keep group removal identities pageable', async (t) => {
  const inputs = Array.from({ length: 605 }, (_, i) =>
    track(`local${i}`, { format: i % 2 ? 'flac' : 'mp3' })
  )
  const { db, query } = await fixture(t, inputs)
  const page = db.queryTracks(query)
  assert.equal(page.total, 1)
  assert.equal(page.aggregate!.rows[0].variantCount, 605)
  const expected = buildAggregateRows({ tracks: inputs })[0].visibleVariants.map((v) => v.track.id)
  const variantQuery = { ...query, aggregate: { variantRow: page.aggregate!.rows[0].rowId } }
  const ids: string[] = [],
    entries: string[] = []
  for (let offset = 0; offset < 605; offset += 200) {
    const result = db.queryTracks({ ...variantQuery, offset })
    assert.ok(result.tracks.length <= 200)
    ids.push(...result.tracks.map((t) => t.id))
    entries.push(...result.entryIds!)
  }
  assert.deepEqual(ids, expected)
  assert.deepEqual(
    entries.map((seq) => inputs[Number(seq)].id),
    ids
  )
  assert.throws(() => db.createLibraryQueue(variantQuery), /cannot create/)
  assert.throws(
    () => db.queryTracks({ ...query, aggregate: { variantRow: '999999' } }),
    /no longer exists/
  )
})

test('indexed first-compatible buckets match pairwise grouping across source aliases, hints and non-transitive durations', async (t) => {
  let seed = 2371
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed >>> 16
  }
  for (let run = 0; run < 8; run++) {
    const inputs = Array.from({ length: 500 }, (_, i) => {
      const source = ['local', 'ncm', 'remote'][next() % 3]
      return track(`${source}:${run}:${i}`, {
        source,
        filePath: `D:/Music/alias${next() % 11}.flac`,
        title: 'Same',
        album: ['Album', 'Live', 'Remastered'][next() % 3],
        duration: [0, 160, 168, 176, 180, 184, 192, 200][next() % 8],
        ...(source === 'ncm' ? { ncmSongId: next() % 17 } : {})
      })
    })
    const { db, query, owner } = await fixture(t, inputs)
    const expected = buildAggregateRows({ tracks: inputs }),
      actual = all(db, query)
    assert.deepEqual(
      actual.tracks.map((track) => track.id),
      expected.map((row) => row.selectedVariant.track.id)
    )
    assert.deepEqual(
      actual.metadata.map((row) => [row.anchorTrackId, row.variantCount]),
      expected.map((row) => [row.anchorTrackId, row.allVariants.length])
    )
    // Each fixture owns its connection until test cleanup; release the private
    // view now rather than occupying extra leases in the next sample.
    await owner.dispose()
  }
})

test('cooperative aggregation closes each batch, fences old revisions and retries failed private groups from definitions', async (t) => {
  const { db, query } = await fixture(
    t,
    Array.from({ length: 607 }, (_, i) => track(`local${i}`, { title: `Song ${i}` }))
  )
  const prepare = db.sql.prepare.bind(db.sql)
  let checkedAssignmentPlan = false
  db.sql.prepare = (sql) => {
    if (sql.startsWith('UPDATE aggregate_inputs SET group_seq=')) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all('{}', '{}')
      assert.ok(plan.some((row) => String(row.detail).includes('rowid=?')))
      checkedAssignmentPlan = true
    }
    return prepare(sql)
  }
  let turns = 0
  while (!db.preparePlaylistQuery(query).ready) {
    assert.equal(db.sql.isTransaction, false)
    assert.ok(++turns < 40)
  }
  assert.ok(turns >= 9)
  assert.equal(
    checkedAssignmentPlan,
    true,
    'group assignment seeks private rowids, not the full generation'
  )
  const before = db.queryTracks(query)
  db.patchTracks([
    { id: 'local0', expectedVersion: before.versions.local0, patch: { title: 'Changed' } }
  ])
  assert.throws(() => db.queryTracks({ ...query, contentRevision: before.revision }), /变化/)
  db.sql.exec(
    `CREATE TEMP TRIGGER aggregate_failure BEFORE UPDATE OF group_seq ON aggregate_inputs WHEN new.seq=250 BEGIN SELECT RAISE(ABORT,'aggregate injected fault'); END`
  )
  assert.throws(() => db.queryTracks(query), /injected fault/)
  db.sql.exec('DROP TRIGGER aggregate_failure')
  const after = all(db, query)
  assert.equal(after.total, 607)
  assert.equal(after.tracks[0].title, 'Changed')
  db.syncPlaylistView({ kind: 'drop', id: query.playlistView! })
  assert.throws(() => db.queryTracks(query), /expired/)
  while (db.needsQueryMaintenance) db.maintainQueryState()
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_inputs').get()?.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_groups').get()?.n, 0)
})

test('remote batch failure rolls back the entire window and retries with exact snapshots and duplicate occurrences', async (t) => {
  const inputs = Array.from({ length: 605 }, (_, i) =>
    track(`ncm:${i}`, {
      source: 'ncm',
      title: `雪 "quoted" \\ ${i % 3}`,
      album: 'Album\n雪',
      duration: i % 2 ? 0 : 180
    })
  )
  inputs.splice(203, 0, inputs[17])
  const { db, query } = await fixture(t, inputs),
    metadata = db.getMetadata()
  db.sql.exec(`CREATE TEMP TRIGGER remote_batch_fault BEFORE INSERT ON playlist_members
    WHEN new.seq=250 BEGIN SELECT RAISE(ABORT,'remote batch fault'); END`)
  assert.throws(() => db.queryTracks(query), /remote batch fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_members').get()?.n, 200)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_inputs').get()?.n, 0)
  assert.deepEqual(db.getMetadata(), metadata)
  db.sql.exec('DROP TRIGGER remote_batch_fault')

  const actual = all(db, query),
    expected = buildAggregateRows({ tracks: inputs })
  assert.deepEqual(
    actual.tracks.map((track) => [track.id, track.title, track.album, track.duration]),
    expected.map(({ selectedVariant: { track } }) => [
      track.id,
      track.title,
      track.album,
      track.duration
    ])
  )
  assert.equal(actual.aggregate!.memberCount, 606)
  assert.equal(actual.metadata.find((row) => row.anchorTrackId === 'ncm:17')?.variantCount, 2)
  const variants = db.queryTracks({
    ...query,
    aggregate: { variantRow: actual.metadata.find((row) => row.anchorTrackId === 'ncm:17')!.rowId }
  })
  assert.deepEqual(variants.entryIds, ['17', '203'])
  assert.deepEqual(db.getMetadata(), metadata)
})

test('aggregate input batch failure leaves no partial window and rebuilds exact recording groups', async (t) => {
  const inputs = Array.from({ length: 607 }, (_, i) => track(`local${i}`, { title: `Song ${i}` }))
  const { db, query } = await fixture(t, inputs),
    metadata = db.getMetadata()
  db.sql.exec(`CREATE TEMP TRIGGER input_batch_fault BEFORE INSERT ON aggregate_inputs
    WHEN new.seq=250 BEGIN SELECT RAISE(ABORT,'input batch fault'); END`)
  assert.throws(() => db.queryTracks(query), /input batch fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_inputs').get()?.n, 200)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_groups').get()?.n, 0)
  db.sql.exec('DROP TRIGGER input_batch_fault')
  const actual = all(db, query)
  assert.deepEqual(
    actual.tracks.map((track) => track.id),
    inputs.map((track) => track.id)
  )
  assert.deepEqual(
    actual.entryIds,
    inputs.map((_, index) => String(index))
  )
  assert.equal(actual.aggregate!.memberCount, inputs.length)
  assert.deepEqual(db.getMetadata(), metadata)
})

test('group header batch failure rolls back its assignments and headers together', async (t) => {
  const inputs = Array.from({ length: 607 }, (_, i) =>
    track(`local${i}`, { title: `Song ${String(i).padStart(4, '0')}` })
  )
  const { db, query } = await fixture(t, inputs)
  db.sql.exec(`CREATE TEMP TRIGGER header_batch_fault BEFORE INSERT ON aggregate_groups
    WHEN new.seq=250 BEGIN SELECT RAISE(ABORT,'header batch fault'); END`)
  assert.throws(() => db.queryTracks(query), /header batch fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_groups').get()?.n, 200)
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM aggregate_inputs WHERE group_seq IS NOT NULL').get()
      ?.n,
    200
  )
  db.sql.exec('DROP TRIGGER header_batch_fault')
  const actual = all(db, query)
  assert.deepEqual(
    actual.tracks.map((track) => track.id),
    inputs.map((track) => track.id)
  )
  assert.ok(actual.metadata.every((row) => row.variantCount === 1))
})

test('aggregate request validation rejects malformed, oversized and incompatible scopes', () => {
  const base = { playlistView: 'view', sort: 'playlist' }
  for (const aggregate of [
    null,
    [],
    { unknown: 1 },
    { hiddenSources: 'local' },
    { hiddenSources: [1] },
    { hiddenSources: ['x'.repeat(32769)] },
    { variantPreferences: [] },
    { variantPreferences: { one: 1 } },
    { variantPreferences: { '': 'local' } },
    { variantRow: 1 },
    { variantRow: '-1' },
    { variantRow: '01' },
    { variantRow: '80000000' },
    { sourceCounts: 'yes' },
    { sourceCounts: true, variantRow: '0' },
    { hiddenSources: Array(700).fill('x'.repeat(32000)) }
  ])
    assert.throws(() => validateLibraryQuery({ ...base, aggregate }), /aggregate/)
  for (const scope of [
    { artist: 'Artist' },
    { direction: 'desc' },
    { ids: ['one'] },
    { sort: 'title' }
  ])
    assert.throws(() => validateLibraryQuery({ ...base, ...scope, aggregate: {} }), /aggregate/)
  assert.throws(() => validateLibraryQuery({ aggregate: {} }), /aggregate/)
  validateLibraryQuery({
    ...base,
    aggregate: { hiddenSources: ['local'], variantPreferences: { one: 'ncm' }, variantRow: '0' },
    contentRevision: 1,
    offset: 200,
    limit: 200
  })
})

test('partial legacy metadata groups and searches by the same fallback labels as displayed pages', async (t) => {
  const { db, owner } = await fixture(t, [])
  const records = [
    { id: 'one', filePath: 'D:/One.flac', fileName: 'Same.flac' },
    { id: 'two', filePath: 'D:/Same.flac' }
  ]
  db.replaceDocument({ version: 2, revision: 0, tracks: records, folders: [], exclusions: [] })
  await owner.setPlaylist(
    { id: 'p', trackIds: records.map((item) => item.id) },
    { revision: 1, versions: [], preserveSources: true }
  )
  const query: LibraryQuery = {
    playlistView: owner.state.value.id!,
    sort: 'playlist',
    aggregate: {}
  }
  const page = db.queryTracks({ ...query, search: '未知艺术家 未知专辑' })
  assert.equal(page.total, 1)
  assert.equal(page.aggregate!.rows[0].variantCount, 2)
  const expected = buildAggregateRows({ tracks: records.map(libraryTrack) })
  assert.equal(page.tracks[0].id, expected[0].selectedVariant.track.id)
})

test('source summaries do not build recording identities or groups, and large variant sorts yield per window', async (t) => {
  const { db, query } = await fixture(
    t,
    Array.from({ length: 605 }, (_, i) => track(`local${i}`))
  )
  const sources = db.queryTracks({ ...query, aggregate: { sourceCounts: true } })
  assert.equal(sources.total, 1)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM aggregate_inputs').get()?.n, 0)
  const page = db.queryTracks(query)
  let turns = 0
  const variants = { ...query, aggregate: { variantRow: page.aggregate!.rows[0].rowId } }
  while (!db.preparePlaylistQuery(variants).ready) {
    assert.equal(db.sql.isTransaction, false)
    assert.ok(++turns < 20)
  }
  assert.ok(turns >= 7)
  assert.equal(db.queryTracks(variants).total, 605)
})

test('recording views defer detail columns/FTS, then build ordinary search in atomic bounded batches', async (t) => {
  const inputs = Array.from({ length: 607 }, (_, i) =>
    track(`local${i}`, { title: `月光 ${i}`, fileName: `filename${i}.flac` })
  )
  inputs.push(track('ncm:8', { source: 'ncm', title: 'Remote recording' }))
  const { db, query } = await fixture(t, inputs)
  assert.equal(db.queryTracks({ ...query, search: 'artist' }).total, 608)
  assert.equal(db.queryTracks({ ...query, aggregate: { sourceCounts: true } }).total, 2)
  const indexed = () =>
    Number(
      db.sql.prepare('SELECT count(*) AS n FROM playlist_members WHERE details_ready=1').get()?.n
    )
  const matches = () =>
    Number(
      db.sql
        .prepare("SELECT count(*) AS n FROM playlist_search WHERE playlist_search MATCH 'artist'")
        .get()?.n
    )
  assert.equal(indexed(), 0)
  assert.equal(matches(), 0)
  const search = { ...query, aggregate: undefined, search: 'artist' }
  const first = db.preparePlaylistQuery(search)
  assert.equal(first.ready, false)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(indexed(), 200)
  assert.equal(matches(), 200)
  db.sql.exec(`CREATE TEMP TRIGGER search_fault BEFORE INSERT ON playlist_members
    WHEN new.seq=250 BEGIN SELECT RAISE(ABORT,'search index fault'); END`)
  assert.throws(() => db.preparePlaylistQuery(search), /search index fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(indexed(), 200)
  assert.equal(matches(), 200)
  db.sql.exec('DROP TRIGGER search_fault')

  db.syncPlaylistView({ kind: 'begin', id: 'unused-search', versions: [], preserveSources: true })
  db.syncPlaylistView({
    kind: 'append',
    id: 'unused-search',
    sequence: 1,
    entries: [
      { id: 'local0' },
      { id: 'ncm:8', snapshot: inputs.at(-1)! as unknown as LibraryTrackRecord }
    ]
  })
  db.syncPlaylistView({ kind: 'commit', id: 'unused-search', sequence: 2 })
  assert.equal(
    db.queryTracks({
      playlistView: 'unused-search',
      sort: 'playlist',
      aggregate: { sourceCounts: true }
    }).total,
    2
  )
  db.syncPlaylistView({ kind: 'drop', id: 'unused-search' })
  while (db.needsQueryMaintenance) db.maintainQueryState()
  assert.equal(
    matches(),
    200,
    'retiring never-indexed local/remote members must not delete FTS entries'
  )

  // Refreshing an indexed member removes only its existing FTS entry.
  const version = db.getTracksByIds(['local0']).versions.local0
  db.patchTracks([{ id: 'local0', expectedVersion: version, patch: { title: 'Changed title' } }])
  assert.throws(
    () => db.preparePlaylistQuery({ ...search, contentRevision: first.revision }, first.token),
    /变化/
  )
  let previous = indexed(),
    turns = 0
  while (!db.preparePlaylistQuery(search).ready) {
    const next = indexed()
    assert.ok(next - previous <= 200)
    assert.equal(db.sql.isTransaction, false)
    previous = next
    assert.ok(++turns < 15)
  }
  assert.equal(indexed(), 608)
  assert.equal(matches(), 608)
  assert.equal(db.queryTracks(search).total, 608)
  assert.equal(db.queryTracks({ ...search, search: 'changedtitle' }).total, 1)
  assert.equal(db.queryTracks({ ...search, search: 'filename606', searchFileName: true }).total, 1)
  db.syncPlaylistView({ kind: 'drop', id: query.playlistView! })
  while (db.needsQueryMaintenance) db.maintainQueryState()
  assert.equal(matches(), 0)
})

test('direct ordinary search and queue callers initialize deferred FTS and retain duplicate occurrences', async (t) => {
  const one = track('one')
  const { db, query } = await fixture(t, [one, one, track('ncm:9', { source: 'ncm' })])
  const search = { ...query, aggregate: undefined, search: 'artist' }
  const queue = db.createLibraryQueue({ ...search, playlistEntryId: '1' }, 'one')
  assert.equal(queue.total, 3)
  assert.equal(queue.index, 1)
  assert.deepEqual(
    db.readLibraryQueue(queue.id).items.map((item) => item.track?.id),
    ['one', 'one', 'ncm:9']
  )
  assert.equal(db.queryTracks(search).total, 3)
  assert.equal(db.queryTracks(query).aggregate!.rows[0].variantCount, 3)
})

test('ordinary sorting, filtering and search after lean recording preparation match eager detail views', async (t) => {
  const inputs = Array.from({ length: 407 }, (_, i) =>
    track(`${i % 3 ? 'local' : 'ncm'}:${i}`, {
      source: i % 3 ? 'local' : 'ncm',
      title: `Song ${407 - i}`,
      album: `Album ${i % 7}`,
      duration: i,
      sampleRate: i % 2 ? 44100 : 96000,
      addedAt: i,
      fileName: `filename${i}.flac`,
      format: i % 2 ? 'flac' : 'mp3',
      discNumber: i % 3,
      trackNumber: i % 11
    })
  )
  inputs.push(inputs[3])
  const { db, query } = await fixture(t, inputs)
  db.queryTracks(query)
  db.syncPlaylistView({ kind: 'begin', id: 'eager', versions: [] })
  let sequence = 0
  for (let offset = 0; offset < inputs.length; offset += 200)
    db.syncPlaylistView({
      kind: 'append',
      id: 'eager',
      sequence: ++sequence,
      entries: inputs
        .slice(offset, offset + 200)
        .map((track) => ({ id: track.id, snapshot: track as unknown as LibraryTrackRecord }))
    })
  db.syncPlaylistView({ kind: 'commit', id: 'eager', sequence: ++sequence })
  for (const scope of [
    { sort: 'duration', direction: 'desc', offset: 200 },
    { sort: 'title', offset: 200 },
    { sort: 'trackNumber', offset: 200 },
    { sort: 'album', offset: 200 },
    { filters: { provider: 'ncm' } },
    { filters: { sampleRate: 96000 } },
    { search: 'song1' },
    { search: 'filename406', searchFileName: true }
  ] as LibraryQuery[]) {
    const actual = db.queryTracks({ ...query, ...scope, aggregate: undefined })
    const expected = db.queryTracks({ playlistView: 'eager', sort: 'playlist', ...scope })
    assert.deepEqual(actual, expected, JSON.stringify(scope))
  }
})
