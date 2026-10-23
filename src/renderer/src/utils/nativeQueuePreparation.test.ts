import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../shared/track.ts'
import { preparedNativePlayMode, type PrepareNativeQueueOptions } from './nativeQueuePreparation.ts'

const { prepareNativeQueue } = (await import(
  new URL('./nativeQueuePreparation.ts', import.meta.url).href
)) as typeof import('./nativeQueuePreparation')

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'local:one',
    title: 'One',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:\\Music\\one.flac',
    fileName: 'one.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local',
    format: 'flac',
    ...overrides
  }
}

test('database local windows keep CUE companions, absolute positions and occurrence-specific identity', async () => {
  const first = createTrack({
    queueEntryId: 'first',
    cueRange: { startSeconds: 0, endSeconds: 90, pregapSeconds: 0 }
  })
  const next = createTrack({
    id: 'local:two',
    queueEntryId: 'next',
    cueRange: { startSeconds: 90, endSeconds: 180, pregapSeconds: 0 }
  })
  const prepared = await prepareNativeQueue({
    queue: [first, next],
    currentTrack: first,
    currentTarget: first.filePath,
    currentIndex: 0,
    playMode: 'listLoop',
    libraryQueue: { id: 'database-queue', revision: 3, positions: [299_998, 299_999] },
    isAudioFileAuthorized: async () => true
  })
  assert.equal(prepared?.startIndex, 0)
  assert.equal(prepared?.delegated, false)
  assert.deepEqual(prepared?.queueIndices, [299_998, 299_999])
  assert.deepEqual(
    prepared?.items.map((item) => item.queueEntryId),
    ['first', 'next']
  )
  assert.deepEqual(
    prepared?.items.map((item) => item.cueRange),
    [first.cueRange, next.cueRange]
  )
  assert.deepEqual(
    prepared?.libraryQueue?.entries.map((entry) => entry.index),
    [299_998, 299_999]
  )
  assert.equal(preparedNativePlayMode(prepared!, 'listLoop'), 'sequential')
  assert.equal(preparedNativePlayMode(prepared!, 'shuffle'), 'sequential')
  assert.equal(preparedNativePlayMode(prepared!, 'repeat'), 'repeat')
})

test('database fallback retains only the authorized current occurrence and its global mapping', async () => {
  const first = createTrack({ queueEntryId: 'first' })
  const next = createTrack({ id: 'other', filePath: 'D:/offline.flac', queueEntryId: 'next' })
  const options = {
    queue: [first, next],
    currentTrack: first,
    currentTarget: first.filePath,
    currentIndex: 0,
    libraryQueue: { id: 'db', revision: 9, positions: [41, 42] },
    isAudioFileAuthorized: async (path: string) => path !== next.filePath
  }
  const prepared = await prepareNativeQueue(options)
  assert.equal(prepared?.items.length, 1)
  assert.deepEqual(prepared?.libraryQueue?.entries, [
    { id: first.id, queueEntryId: 'first', index: 41 }
  ])
  assert.deepEqual(prepared?.queueIndices, [41])
  assert.equal(
    await prepareNativeQueue({ ...options, isAudioFileAuthorized: async () => false }),
    null
  )
})

test('database windows select duplicate occurrences by entry ID rather than track ID', async () => {
  const queue = [createTrack({ queueEntryId: 'first' }), createTrack({ queueEntryId: 'second' })]
  const prepared = await prepareNativeQueue({
    queue,
    currentTrack: queue[1],
    currentTarget: queue[1].filePath,
    currentIndex: 0,
    libraryQueue: { id: 'db', revision: 0, positions: [299_999, 0] },
    isAudioFileAuthorized: async () => true
  })
  assert.equal(prepared?.startIndex, 1)
  assert.equal(prepared?.items[prepared.startIndex].queueEntryId, 'second')
  assert.deepEqual(prepared?.queueIndices, [299_999, 0])
})

