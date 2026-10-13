import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import type { Track } from '../../types/music'
import { findProviderRematchCandidate } from '../../utils/libraryRepair.ts'
import { findPlaybackFallbackTrack } from '../../utils/playbackFallback.ts'
import { getTrackSource } from '../../utils/playerTrackUtils.ts'
import { PlaybackRecoverySession } from './playbackRecoverySession.ts'
import {
  patchPlaybackQueueTrack,
  toPlaybackQueueSnapshot
} from '../../utils/playbackQueueVirtualization.ts'

function track(id: string): Track {
  return {
    id,
    source: id.split(':')[0] as Track['source'],
    title: 'Recovery Song',
    artist: 'Recovery Artist',
    album: 'Recovery Album',
    duration: 180,
    filePath: id,
    fileName: 'Recovery Song',
    size: 0,
    cover: null,
    lyrics: null
  }
}

test('source recovery bounds attempts and never revisits the same provider track', () => {
  const first = track('ncm:a')
  const session = new PlaybackRecoverySession(first, { maxAttempts: 2 })
  try {
    assert.equal(session.beginAttempt(first), true)
    assert.equal(session.canAttempt({ ...first }), false)
    assert.equal(session.beginAttempt(track('qq:b')), true)
    assert.equal(session.canAttempt(track('qq:c')), false)
    assert.equal(session.canAttemptSearch(), false)
  } finally {
    session.finish()
  }
})

test('source recovery cancels a pending provider operation when superseded', async () => {
  const session = new PlaybackRecoverySession(track('ncm:a'))
  const pending = session.run(() => new Promise<string>(() => {}))
  session.cancel()
  await assert.rejects(pending, /superseded/)
  assert.equal(session.signal.aborted, true)
})

test('source recovery times out stalled operations and passes cancellation to searches', async () => {
  const session = new PlaybackRecoverySession(track('ncm:a'), { timeoutMs: 20 })
  await assert.rejects(
    session.run(() => new Promise<string>(() => {})),
    /timed out/
  )
  assert.equal(session.signal.aborted, true)
  assert.equal(session.canAttemptSearch(), false)
})

