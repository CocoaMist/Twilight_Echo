import assert from 'node:assert/strict'
import { createWriteStream, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openLibraryDatabase } from '../src/main/library/libraryDatabase.ts'
import { versionSourceKey } from '../src/shared/trackSourceIdentity.ts'
import type { LibraryQuery } from '../src/shared/libraryDatabase.ts'

// This measures a synthetic *database* workload. It deliberately does not label
// generated metadata as 300,000 real, scanned audio files or UI acceptance.
const audioFiles = Number(process.argv[2] ?? 300_000)
if (!Number.isSafeInteger(audioFiles) || audioFiles < 1)
  throw new Error('Expected a positive physical-file count')
const evidence = process.argv[3] ? resolve(process.argv[3]) : null
const root = mkdtempSync(join(tmpdir(), 'twilight-library-benchmark-'))
let database: Awaited<ReturnType<typeof openLibraryDatabase>> | null = null
const started = performance.now()
let logicalTracks = 0
let expectedDuration = 0
const now = () => performance.now()
const measured = <T>(operation: () => T) => {
  const start = now()
  const value = operation()
  return { ms: now() - start, value }
}
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
async function freezeQueue(query: LibraryQuery, selectedId?: string, playbackQueueId?: string) {
  const start = now(),
    beginning = measured(() => database!.beginLibraryQueueBuild(query, selectedId)),
    batches: number[] = [],
    probes: number[] = []
  try {
    for (;;) {
      const batch = measured(() => database!.advanceLibraryQueueBuild(beginning.value))
      batches.push(batch.ms)
      assert.equal(database!.sql.isTransaction, false)
      if (batches.length % 20 === 1) {
        const probe = measured(() => {
          assert.equal(
            database!.queryTracks({ sort: 'insertion', direction: 'desc', limit: 1 }).total,
            logicalTracks
          )
          assert.equal(database!.getTracksByIds(['track:0:0']).tracks.length, 1)
          if (playbackQueueId)
            assert.equal(database!.readLibraryQueue(playbackQueueId, 0, 1).items.length, 1)
        })
        probes.push(probe.ms)
      }
      if (batch.value.ready)
        return {
          value: batch.value.queue,
          ms: now() - start,
          beginMs: beginning.ms,
          batches,
          probes,
          batchP95Ms: p95(batches),
          batchMaxMs: Math.max(...batches),
          probeP95Ms: p95(probes),
          probeMaxMs: Math.max(...probes)
        }
      // Direct SQL fairness probes, not renderer or IPC latency measurements.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  } catch (error) {
    database!.abandonLibraryQueueBuild(beginning.value)
    throw error
  }
}
try {
  const json = join(root, 'music-library.json'),
    output = createWriteStream(json)
  const append = async (value: string) => {
    if (!output.write(value)) await once(output, 'drain')
  }
  await append(
    `{"version":2,"revision":17,"folders":[${JSON.stringify(root)}],"exclusions":[],"tracks":[`
  )
  let chunk = ''
  for (let file = 0; file < audioFiles; file++) {
    const segments = file % 10 === 0 ? 3 : 1,
      filePath = join(root, `album-${Math.floor(file / 12)}`, `${file}.flac`)
    for (let segment = 0; segment < segments; segment++) {
      const track = {
        id: `track:${file}:${segment}`,
        title: `晴天 ${file} ${segment}`,
        artist: `周杰伦 ${file % 100}`,
        album: `专辑 ${Math.floor(file / 12)}`,
        genre: 'Pop / 华语',
        filePath,
        fileName: `${file}.flac`,
        duration: segments > 1 ? 60 : 180 + (file % 200),
        addedAt: 1234 + file,
        sampleRate: 44100,
        bitDepth: 16,
        format: 'FLAC',
        extension: { preserved: 'x'.repeat(128) },
        ...(segments > 1
          ? {
              trackNumber: segment + 1,
              cueSheetPath: filePath.replace(/\.flac$/, '.cue'),
              cueRange: { startSeconds: segment * 60, endSeconds: (segment + 1) * 60 }
            }
          : {})
      }
      chunk += `${logicalTracks ? ',' : ''}${JSON.stringify(track)}`
      expectedDuration += track.duration
      logicalTracks++
    }
    if (chunk.length >= 64 * 1024) {
      await append(chunk)
      chunk = ''
    }
  }
  await append(`${chunk}]}`)
  output.end()
  await once(output, 'finish')
  const fixtureMs = now() - started,
    jsonBytes = statSync(json).size
  const migrationStart = now()
  database = await openLibraryDatabase(json)
  const migrationMs = now() - migrationStart
  const metadata = database.getMetadata()
  assert.equal(metadata.trackCount, logicalTracks)
  assert.equal(metadata.fileCount, audioFiles)
  assert.equal(metadata.revision, 17)
  assert.equal(database.getTracksByIds(['track:0:0']).tracks[0].addedAt, 1234)
  assert.equal(
    (
      database.getTracksByIds([`track:${audioFiles - 1}:0`]).tracks[0].extension as {
        preserved: string
      }
    ).preserved.length,
    128
  )
  // Measure home before warming any collection caches. These are the exact
  // bounded reads used by the default dashboard, not renderer/UI timings.
  const readDashboard = () => {
    const firstRead = measured(() => database!.queryTracks({ sort: 'playlist', limit: 6 }))
    const first = firstRead.value
    const tail = measured(() =>
      database!.queryTracks({
        sort: 'insertion',
        direction: 'desc',
        limit: 6,
        contentRevision: first.revision
      })
    )
    const albumRead = measured(() =>
      database!.queryCollections('albums', {
        collectionSort: 'trackCount',
        direction: 'desc',
        limit: 5,
        contentRevision: first.revision
      })
    )
    const artistRead = measured(() =>
      database!.queryCollections('artists', {
        collectionCountOnly: true,
        contentRevision: first.revision
      })
    )
    const albums = albumRead.value,
      artists = artistRead.value
    assert.equal(first.total, logicalTracks)
    assert.equal(first.totalDuration, expectedDuration)
    assert.equal(albums.total, Math.ceil(audioFiles / 12))
    assert.equal(artists.total, Math.min(100, audioFiles))
    const expectedRecent: string[] = []
    for (let file = audioFiles - 1; file >= 0 && expectedRecent.length < 6; file--)
      for (
        let segment = file % 10 === 0 ? 2 : 0;
        segment >= 0 && expectedRecent.length < 6;
        segment--
      )
        expectedRecent.push(`track:${file}:${segment}`)
    assert.deepEqual(
      tail.value.tracks.map((track) => track.id),
      expectedRecent
    )
    assert.ok(albums.items.length <= 5 && albums.items.every((album) => !('tracks' in album)))
    return {
      firstMs: firstRead.ms,
      tailMs: tail.ms,
      albumsMs: albumRead.ms,
      artistCountMs: artistRead.ms,
      shelfTrackObjects: first.tracks.length + tail.value.tracks.length
    }
  }
  const dashboardCold = measured(readDashboard)
  const readDashboardHistory = () => {
    const count = Math.min(7, audioFiles)
    const ids = Array.from({ length: count }, (_, i) => `track:${audioFiles - 1 - i}:0`)
    const matched = database!.lookupPlaylistTracks(
      {
        entries: ids.map((id, i) => ({ id: `history:${i}`, sourceIds: ['missing', id] })),
        versions: [],
        resolution: 'recent'
      },
      metadata.revision
    )
    assert.deepEqual(matched.ids, ids)
    const hydrated = database!.getTracksByIds(ids, metadata.revision)
    assert.equal(hydrated.tracks.length, count)
    return count
  }
  const dashboardHistoryCold = measured(readDashboardHistory)
  const coldPage = measured(() => database!.queryTracks())
  assert.equal(coldPage.value.tracks.length, Math.min(200, logicalTracks))
  const unifiedQuery = {
    sort: 'unifiedSearch' as const,
    search: 'zjl',
    searchFileName: true,
    limit: 100
  }
  const unifiedCold = measured(() => database!.queryTracks(unifiedQuery))
  assert.equal(unifiedCold.value.total, logicalTracks)
  assert.equal(unifiedCold.value.tracks.length, Math.min(100, logicalTracks))
  const preferredCueId = `track:${Math.floor((audioFiles - 1) / 10) * 10}:2`
  const preferredCue = database.getTracksByIds([preferredCueId]).tracks[0]
  const preferredQuery = {
    ...unifiedQuery,
    preferredSources: [versionSourceKey({ ...preferredCue, source: 'local' })]
  }
  const unifiedPreferred = measured(() => database!.queryTracks(preferredQuery))
  assert.equal(unifiedPreferred.value.tracks[0].id, preferredCueId)
  assert.equal(unifiedPreferred.value.total, logicalTracks)
  const unifiedFileName = measured(() =>
    database!.queryTracks({ ...unifiedQuery, search: `${audioFiles - 1}.flac` })
  )
  assert.equal(unifiedFileName.value.tracks[0].id, `track:${audioFiles - 1}:0`)
  const samples: Record<string, number[]> = {
    indexedPage: [],
    shortChinese: [],
    trigram: [],
    pinyin: [],
    lastPlayed: [],
    playlistExactPaths: [],
    playlistRelativePaths: [],
    playlistExactIds: [],
    playlistRecordingFallback: [],
    unifiedDeepPage: [],
    unifiedPreferredDeepPage: [],
    streamingAlbumsDeepPage: [],
    streamingArtistsPage: [],
    dashboardShelves: [],
    dashboardTail: [],
    dashboardHistory: []
  }
  const albumCount = Math.ceil(audioFiles / 12)
  const streamingAlbumQuery = {
    search: '专辑 zj',
    collectionSearchMode: 'albumTerms' as const,
    limit: 30
  }
  const streamingArtistQuery = {
    search: '周杰伦',
    collectionSearchMode: 'artistName' as const,
    limit: 30
  }
  const streamingAlbumsCold = measured(() =>
    database!.queryCollections('albums', streamingAlbumQuery)
  )
  const streamingArtistsCold = measured(() =>
    database!.queryCollections('artists', streamingArtistQuery)
  )
  assert.equal(streamingAlbumsCold.value.total, albumCount)
  assert.equal(streamingArtistsCold.value.total, Math.min(100, audioFiles))
  assert.ok(
    streamingAlbumsCold.value.items.length <= 30 && streamingArtistsCold.value.items.length <= 30
  )
  assert.ok(streamingAlbumsCold.value.items.every((item) => !('tracks' in item)))
  const historyCount = Math.min(audioFiles, 10_000)
  const historyStart = now()
  database.syncListeningHistory({ kind: 'begin', id: 'benchmark-history', mode: 'replace' })
  let historySequence = 0
  for (let offset = 0; offset < historyCount; offset += 1000)
    database.syncListeningHistory({
      kind: 'append',
      id: 'benchmark-history',
      sequence: ++historySequence,
      entries: Array.from({ length: Math.min(1000, historyCount - offset) }, (_, i) => ({
        id: `track:${offset + i}:0`,
        lastPlayed: 1000 + offset + i
      }))
    })
  const history = database.syncListeningHistory({
    kind: 'commit',
    id: 'benchmark-history',
    sequence: ++historySequence
  })
  const historyProjectionMs = now() - historyStart
  const historyDeltaStart = now()
  database.syncListeningHistory({
    kind: 'begin',
    id: 'benchmark-history-delta',
    mode: 'patch',
    expectedRevision: history.revision
  })
  database.syncListeningHistory({
    kind: 'append',
    id: 'benchmark-history-delta',
    sequence: 1,
    entries: [{ id: 'track:0:0', lastPlayed: 1_000_000 }]
  })
  const historyDelta = database.syncListeningHistory({
    kind: 'commit',
    id: 'benchmark-history-delta',
    sequence: 2
  })
  const historyDeltaMs = now() - historyDeltaStart
  const historyFirst = measured(() =>
    database!.queryTracks({
      sort: 'lastPlayed',
      direction: 'desc',
      historyRevision: historyDelta.revision
    })
  )
  assert.equal(historyFirst.value.tracks[0].id, 'track:0:0')
  assert.equal(database.getMetadata().revision, metadata.revision)
  for (let index = 0; index < 30; index++) {
    const home = measured(readDashboard)
    samples.dashboardShelves.push(home.ms)
    samples.dashboardTail.push(home.value.tailMs)
    samples.dashboardHistory.push(measured(readDashboardHistory).ms)
    const deepOffset = Math.max(0, logicalTracks - 100 - index * 100)
    const unified = measured(() => database!.queryTracks({ ...unifiedQuery, offset: deepOffset }))
    const preferred = measured(() =>
      database!.queryTracks({ ...preferredQuery, offset: deepOffset })
    )
    assert.equal(unified.value.total, logicalTracks)
    assert.equal(preferred.value.total, logicalTracks)
    assert.ok(unified.value.tracks.length <= 100 && preferred.value.tracks.length <= 100)
    samples.unifiedDeepPage.push(unified.ms)
    samples.unifiedPreferredDeepPage.push(preferred.ms)
    const albumPage = measured(() =>
      database!.queryCollections('albums', {
        ...streamingAlbumQuery,
        offset: Math.max(0, albumCount - 30 - index * 30)
      })
    )
    const artistPage = measured(() =>
      database!.queryCollections('artists', { ...streamingArtistQuery, offset: 60 })
    )
    assert.equal(albumPage.value.total, albumCount)
    assert.equal(artistPage.value.total, Math.min(100, audioFiles))
    assert.ok(albumPage.value.items.length <= 30 && artistPage.value.items.length <= 30)
    samples.streamingAlbumsDeepPage.push(albumPage.ms)
    samples.streamingArtistsPage.push(artistPage.ms)
    const files = Array.from(
      { length: Math.min(200, audioFiles) },
      (_, i) => (audioFiles - 1 - index * 200 - i + audioFiles * 30) % audioFiles
    )
    const expected = files.map((file) => `track:${file}:${file % 10 === 0 ? 2 : 0}`)
    const exactPaths = measured(() =>
      database!.lookupTracksByPaths(
        files.map((file) => join(root, `album-${Math.floor(file / 12)}`, `${file}.flac`)),
        metadata.revision
      )
    )
    assert.deepEqual(exactPaths.value.ids, expected)
    samples.playlistExactPaths.push(exactPaths.ms)
    const relativePaths = measured(() =>
      database!.lookupTracksByPaths(
        files.map((file) => `${file}.flac`),
        metadata.revision
      )
    )
    assert.deepEqual(
      relativePaths.value.ids,
      files.map((file, i) => (file % 10 === 0 ? null : expected[i]))
    )
    samples.playlistRelativePaths.push(relativePaths.ms)
    const exactIds = measured(() =>
      database!.lookupPlaylistTracks(
        {
          entries: expected.map((id) => ({ id })),
          versions: []
        },
        metadata.revision
      )
    )
    assert.deepEqual(exactIds.value.ids, expected)
    samples.playlistExactIds.push(exactIds.ms)
    const recordings = measured(() =>
      database!.lookupPlaylistTracks(
        {
          entries: files.map((file) => {
            const segment = file % 10 === 0 ? 2 : 0,
              id = `remote:${file}:${segment}`
            return {
              id,
              snapshot: {
                id,
                source: 'remote',
                title: `晴天 ${file} ${segment}`,
                artist: `周杰伦 ${file % 100}`,
                album: `专辑 ${Math.floor(file / 12)}`,
                duration: file % 10 === 0 ? 60 : 180 + (file % 200)
              }
            }
          }),
          versions: []
        },
        metadata.revision
      )
    )
    assert.deepEqual(recordings.value.ids, expected)
    assert.ok(recordings.value.ids.length <= 200 && !('tracks' in recordings.value))
    samples.playlistRecordingFallback.push(recordings.ms)
    const offset = Math.min(Math.max(0, logicalTracks - 200), index * 200)
    samples.indexedPage.push(measured(() => database!.queryTracks({ sort: 'addedAt', offset })).ms)
    samples.shortChinese.push(
      measured(() => database!.queryTracks({ search: '晴', sort: 'duration' })).ms
    )
    samples.trigram.push(
      measured(() => database!.queryTracks({ search: `${audioFiles - 1}`, sort: 'duration' })).ms
    )
    samples.pinyin.push(
      measured(() => database!.queryTracks({ search: 'zjl', sort: 'duration' })).ms
    )
    samples.lastPlayed.push(
      measured(() =>
        database!.queryTracks({
          sort: 'lastPlayed',
          direction: 'desc',
          historyRevision: historyDelta.revision,
          offset
        })
      ).ms
    )
  }
  const duplicateProjection = measured(() => {
    let cursor = 0,
      rows = 0,
      pages = 0,
      maximumResponse = 0
    for (;;) {
      const page = database!.readDuplicateCandidates(cursor, 1000, metadata.revision)
      rows += page.items.length
      pages++
      maximumResponse = Math.max(maximumResponse, page.items.length)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    assert.equal(rows, logicalTracks)
    assert.ok(maximumResponse <= 1000)
    return { rows, pages, maximumResponse }
  })
  const collections = measured(() => database!.queryCollections('albums'))
  const queue = await freezeQueue({ sort: 'addedAt' })
  assert.equal(database.readLibraryQueue(queue.value.id).items.length, Math.min(200, logicalTracks))
  const playlistView = measured(() => {
    console.error('[benchmark] uploading playlist membership with a seek cursor')
    database!.syncPlaylistView({
      kind: 'begin',
      id: 'benchmark-view',
      versions: [],
      preserveSources: true
    })
    let sequence = 0,
      cursor = 0
    for (let offset = 0; offset < logicalTracks; offset += 200) {
      const rows = database!.sql
        .prepare('SELECT id,seq FROM tracks WHERE seq>? ORDER BY seq LIMIT 200')
        .all(cursor)
      cursor = Number(rows.at(-1)!.seq)
      database!.syncPlaylistView({
        kind: 'append',
        id: 'benchmark-view',
        sequence: ++sequence,
        entries: rows.map((row) => ({ id: String(row.id) }))
      })
    }
    database!.syncPlaylistView({
      kind: 'append',
      id: 'benchmark-view',
      sequence: ++sequence,
      entries: [
        { id: 'track:0:0' },
        {
          id: 'ncm:benchmark',
          snapshot: {
            id: 'ncm:benchmark',
            filePath: '',
            title: '远程样本',
            artist: '网络歌手',
            album: '远程专辑',
            source: 'ncm',
            duration: 10
          }
        }
      ]
    })
    database!.syncPlaylistView({ kind: 'commit', id: 'benchmark-view', sequence: ++sequence })
  })
  const playlistQuery = { playlistView: 'benchmark-view', sort: 'playlist' as const }
  console.error('[benchmark] reading cold playlist view')
  const preparationStart = now(),
    preparationSamples: number[] = [],
    preparationProbeSamples: number[] = []
  let prepared = false
  while (!prepared) {
    const step = measured(() => database!.preparePlaylistQuery(playlistQuery))
    preparationSamples.push(step.ms)
    prepared = step.value.ready
    assert.equal(database!.sql.isTransaction, false)
    if (preparationSamples.length % 20 === 1) {
      const probe = measured(() => {
        const page = database!.queryTracks({ sort: 'insertion', direction: 'desc', limit: 1 })
        assert.equal(page.total, logicalTracks)
        assert.equal(database!.getTracksByIds(['track:0:0']).tracks.length, 1)
        assert.equal(database!.readLibraryQueue(queue.value.id, 0, 1).items.length, 1)
      })
      preparationProbeSamples.push(probe.ms)
    }
    // Same transaction boundary used by the worker's cooperative scheduler.
    // These probes are direct SQL, not measurements of the IPC or renderer.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const preparedPage = measured(() => database!.queryTracks(playlistQuery))
  const viewCold = { value: preparedPage.value, ms: now() - preparationStart }
  console.error('[benchmark] cold playlist view ms:', viewCold.ms)
  assert.equal(viewCold.value.total, logicalTracks + 2)
  const viewWarmSamples: number[] = [],
    viewSearchSamples: number[] = []
  for (let i = 0; i < 30; i++) {
    const page = measured(() =>
      database!.queryTracks({
        ...playlistQuery,
        offset: Math.max(0, logicalTracks - 198 - i * 200)
      })
    )
    assert.equal(page.value.total, logicalTracks + 2)
    assert.ok(
      page.value.tracks.length <= 200 && page.value.entryIds?.length === page.value.tracks.length
    )
    viewWarmSamples.push(page.ms)
    const search = measured(() =>
      database!.queryTracks({
        ...playlistQuery,
        search: 'zjl',
        sort: 'duration',
        offset: Math.min(i * 200, Math.max(0, logicalTracks - 200))
      })
    )
    assert.equal(search.value.total, logicalTracks + 1)
    viewSearchSamples.push(search.ms)
  }
  const viewQueue = await freezeQueue(
    { ...playlistQuery, playlistEntryId: String(logicalTracks) },
    'track:0:0',
    queue.value.id
  )
  console.error('[benchmark] playlist queue ms:', viewQueue.ms)
  assert.equal(viewQueue.value.total, logicalTracks + 2)
  assert.equal(viewQueue.value.index, logicalTracks)
  const firstVersion = database!.getTracksByIds(['track:0:0']).versions['track:0:0']
  database!.patchTracks([
    { id: 'track:0:0', expectedVersion: firstVersion, patch: { title: '更新后的曲目' } }
  ])
  const viewAfterEdit = measured(() => database!.queryTracks(playlistQuery))
  assert.equal(viewAfterEdit.value.tracks[0].title, '更新后的曲目')
  const report = {
    workload: 'synthetic database migration/query workload; no real media scan or UI measurement',
    querySequence:
      'home shelves first, then catalog searches; interleaved samples evict order windows while aggregate caches may remain warm',
    timestamp: new Date().toISOString(),
    runtime: process.versions,
    audioFileRecords: audioFiles,
    logicalTrackRecords: logicalTracks,
    jsonBytes,
    exceedsLegacy100MiB: jsonBytes > 100 * 1024 * 1024,
    fixtureMs,
    migrationMs,
    dashboardColdShelvesMs: dashboardCold.ms,
    dashboardColdTailMs: dashboardCold.value.tailMs,
    dashboardColdFirstMs: dashboardCold.value.firstMs,
    dashboardColdAlbumsMs: dashboardCold.value.albumsMs,
    dashboardColdArtistCountMs: dashboardCold.value.artistCountMs,
    dashboardColdHistoryMs: dashboardHistoryCold.ms,
    dashboardShelfTrackObjects: dashboardCold.value.shelfTrackObjects,
    dashboardHistoryTrackObjects: dashboardHistoryCold.value,
    coldTitleFirstPageMs: coldPage.ms,
    unifiedColdPageMs: unifiedCold.ms,
    unifiedPreferredColdPageMs: unifiedPreferred.ms,
    unifiedFileNamePageMs: unifiedFileName.ms,
    unifiedPreferredCueId: preferredCueId,
    maxUnifiedResponseTracks: unifiedCold.value.tracks.length,
    streamingAlbumsColdMs: streamingAlbumsCold.ms,
    streamingArtistsColdMs: streamingArtistsCold.ms,
    streamingAlbumCount: albumCount,
    streamingArtistCount: streamingArtistsCold.value.total,
    maxStreamingCollectionResponseItems: Math.max(
      streamingAlbumsCold.value.items.length,
      streamingArtistsCold.value.items.length
    ),
    queryP95Ms: Object.fromEntries(
      Object.entries(samples).map(([name, values]) => [name, p95(values)])
    ),
    querySamplesMs: samples,
    historyProjectionRows: historyCount,
    historyProjectionMs,
    historyOneTrackDeltaMs: historyDeltaMs,
    historyColdPageMs: historyFirst.ms,
    duplicateProjectionRows: duplicateProjection.value.rows,
    duplicateProjectionPages: duplicateProjection.value.pages,
    duplicateProjectionMs: duplicateProjection.ms,
    maxDuplicateResponseItems: duplicateProjection.value.maximumResponse,
    playlistPathBatchSize: Math.min(200, audioFiles),
    maxPlaylistIdentityResponseItems: Math.min(200, audioFiles),
    albumSummaryMs: collections.ms,
    albumCount: collections.value.total,
    queueSnapshotMs: queue.ms,
    queuePlanMs: queue.beginMs,
    queueBuildBatches: queue.batches.length,
    queueBuildBatchP95Ms: queue.batchP95Ms,
    queueBuildBatchMaxMs: queue.batchMaxMs,
    queueBuildBatchSamplesMs: queue.batches,
    queueBuildInterleavedReadP95Ms: queue.probeP95Ms,
    queueBuildInterleavedReadMaxMs: queue.probeMaxMs,
    queueBuildInterleavedReadSamplesMs: queue.probes,
    queueEntries: queue.value.total,
    playlistViewUploadMs: playlistView.ms,
    playlistViewColdMs: viewCold.ms,
    playlistViewPreparationBatches: preparationSamples.length,
    playlistViewPreparationBatchP95Ms: p95(preparationSamples),
    playlistViewPreparationBatchMaxMs: Math.max(...preparationSamples),
    playlistViewPreparationBatchSamplesMs: preparationSamples,
    playlistViewInterleavedReadP95Ms: p95(preparationProbeSamples),
    playlistViewInterleavedReadMaxMs: Math.max(...preparationProbeSamples),
    playlistViewInterleavedReadSamplesMs: preparationProbeSamples,
    playlistViewPreparedFirstPageMs: preparedPage.ms,
    playlistViewPageP95Ms: p95(viewWarmSamples),
    playlistViewSearchP95Ms: p95(viewSearchSamples),
    playlistViewQueueMs: viewQueue.ms,
    playlistViewQueuePlanMs: viewQueue.beginMs,
    playlistViewQueueBatches: viewQueue.batches.length,
    playlistViewQueueBatchP95Ms: viewQueue.batchP95Ms,
    playlistViewQueueBatchMaxMs: viewQueue.batchMaxMs,
    playlistViewQueueBatchSamplesMs: viewQueue.batches,
    playlistViewQueueInterleavedReadP95Ms: viewQueue.probeP95Ms,
    playlistViewQueueInterleavedReadMaxMs: viewQueue.probeMaxMs,
    playlistViewQueueInterleavedReadSamplesMs: viewQueue.probes,
    playlistViewAfterEditMs: viewAfterEdit.ms,
    playlistViewEntries: viewCold.value.total,
    maxQueryResponseTracks: coldPage.value.tracks.length,
    peakRssKiB: process.resourceUsage().maxRSS,
    finalRssBytes: process.memoryUsage().rss
  }
  if (evidence) {
    mkdirSync(dirname(evidence), { recursive: true })
    writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  database?.close()
  // root is the exact absolute directory returned by mkdtemp, never a computed parent.
  rmSync(root, { recursive: true, force: true })
}