test('malformed database mappings fail before authorization instead of degrading to an array queue', async () => {
  const track = createTrack({ queueEntryId: 'entry' })
  let authorizations = 0
  const options: PrepareNativeQueueOptions = {
    queue: [track],
    currentTrack: track,
    currentTarget: track.filePath,
    currentIndex: 0,
    libraryQueue: { id: 'db', revision: 0, positions: [0] },
    isAudioFileAuthorized: async () => {
      authorizations++
      return true
    }
  }
  for (const patch of [
    { libraryQueue: { id: 'db', revision: 0, positions: [0], total: 0 } },
    { libraryQueue: { id: 'db', revision: 0, positions: [1], total: 1 } },
    { libraryQueue: { id: 'db', revision: 0, positions: [0], total: 1, lastPlayablePosition: 1 } },
    { libraryQueue: { id: 'db', revision: -1, positions: [0] } },
    { libraryQueue: { id: 'db', revision: 0, positions: [] } },
    { libraryQueue: { id: 'db', revision: 0, positions: [-1] } },
    { libraryQueue: { id: 'db', revision: 0, positions: [0.5] } },
    { currentTrack: { ...track, queueEntryId: 'missing' } },
    { currentTrack: { ...track, queueEntryId: undefined } },
    { queue: [{ ...track, queueEntryId: undefined }] },
    { queue: [track, track], libraryQueue: { id: 'db', revision: 0, positions: [0, 1] } },
    {
      queue: [track, { ...track, queueEntryId: 'second' }],
      libraryQueue: { id: 'db', revision: 0, positions: [0, 0] }
    }
  ])
    await assert.rejects(
      prepareNativeQueue({ ...options, ...patch }),
      /Invalid database playback window/
    )
  assert.equal(authorizations, 0)
})

test('SQL global end metadata survives full preparation, short fallback, repeat and reuse', async () => {
  const queue = [
    createTrack({ queueEntryId: 'last' }),
    createTrack({ queueEntryId: 'first', filePath: 'D:/offline.flac' })
  ]
  for (const repeat of [false, true]) {
    const options: PrepareNativeQueueOptions = {
      queue,
      currentTrack: queue[0],
      currentTarget: queue[0].filePath,
      currentIndex: 0,
      playMode: repeat ? 'repeat' : 'listLoop',
      libraryQueue: {
        id: 'db',
        revision: 0,
        total: 300000,
        lastPlayablePosition: 299997,
        positions: [299997, 0]
      },
      isAudioFileAuthorized: async () => true
    }
    assert.deepEqual(
      (await prepareNativeQueue(options))?.items.map((item) => item.logicalQueueEnd),
      [!repeat, false]
    )
    const fallback = await prepareNativeQueue({
      ...options,
      isAudioFileAuthorized: async (path) => path !== queue[1].filePath
    })
    assert.deepEqual(
      fallback?.items.map((item) => item.logicalQueueEnd),
      [!repeat]
    )
    let checked = false
    await prepareNativeQueue({
      ...options,
      canReuseQueue: (items) => {
        assert.deepEqual(
          items.map((item) => item.logicalQueueEnd),
          [!repeat, false]
        )
        checked = true
        return true
      }
    })
    assert.equal(checked, true)
  }
})

test('legacy array queues do not inherit database-only occurrence constraints', async () => {
  const track = createTrack({ queueEntryId: 'a'.repeat(1000) })
  const prepared = await prepareNativeQueue({
    queue: [track],
    currentTrack: track,
    currentTarget: track.filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })
  assert.equal(prepared?.delegated, true)
  assert.equal(prepared?.libraryQueue, undefined)
  assert.equal(prepared?.items[0].queueEntryId, undefined)
})

test('uses only the resolved current stream when a restored companion is unauthorized', async () => {
  const current = createTrack({ id: 'ncm:current', filePath: 'ncm:current', source: 'ncm' })
  const staleLocal = createTrack({ id: 'local:stale', filePath: 'D:\\Old\\stale.flac' })

  const prepared = await prepareNativeQueue({
    queue: [staleLocal, current],
    currentTrack: current,
    currentTarget: 'https://media.example/current.flac',
    currentIndex: 1,
    isAudioFileAuthorized: async (filePath) => filePath !== staleLocal.filePath
  })

  assert.deepEqual(prepared, {
    items: [
      {
        id: 'ncm:current',
        duration: 180,
        source: 'https://media.example/current.flac',
        logicalQueueEnd: true,
        format: 'flac',
        sampleRate: undefined,
        bitrate: undefined,
        bitDepth: undefined
      }
    ],
    startIndex: 0,
    delegated: false,
    queueIndices: [1]
  })
})