// Execute the real store load/resolution/recovery functions with provider and
// audio boundaries injected. This reproduces the original nested retry cycle.
function createPlayerFixture(options: {
  candidates: Track[]
  resolveUrl?: (track: Track) => Promise<string | null>
  pinned?: boolean
}) {
  const first = options.candidates[0]
  const attempts: string[] = []
  const persisted: Array<{ oldId: string; newId: string; playing: boolean }> = []
  const notices: Array<{ message: string; kind?: string }> = []
  const replacements: Track[] = []
  let searches = 0
  const source = readFileSync(new URL('../usePlayerStore.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('usePlayerStore.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set([
    'loadAndPlay',
    'resolvePlayTarget',
    'isActiveLoad',
    'handlePlaybackFallback',
    'handleProviderRematchFallback',
    'preserveQueueEntryContext'
  ])
  let implementations = ast.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
    .map((node) => node.getText(ast))
    .join('\n')
  // Obtain the actual occurrence helper from the store or its utility module.
  if (
    !ast.statements.some(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'preserveQueueEntryContext'
    )
  ) {
    const utilitySource = readFileSync(
      new URL('../../utils/queuePlaybackOrigin.ts', import.meta.url),
      'utf8'
    )
    const utility = ts.createSourceFile(
      'queuePlaybackOrigin.ts',
      utilitySource,
      ts.ScriptTarget.Latest,
      true
    )
    const helper = utility.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'preserveQueueEntryContext'
    )
    assert.ok(helper, 'queue occurrence helper should exist in the integrated checkout')
    implementations += `\n${helper.getText(utility).replace(/^export\s+/, '')}`
  }
  const noop = () => {}
  const context = {
    queue: { value: [first] },
    originalQueue: { value: [first] },
    queueIndex: { value: 0 },
    currentTrack: { value: first },
    activeLoadToken: 0,
    activePlaybackRecovery: null as PlaybackRecoverySession | null,
    nativePlaybackActive: false,
    nativeQueueDelegated: false,
    loadedTrackId: '',
    nativeHistoryRestartPending: false,
    lastActiveTrack: null,
    playbackAudio: null,
    pendingLoadStartTime: 0,
    advancingFromEndedTrackId: '',
    autoAdvanceInFlight: false,
    isLoading: { value: false },
    isPlaying: { value: false },
    streamNowPlaying: { value: '' },
    duration: { value: 180 },
    playbackRate: { value: 1 },
    playMode: { value: 'sequential' },
    playbackHistoryController: {
      beginPlaybackAttempt: noop,
      clearResumeOfferForOtherTrack: noop,
      recordTrackDeparture: noop,
      maybeOfferResumeForTrack: noop,
      recordPlaybackStart: noop
    },
    playbackSessionController: {
      clearPendingPlaybackPosition: noop,
      consumePendingPlaybackPosition: (_track: Track, value: number) => value
    },
    clampCuePlaybackPosition: (_track: Track, value: number) => value,
    cueDuration: (item: Track) => item.duration,
    clearPlaybackToggleIntent: noop,
    setNativePlaybackInfoIntent: noop,
    resetNativeStreamBufferingState: noop,
    beginPlaybackPositionTransition: noop,
    clearAbLoop: noop,
    clearCrossfadeTimer: noop,
    stopNativeAudio: async () => {},
    clearNativePlaybackInfoIntentForLoad: noop,
    appSettings: { value: { ncmPlaybackQuality: 'lossless' } },
    getTrackSource,
    findProviderRematchCandidate,
    findPlaybackFallbackTrack,
    preferredSourceKey: () => (options.pinned ? 'ncm:a' : null),
    PlaybackRecoverySession,
    getProviderSourceReliability: () => ({}),
    currentLocale: () => 'en-US',
    translate: (_locale: string, key: string) => key,
    presentError: () => 'provider unavailable',
    setAudioEngineError: (message: string, kind?: string) => notices.push({ message, kind }),
    stopVisualizationPolling: noop,
    startVisualizationPolling: noop,
    stopRendererAudio: noop,
    toPlaybackQueueSnapshot,
    syncPluginProviders: async () => {},
    isLikelyLocalFilePath: () => false,
    shouldReuseResolvedStreamUrl: () => false,
    shouldUseNativePlayback: () => false,
    patchTrackInQueues: (item: Track) => {
      context.queue.value = patchPlaybackQueueTrack(context.queue.value, item)
      context.originalQueue.value = patchPlaybackQueueTrack(context.originalQueue.value, item)
    },
    rememberNcmStreamUrlCommit: noop,
    nativeSourceToTrackId: new Map(),
    playWithRendererAudio: async () => true,
    scheduleRendererPlaybackWatchdog: noop,
    useMediaProviders: () => ({
      resolvePlaybackUrl: async (item: Track) => {
        attempts.push(item.id)
        return options.resolveUrl ? options.resolveUrl(item) : null
      },
      searchAllSongs: async () => {
        searches += 1
        return { items: options.candidates.map((item) => ({ track: item })) }
      }
    }),
    useMusicStore: () => ({
      replaceTrackReference: (oldId: string, item: Track) => {
        replacements.push(item)
        persisted.push({ oldId, newId: item.id, playing: context.isPlaying.value })
      }
    }),
    console: { warn: noop, error: noop },
    loadAndPlay: undefined as unknown as (item: Track) => Promise<void>
  }
  vm.createContext(context)
  vm.runInContext(
    ts.transpileModule(implementations, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    context
  )
  return {
    context,
    first,
    attempts,
    persisted,
    notices,
    replacements,
    get searches() {
      return searches
    }
  }
}

test('two searchable providers whose URLs fail terminate once without cycling or persisting', async () => {
  const fixture = createPlayerFixture({ candidates: [track('ncm:a'), track('qq:b')] })
  await fixture.context.loadAndPlay(fixture.first)
  assert.deepEqual(fixture.attempts, ['ncm:a', 'qq:b'])
  assert.equal(fixture.searches, 2)
  assert.deepEqual(fixture.persisted, [])
  assert.equal(fixture.notices.filter((notice) => notice.message && !notice.kind).length, 1)
  assert.equal(fixture.context.isLoading.value, false)
  assert.equal(fixture.context.isPlaying.value, false)
})

test('many matching but unavailable tracks stop at the shared six-attempt budget', async () => {
  const fixture = createPlayerFixture({
    candidates: [track('ncm:a'), ...Array.from({ length: 20 }, (_, index) => track(`qq:${index}`))]
  })
  await fixture.context.loadAndPlay(fixture.first)
  assert.equal(fixture.attempts.length, 6)
  assert.equal(new Set(fixture.attempts).size, 6)
  assert.equal(fixture.searches, 5)
  assert.deepEqual(fixture.persisted, [])
  assert.equal(fixture.notices.filter((notice) => notice.message && !notice.kind).length, 1)
})

test('a rematch persists the original reference only after the successful candidate starts', async () => {
  const fixture = createPlayerFixture({
    candidates: [track('ncm:a'), track('qq:b'), track('qq:c')],
    resolveUrl: async (item) => (item.id === 'qq:c' ? 'https://example.test/audio' : null)
  })
  await fixture.context.loadAndPlay(fixture.first)
  assert.deepEqual(fixture.attempts, ['ncm:a', 'qq:b', 'qq:c'])
  assert.deepEqual(fixture.persisted, [{ oldId: 'ncm:a', newId: 'qq:c', playing: true }])
  assert.equal(fixture.notices.filter((notice) => notice.kind === 'warning').length, 1)
})

test('a pinned recording source also disables provider rematch', async () => {
  const fixture = createPlayerFixture({ candidates: [track('ncm:a'), track('qq:b')], pinned: true })
  await fixture.context.loadAndPlay(fixture.first)
  assert.deepEqual(fixture.attempts, ['ncm:a'])
  assert.equal(fixture.searches, 0)
  assert.deepEqual(fixture.persisted, [])
})

test('queue fallback keeps the failed occurrence index and origin through target metadata patches', async () => {
  const origin = { kind: 'playlist', scope: 'aggregate', id: 'selected', name: 'Selected list' }
  const candidateOrigin = { ...origin, id: 'candidate-list', name: 'Candidate list' }
  const failed = Object.assign(track('ncm:a'), {
    queueEntryId: 'selected-entry',
    queuePlaybackOrigin: origin
  })
  const candidate = Object.assign(track('qq:b'), {
    queueEntryId: 'candidate-entry',
    queuePlaybackOrigin: candidateOrigin
  })
  const fixture = createPlayerFixture({
    candidates: [failed, candidate],
    resolveUrl: async (item) => (item.id === candidate.id ? 'https://example.test/recovered' : null)
  })
  // The matching source already occurs earlier in the queue. Selecting its id
  // would jump to that occurrence instead of retaining the requested one.
  fixture.context.queue.value = [candidate, failed]
  fixture.context.originalQueue.value = [candidate, failed]
  fixture.context.queueIndex.value = 1
  await fixture.context.loadAndPlay(failed)
  assert.equal(fixture.context.queueIndex.value, 1)
  assert.equal(fixture.context.currentTrack.value.queueEntryId, 'selected-entry')
  assert.equal((fixture.context.currentTrack.value as typeof failed).queuePlaybackOrigin, origin)
  assert.equal(
    (fixture.context.queue.value[0] as typeof candidate).queuePlaybackOrigin,
    candidateOrigin
  )
  assert.equal((fixture.context.queue.value[1] as typeof failed).queuePlaybackOrigin, origin)
  assert.equal(
    (fixture.context.originalQueue.value[1] as typeof failed).queuePlaybackOrigin,
    origin
  )
  assert.deepEqual(fixture.attempts, ['ncm:a', 'qq:b'])
  assert.equal(fixture.searches, 0)
  assert.deepEqual(fixture.persisted, [])
})

test('provider rematch retains selected context but persists successful audio metadata without queue context', async () => {
  const origin = {
    kind: 'album',
    scope: 'provider',
    providerId: 'ncm',
    id: 'album-a',
    name: 'Selected album'
  }
  const failed = Object.assign(track('ncm:a'), {
    queueEntryId: 'selected-entry',
    queuePlaybackOrigin: origin
  })
  const unavailable = Object.assign(track('qq:b'), {
    queueEntryId: 'search-entry',
    queuePlaybackOrigin: { ...origin, id: 'other' }
  })
  const available = track('qq:c')
  const fixture = createPlayerFixture({
    candidates: [failed, unavailable, available],
    resolveUrl: async (item) => (item.id === available.id ? 'https://example.test/recovered' : null)
  })
  await fixture.context.loadAndPlay(failed)
  assert.deepEqual(fixture.attempts, ['ncm:a', 'qq:b', 'qq:c'])
  assert.equal(fixture.context.currentTrack.value.queueEntryId, 'selected-entry')
  assert.equal((fixture.context.currentTrack.value as typeof failed).queuePlaybackOrigin, origin)
  assert.equal((fixture.context.queue.value[0] as typeof failed).queuePlaybackOrigin, origin)
  assert.deepEqual(fixture.persisted, [{ oldId: failed.id, newId: available.id, playing: true }])
  assert.equal(fixture.replacements.length, 1)
  assert.equal(fixture.replacements[0].queueEntryId, undefined)
  assert.equal('queuePlaybackOrigin' in fixture.replacements[0], false)
})

test('a newer user request cancels an unresolved load and ignores its late URL', async () => {
  let resolveOld!: (url: string) => void
  const newer = track('qq:b')
  const fixture = createPlayerFixture({
    candidates: [track('ncm:a'), newer],
    resolveUrl: async (item) =>
      item.id === 'ncm:a'
        ? new Promise<string>((resolve) => {
            resolveOld = resolve
          })
        : 'https://example.test/newer'
  })
  const oldLoad = fixture.context.loadAndPlay(fixture.first)
  await new Promise((resolve) => setTimeout(resolve, 0))
  fixture.context.currentTrack.value = newer
  await fixture.context.loadAndPlay(newer)
  await oldLoad
  resolveOld('https://example.test/late')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fixture.context.currentTrack.value.id, newer.id)
  assert.equal(fixture.context.currentTrack.value.streamUrl, 'https://example.test/newer')
  assert.equal(fixture.first.streamUrl, undefined)
  assert.equal(fixture.searches, 0)
  assert.deepEqual(fixture.persisted, [])
})