test('preserves a fully authorized local queue and its renderer index', async () => {
  const first = createTrack()
  const second = createTrack({ id: 'local:two', filePath: 'D:\\Music\\two.flac' })

  const prepared = await prepareNativeQueue({
    queue: [first, second],
    currentTrack: second,
    currentTarget: second.filePath,
    currentIndex: 1,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared?.delegated, true)
  assert.equal(prepared?.startIndex, 1)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [first.filePath, second.filePath]
  )
})

test('uses a singleton when a provider companion has not resolved its placeholder', async () => {
  const current = createTrack({ id: 'ncm:current', filePath: 'ncm:current', source: 'ncm' })
  const unresolved = createTrack({ id: 'ncm:next', filePath: 'ncm:next', source: 'ncm' })

  const prepared = await prepareNativeQueue({
    queue: [current, unresolved],
    currentTrack: current,
    currentTarget: 'https://media.example/current.flac',
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared?.delegated, false)
  assert.equal(prepared?.items.length, 1)
  assert.equal(prepared?.items[0].source, 'https://media.example/current.flac')
  assert.deepEqual(prepared?.queueIndices, [0])
  assert.equal(prepared?.items[0].logicalQueueEnd, false)
  assert.equal(preparedNativePlayMode(prepared!, 'listLoop'), 'sequential')
})

test('accepts an authorized managed-cache path as the current provider target', async () => {
  const cached = 'D:\\Cache\\ncm-cache\\123.flac'
  const current = createTrack({
    id: 'ncm:current',
    filePath: 'ncm:current',
    source: 'ncm',
    streamUrl: null
  })
  const next = createTrack({
    id: 'ncm:next',
    filePath: 'ncm:next',
    source: 'ncm',
    streamUrl: 'https://media.example/next.flac'
  })
  const prepared = await prepareNativeQueue({
    queue: [current, next],
    currentTrack: current,
    currentTarget: cached,
    currentIndex: 0,
    isAudioFileAuthorized: async (path) => path === cached
  })

  assert.equal(prepared?.delegated, true)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [cached, next.streamUrl]
  )
})

test('uses online stream targets for a fully resolved provider queue', async () => {
  const current = createTrack({
    id: 'ncm:current',
    filePath: 'ncm:current',
    source: 'ncm',
    streamUrl: 'https://media.example/current.flac'
  })
  const next = createTrack({
    id: 'ncm:next',
    filePath: 'ncm:next',
    source: 'ncm',
    streamUrl: 'https://media.example/next.flac'
  })
  const prepared = await prepareNativeQueue({
    queue: [current, next],
    currentTrack: current,
    currentTarget: current.streamUrl!,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared?.delegated, true)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [current.streamUrl, next.streamUrl]
  )
})

test('rejects an unauthorized provider local currentTarget', async () => {
  const current = createTrack({
    id: 'ncm:current',
    filePath: 'ncm:current',
    source: 'ncm',
    streamUrl: null
  })
  const prepared = await prepareNativeQueue({
    queue: [current],
    currentTrack: current,
    currentTarget: 'D:\\Untrusted\\stale.flac',
    currentIndex: 0,
    isAudioFileAuthorized: async () => false
  })

  assert.equal(prepared, null)
})

test('rejects an unsafe current target instead of issuing a native queue request', async () => {
  const current = createTrack({ source: 'ncm', filePath: 'ncm:current' })

  const prepared = await prepareNativeQueue({
    queue: [current],
    currentTrack: current,
    currentTarget: 'https://user:secret@media.example/current.flac',
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared, null)
})

test('accepts twilight-media grant URLs as native playback targets', async () => {
  const grant = 'twilight-media://audio/opaque-token'
  const current = createTrack({
    id: 'ncm:current',
    filePath: 'ncm:current',
    source: 'ncm',
    streamUrl: grant
  })
  const companion = createTrack({
    id: 'ncm:next',
    filePath: 'ncm:next',
    source: 'ncm',
    streamUrl: 'twilight-media://audio/next-token'
  })

  const prepared = await prepareNativeQueue({
    queue: [current, companion],
    currentTrack: current,
    currentTarget: grant,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared?.delegated, true)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [grant, companion.streamUrl]
  )
})

test('uses the current-only queue when companion authorization throws', async () => {
  const current = createTrack({ id: 'ncm:current', filePath: 'ncm:current', source: 'ncm' })
  const companion = createTrack({ id: 'local:companion', filePath: 'D:\\Music\\companion.flac' })

  const prepared = await prepareNativeQueue({
    queue: [current, companion],
    currentTrack: current,
    currentTarget: 'https://media.example/current.flac',
    currentIndex: 0,
    isAudioFileAuthorized: async () => {
      throw new Error('IPC unavailable')
    }
  })

  assert.equal(prepared?.delegated, false)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    ['https://media.example/current.flac']
  )
})

test('forwards library ReplayGain and R128 tags into native queue items', async () => {
  const track = createTrack({
    replayGainTrackGainDb: -6.5,
    replayGainAlbumGainDb: -7.1,
    replayGainTrackPeak: 0.98,
    replayGainAlbumPeak: 0.99,
    r128TrackGainDb: -5.2,
    r128AlbumGainDb: -5.8
  })

  const prepared = await prepareNativeQueue({
    queue: [track],
    currentTrack: track,
    currentTarget: track.filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared?.items.length, 1)
  assert.equal(prepared?.items[0].replayGainTrackGainDb, -6.5)
  assert.equal(prepared?.items[0].replayGainAlbumGainDb, -7.1)
  assert.equal(prepared?.items[0].replayGainTrackPeak, 0.98)
  assert.equal(prepared?.items[0].replayGainAlbumPeak, 0.99)
  assert.equal(prepared?.items[0].r128TrackGainDb, -5.2)
  assert.equal(prepared?.items[0].r128AlbumGainDb, -5.8)
})

test('keeps CUE tracks on the referenced file while preserving distinct native ranges', async () => {
  const first = createTrack({
    id: 'local:cue:one',
    cueRange: { startSeconds: 0, endSeconds: 60, pregapSeconds: 0 },
    duration: 60
  })
  const second = createTrack({
    id: 'local:cue:two',
    cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 2 },
    duration: 60
  })
  const prepared = await prepareNativeQueue({
    queue: [first, second],
    currentTrack: second,
    currentTarget: second.filePath,
    currentIndex: 1,
    isAudioFileAuthorized: async () => true
  })
  assert.equal(prepared?.delegated, true)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [first.filePath, second.filePath]
  )
  assert.deepEqual(
    prepared?.items.map((item) => item.cueRange),
    [first.cueRange, second.cueRange]
  )
})

test('a queue past the native ceiling degrades to a current-only engine queue', async () => {
  const { MAX_NATIVE_QUEUE_ITEMS } = await import(
    new URL('../../../shared/nativeQueue.ts', import.meta.url).href
  )
  const oversized = Array.from({ length: MAX_NATIVE_QUEUE_ITEMS + 1 }, (_unused, index) =>
    createTrack({ id: `local:${index}`, filePath: `D:\\Music\\${index}.flac` })
  )
  let authorizationCalls = 0

  const prepared = await prepareNativeQueue({
    queue: oversized,
    currentTrack: oversized[42],
    currentTarget: oversized[42].filePath,
    currentIndex: 42,
    isAudioFileAuthorized: async () => {
      authorizationCalls += 1
      return true
    }
  })

  // Delegating the whole queue would be rejected by audioEngine:loadQueue before
  // audioEngine:play is ever reached, which silences playback on every device.
  assert.equal(prepared?.delegated, false)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [oversized[42].filePath]
  )
  assert.equal(prepared?.startIndex, 0)
  assert.equal(
    authorizationCalls,
    1,
    'only the current track is authorized; the per-track fan-out is skipped'
  )
})

test('a queue exactly at the native ceiling is still delegated in full', async () => {
  const { MAX_NATIVE_QUEUE_ITEMS } = await import(
    new URL('../../../shared/nativeQueue.ts', import.meta.url).href
  )
  const atLimit = Array.from({ length: MAX_NATIVE_QUEUE_ITEMS }, (_unused, index) =>
    createTrack({ id: `local:${index}`, filePath: `D:\\Music\\${index}.flac` })
  )

  const prepared = await prepareNativeQueue({
    queue: atLimit,
    currentTrack: atLimit[0],
    currentTarget: atLimit[0].filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  })

  assert.equal(prepared?.delegated, true)
  assert.equal(prepared?.items.length, MAX_NATIVE_QUEUE_ITEMS)
})

test('a delegated queue authorizes every local target in one batch round-trip', async () => {
  const tracks = Array.from({ length: 200 }, (_unused, index) =>
    createTrack({ id: `local:${index}`, filePath: `D:/Music/${index}.flac` })
  )
  const batches: string[][] = []
  let perFileCalls = 0

  const prepared = await prepareNativeQueue({
    queue: tracks,
    currentTrack: tracks[7],
    currentTarget: tracks[7].filePath,
    currentIndex: 7,
    isAudioFileAuthorized: async () => {
      perFileCalls += 1
      return true
    },
    areAudioFilesAuthorized: async (filePaths) => {
      batches.push(filePaths)
      return filePaths.map(() => true)
    }
  })

  assert.equal(prepared?.delegated, true)
  assert.equal(prepared?.items.length, 200)
  assert.equal(batches.length, 1, 'the whole queue is authorized in one round-trip')
  assert.equal(batches[0].length, 200)
  // Only the current track still uses the single-file boundary.
  assert.equal(perFileCalls, 1)
})

test('a batch verdict denying one track still degrades to the current-only queue', async () => {
  const first = createTrack()
  const second = createTrack({ id: 'local:two', filePath: 'D:/Music/two.flac' })

  const prepared = await prepareNativeQueue({
    queue: [first, second],
    currentTrack: first,
    currentTarget: first.filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async (filePaths) =>
      filePaths.map((filePath) => filePath !== second.filePath)
  })

  assert.equal(prepared?.delegated, false)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [first.filePath]
  )
})

test('a batch answer that does not match the request falls back to the per-file boundary', async () => {
  const first = createTrack()
  const second = createTrack({ id: 'local:two', filePath: 'D:/Music/two.flac' })
  const checked: string[] = []

  const prepared = await prepareNativeQueue({
    queue: [first, second],
    currentTrack: first,
    currentTarget: first.filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async (filePath) => {
      checked.push(filePath)
      return true
    },
    // Short answer: the batch channel must not be trusted to line up by index.
    areAudioFilesAuthorized: async () => [true]
  })

  assert.equal(prepared?.delegated, true)
  assert.deepEqual(checked.slice(1).sort(), [first.filePath, second.filePath].sort())
})

test('fallback authorization limits concurrency and stops dispatching superseded work', async () => {
  const queue = Array.from({ length: 1000 }, (_, index) =>
    createTrack({ id: String(index), filePath: `D:/Music/${index}.flac` })
  )
  let active = 0,
    peak = 0,
    calls = 0,
    current = true
  const check = async () => {
    calls++
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setImmediate(resolve))
    active--
    return true
  }
  const options = {
    queue,
    currentTrack: queue[0],
    currentTarget: queue[0].filePath,
    currentIndex: 0,
    isAudioFileAuthorized: check,
    areAudioFilesAuthorized: async () => {
      throw new Error('batch unavailable')
    }
  }
  assert.equal((await prepareNativeQueue(options))?.delegated, true)
  assert.equal(calls, 1001)
  assert.equal(peak, 16)
  calls = 0
  const prepared = await prepareNativeQueue({
    ...options,
    isCurrent: () => current,
    isAudioFileAuthorized: async () => {
      const result = await check()
      if (calls > 1) current = false
      return result
    }
  })
  assert.equal(prepared, null)
  assert.ok(calls <= 17)
})

test('repeated targets are authorized once', async () => {
  const track = createTrack()
  const duplicate = createTrack({ id: 'local:duplicate' })
  let batched: string[] = []

  await prepareNativeQueue({
    queue: [track, duplicate],
    currentTrack: track,
    currentTarget: track.filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async (filePaths) => {
      batched = filePaths
      return filePaths.map(() => true)
    }
  })

  assert.deepEqual(batched, [track.filePath])
})

test('prefetched NetEase stream URLs survive only inside their freshness window', async () => {
  const { stripStaleNcmStreamUrls, NCM_STREAM_URL_MAX_AGE_MS } = await import(
    new URL('./nativeQueuePreparation.ts', import.meta.url).href
  )
  const now = 1_000_000
  const fresh = createTrack({
    id: 'ncm:fresh',
    source: 'ncm',
    filePath: 'ncm:fresh',
    streamUrl: 'https://cdn.example/fresh.flac'
  })
  const expired = createTrack({
    id: 'ncm:expired',
    source: 'ncm',
    filePath: 'ncm:expired',
    streamUrl: 'https://cdn.example/expired.flac'
  })
  const untracked = createTrack({
    id: 'ncm:untracked',
    source: 'ncm',
    filePath: 'ncm:untracked',
    streamUrl: 'https://cdn.example/untracked.flac'
  })
  const local = createTrack({ id: 'local:keep' })
  const committedAt = new Map<string, number>([
    ['ncm:fresh', now - NCM_STREAM_URL_MAX_AGE_MS + 1_000],
    ['ncm:expired', now - NCM_STREAM_URL_MAX_AGE_MS - 1_000]
  ])

  const stripped = stripStaleNcmStreamUrls([fresh, expired, untracked, local], {
    committedAtByTrackId: committedAt,
    nowMs: now
  })

  assert.equal(stripped[0].streamUrl, 'https://cdn.example/fresh.flac')
  assert.equal(stripped[1].streamUrl, '', 'expired prefetched URLs must not enter the native queue')
  assert.equal(stripped[2].streamUrl, '', 'untracked URLs are untrusted and must re-resolve')
  assert.equal(stripped[3], local, 'non-NCM tracks pass through by identity')
})

test('expired or untracked NetEase audio grants cannot poison a fresh current queue', async () => {
  const { stripStaleNcmStreamUrls } = await import(
    new URL('./nativeQueuePreparation.ts', import.meta.url).href
  )
  const current = createTrack({
    id: 'ncm:current',
    source: 'ncm',
    filePath: 'ncm:current',
    streamUrl: 'twilight-media://audio/fresh'
  })
  const stale = createTrack({
    id: 'ncm:stale',
    source: 'ncm',
    filePath: 'ncm:stale',
    streamUrl: 'twilight-media://audio/expired'
  })
  const queue = stripStaleNcmStreamUrls([current, stale], {
    committedAtByTrackId: new Map([[current.id, 1000]]),
    nowMs: 1001
  })
  const prepared = await prepareNativeQueue({
    queue,
    currentTrack: current,
    currentTarget: current.streamUrl!,
    currentIndex: 0,
    isAudioFileAuthorized: async () => false
  })
  assert.equal(prepared?.delegated, false)
  assert.deepEqual(
    prepared?.items.map((item) => item.source),
    [current.streamUrl]
  )
  assert.equal(
    stale.streamUrl,
    'twilight-media://audio/expired',
    'sanitizing must not mutate the queue'
  )
})

test('provider-managed local cache paths never get freshness-stripped', async () => {
  const { stripStaleNcmStreamUrls } = await import(
    new URL('./nativeQueuePreparation.ts', import.meta.url).href
  )
  const cached = createTrack({
    id: 'ncm:cached',
    source: 'ncm',
    filePath: 'ncm:cached',
    streamUrl: 'D:\\Cache\\ncm-cache\\42.flac'
  })
  const stripped = stripStaleNcmStreamUrls([cached], {
    committedAtByTrackId: new Map(),
    nowMs: Date.now()
  })
  assert.equal(stripped[0], cached, 'local cache targets are provider-owned and never expire here')
})

test('stripStaleNcmStreamUrls returns an equal copy when nothing is stripped', async () => {
  const { stripStaleNcmStreamUrls } = await import(
    new URL('./nativeQueuePreparation.ts', import.meta.url).href
  )
  const queue = [createTrack(), createTrack({ id: 'local:two', filePath: 'D:\\Music\\two.flac' })]
  const stripped = stripStaleNcmStreamUrls(queue, { committedAtByTrackId: new Map() })
  assert.deepEqual(stripped, queue)
  assert.notEqual(stripped, queue, 'callers receive a defensive copy')
})

test('NetEase prepares the current and next entries without skipping an unresolved song', async () => {
  const queue = ['a', 'b', 'c'].map((id) =>
    createTrack({
      id: `ncm:${id}`,
      source: 'ncm',
      filePath: `ncm:${id}`,
      streamUrl: id === 'c' ? null : `twilight-media://audio/${id}`
    })
  )
  const options = {
    queue,
    currentTrack: queue[0],
    currentTarget: queue[0].streamUrl!,
    currentIndex: 0,
    isAudioFileAuthorized: async () => false
  }
  const prepared = await prepareNativeQueue(options)
  assert.deepEqual(
    prepared?.items.map((item) => item.id),
    ['ncm:a', 'ncm:b']
  )
  assert.deepEqual(prepared?.queueIndices, [0, 1])
  assert.equal(prepared?.delegated, false)
  queue[1].streamUrl = null
  queue[2].streamUrl = 'twilight-media://audio/c'
  const blocked = await prepareNativeQueue(options)
  assert.deepEqual(
    blocked?.items.map((item) => item.id),
    ['ncm:a']
  )
})

test('NetEase partial list-loop windows wrap only at the logical queue boundary', async () => {
  const { preparedNativePlayMode } = await import('./nativeQueuePreparation.ts')
  const queue = ['a', 'unresolved', 'c'].map((id) =>
    createTrack({
      id: `ncm:${id}`,
      source: 'ncm',
      filePath: `ncm:${id}`,
      streamUrl: id === 'unresolved' ? null : `twilight-media://audio/${id}`
    })
  )
  const prepared = await prepareNativeQueue({
    queue,
    currentTrack: queue[2],
    currentTarget: queue[2].streamUrl!,
    currentIndex: 2,
    playMode: 'listLoop',
    isAudioFileAuthorized: async () => false
  })
  assert.ok(prepared)
  assert.deepEqual(prepared.queueIndices, [2, 0])
  assert.equal(preparedNativePlayMode(prepared, 'listLoop'), 'sequential')
  assert.equal(preparedNativePlayMode(prepared, 'shuffle'), 'sequential')
  assert.equal(preparedNativePlayMode(prepared, 'repeat'), 'repeat')
})

test('quality changes strip both signed NetEase URLs and managed cache paths', async () => {
  const { stripStaleNcmStreamUrls } = await import('./nativeQueuePreparation.ts')
  const queue = ['twilight-media://audio/a', 'D:\\Cache\\ncm-cache\\b.flac'].map(
    (streamUrl, index) =>
      createTrack({ id: `ncm:${index}`, source: 'ncm', streamUrl, streamQuality: 'lossless' })
  )
  const stripped = stripStaleNcmStreamUrls(queue, {
    committedAtByTrackId: new Map(queue.map((track) => [track.id, Date.now()])),
    quality: 'standard'
  })
  assert.deepEqual(
    stripped.map((track) => track.streamUrl),
    ['', '']
  )
  assert.ok(queue.every((track) => track.streamUrl))
})

test('oversized NetEase queues keep only the current boundary and do not authorize the whole album', async () => {
  const { MAX_NATIVE_QUEUE_ITEMS } = await import('../../../shared/nativeQueue.ts')
  const queue = Array.from({ length: MAX_NATIVE_QUEUE_ITEMS + 1 }, (_, index) =>
    createTrack({
      id: `ncm:${index}`,
      source: 'ncm',
      filePath: `ncm:${index}`,
      streamUrl: index < 2 ? `twilight-media://audio/${index}` : null
    })
  )
  const prepared = await prepareNativeQueue({
    queue,
    currentTrack: queue[0],
    currentTarget: queue[0].streamUrl!,
    currentIndex: 0,
    isAudioFileAuthorized: async () => {
      throw new Error('remote windows need no file authorization')
    },
    areAudioFilesAuthorized: async () => {
      throw new Error('must not authorize the full queue')
    }
  })
  assert.equal(prepared?.items.length, 2)
  assert.deepEqual(prepared?.queueIndices, [0, 1])
})
