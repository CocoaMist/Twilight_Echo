import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const root = resolve(process.argv[2] || '.')
const require = createRequire(join(root, 'package.json'))
const { transformSync } = require('esbuild')
const { computed, ref, watch, nextTick } = require('vue')
const load = (path) => import(pathToFileURL(join(root, path)).href)
const read = (path) => readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n')
const { prepareNativeQueue } = await load('src/renderer/src/utils/nativeQueuePreparation.ts')
const { mergeTrackTransientData } = await load('src/renderer/src/utils/playerTrackUtils.ts')
const { projectManagedLyrics, projectLyricDisplay, DEFAULT_LYRICS_MANAGEMENT } = await load('src/shared/lyricsManagement.ts')
const { buildLyricLines } = await load('src/renderer/src/utils/lyricLineBuilder.ts')
const { projectDesktopLyricsLines } = await load('src/renderer/src/utils/desktopLyricsProjection.ts')
const { DESKTOP_LYRICS_CLOCK_INTERVAL_MS } = await load('src/shared/desktopLyrics.ts')
const { createPlaybackInfoFanoutSignature, createDefaultPlaybackInfo } = await load('src/main/audio/audioEngineHelpers.ts')
const emit = (data) => console.log(JSON.stringify(data))
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]
const ts = (source) => transformSync(source, { loader: 'ts', format: 'cjs' }).code
const excerpt = (source, start, end) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to <= from) throw new Error(`Missing audit excerpt: ${start}`)
  return source.slice(from, to)
}

// Exercise the real queue-preparation boundary without filesystem I/O.
for (const count of [5000, 20000]) {
  const queue = Array.from({ length: count }, (_, index) => ({
    id: `local:${index}`, source: 'local', filePath: `E:/Music/Track${index}.flac`,
    duration: 240, format: 'FLAC', sampleRate: 96000, bitDepth: 24
  }))
  const timings = []
  let singles = 0, batches = 0, batchTargets = 0, delegated
  for (let index = 0; index < 12; index++) {
    const started = performance.now()
    const result = await prepareNativeQueue({
      queue, currentTrack: queue[index], currentTarget: queue[index].filePath, currentIndex: index,
      isAudioFileAuthorized: async () => { singles++; return true },
      areAudioFilesAuthorized: async (paths) => { batches++; batchTargets += paths.length; return paths.map(() => true) }
    })
    timings.push(performance.now() - started)
    delegated = result.delegated
  }
  emit({ kind: 'rendererQueuePreparation', items: count, calls: 12, delegated, singles, batches, batchTargets,
    medianMs: percentile(timings, .5), peakMs: Math.max(...timings) })
}

// Batch failure must fall back; observe actual simultaneous single requests.
{
  const queue = Array.from({ length: 1000 }, (_, index) => ({ id: `local:${index}`, source: 'local', filePath: `E:/Music/${index}.flac` }))
  let active = 0, peak = 0, singles = 0
  const result = await prepareNativeQueue({ queue, currentTrack: queue[0], currentTarget: queue[0].filePath, currentIndex: 0,
    areAudioFilesAuthorized: async () => { throw new Error('audit simulated batch failure') },
    isAudioFileAuthorized: async () => {
      singles++; active++; peak = Math.max(peak, active)
      await new Promise((done) => setImmediate(done))
      active--; return true
    }
  })
  emit({ kind: 'authorizationFallback', items: queue.length, singles, peakConcurrent: peak, delegated: result.delegated })
}

// Run the exact computed/watch source from PlayingMusic, with geometry stubbed.
const playing = read('src/renderer/src/components/PlayingMusic.vue')
const componentSource = 'const lyricVisibility = computed(() => lyricsManagement.document.value);\n' +
  excerpt(playing, 'const managedLyricOverride =', 'const isTtmlLyrics =') +
  excerpt(playing, 'function usesManualManagedLayer(', 'const currentLyricOffsetSeconds =') +
  excerpt(playing, 'watch(\n  () => [currentTrack.value?.id, lyricLines.value]', 'function lyricTime(') +
  '\nreturn { lyricLines, displayLyricLines };'
const publisher = read('src/renderer/src/app/useDesktopLyricsPublisher.ts')
const publisherSource = publisher.slice(publisher.indexOf('function transportState')).replace('export function', 'function') + '\nreturn useDesktopLyricsPublisher;'
for (const count of [300, 3000]) {
  const text = Array.from({ length: count }, (_, index) => {
    const seconds = index * 2
    return `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.00]歌词第 ${index} 行`
  }).join('\n')
  const queueRow = { id: 'local:lyric-audit', filePath: 'E:/Music/Lyrics.flac', title: 'Audit', artist: 'Audit', lyrics: null, translatedLyrics: null }
  const currentTrack = ref({ ...queueRow, lyrics: text })
  const lyricsManagement = { document: ref(DEFAULT_LYRICS_MANAGEMENT), entryFor: () => undefined, effectiveOffsetSeconds: () => 0 }
  let componentParses = 0, desktopParses = 0, recenterCalls = 0, publishedSessions = 0, publishedCharacters = 0
  const componentBuild = (...args) => { componentParses++; return buildLyricLines(...args) }
  const desktopBuild = (...args) => { desktopParses++; return buildLyricLines(...args) }
  const lyricViewport = { activate: () => {}, recenter: async () => { recenterCalls++ } }
  const component = new Function('computed', 'watch', 'currentTrack', 'lyricsManagement', 'projectManagedLyrics', 'buildLyricLines', 'projectLyricDisplay', 'lyricViewport', 'lyricsViewActive', ts(componentSource))(
    computed, watch, currentTrack, lyricsManagement, projectManagedLyrics, componentBuild, projectLyricDisplay, lyricViewport, ref(true))
  void component.displayLyricLines.value
  const player = { currentTrack, lyricsLoadState: ref({ trackId: queueRow.id, status: 'ready' }), playbackClockSnapshot: ref({ epoch: 1, state: 'playing', position: 30, duration: 240, rate: 1 }) }
  const windowStub = { api: { desktopLyrics: {
    publishSession: (session) => { publishedSessions++; publishedCharacters += JSON.stringify(session).length },
    publishClock: () => {}, onEnabledChanged: () => () => {}, onResyncRequested: () => () => {}
  } } }
  const setupPublisher = new Function('window', 'watch', 'onBeforeUnmount', 'usePlayerStore', 'useLyricsManagement', 'useSettingsStore', 'projectManagedLyrics', 'buildLyricLines', 'projectDesktopLyricsLines', 'DESKTOP_LYRICS_CLOCK_INTERVAL_MS', ts(publisherSource))(
    windowStub, watch, () => {}, () => player, () => lyricsManagement, () => ({ settings: ref({ desktopLyrics: { enabled: true } }) }), projectManagedLyrics, desktopBuild, projectDesktopLyricsLines, DESKTOP_LYRICS_CLOCK_INTERVAL_MS)
  setupPublisher()
  const baseline = { componentParses, desktopParses, recenterCalls, publishedSessions, publishedCharacters }
  const timings = []
  for (let update = 0; update < 20; update++) {
    const started = performance.now()
    // Same queue row and same lyric text, as in non-switch applyNativePlaybackInfo.
    currentTrack.value = mergeTrackTransientData(queueRow, currentTrack.value)
    await nextTick()
    void component.displayLyricLines.value
    timings.push(performance.now() - started)
  }
  emit({ kind: 'unchangedLyricsMetadataRefresh', lines: count, updates: 20,
    componentParses: componentParses - baseline.componentParses,
    desktopParses: desktopParses - baseline.desktopParses,
    recenterCalls: recenterCalls - baseline.recenterCalls,
    publishedSessions: publishedSessions - baseline.publishedSessions,
    publishedCharacters: publishedCharacters - baseline.publishedCharacters,
    medianMs: percentile(timings, .5), peakMs: Math.max(...timings) })
}

// Check actual native field names: timing in ms alone should stay deduplicated.
if (typeof createDefaultPlaybackInfo === 'function') {
  const info = createDefaultPlaybackInfo('wasapi', 'default', false, { routingMode: 'default', sampleRate: 48000, bitDepth: 32, channels: 2 })
  const base = createPlaybackInfoFanoutSignature(info, true)
  const position = createPlaybackInfoFanoutSignature({ ...info, position: info.position + 1 }, true)
  const plugin = { id: 'audit', enabled: true, loaded: true, lastProcessMs: .01 }
  const before = createPlaybackInfoFanoutSignature({ ...info, outputInfo: { ...info.outputInfo, nativeDsp: { plugins: [plugin] } } }, true)
  const after = createPlaybackInfoFanoutSignature({ ...info, outputInfo: { ...info.outputInfo, nativeDsp: { plugins: [{ ...plugin, lastProcessMs: .02 }] } } }, true)
  emit({ kind: 'fanoutDedupe', positionOnlySuppressed: base === position, nativeLastProcessMsOnlySuppressed: before === after })
}

// Use real temporary files and the actual manager, with a controlled clock.
// Inspect the transpiled private Map only in this audit probe.
{
  const { FileAnalysisManager } = await load('src/main/audio/fileAnalysisManager.ts')
  const fixture = await mkdtemp(join(tmpdir(), 'twilight-failure-retention-'))
  let now = 1, succeed = false
  const manager = new FileAnalysisManager({
    cache: { get: async () => null, set: async () => {}, deleteIfMatches: async () => true },
    analyzeFile: async () => succeed ? { bpm: 120 } : null,
    now: () => now, failureCooldownMs: 600000,
    buildIdentity: (request) => request.filePath
  })
  const requests = []
  for (let index = 0; index < 256; index++) {
    const filePath = join(fixture, `${index}.flac`)
    await writeFile(filePath, 'audit fixture; decoding is stubbed')
    const request = { trackId: `audit:${index}`, filePath }
    requests.push(request)
    const result = await manager.requestAnalysis(request)
    if (result.status !== 'failed') throw new Error(`Unexpected failure fixture result: ${result.status}`)
  }
  const afterFailures = manager.failures.size
  now += 600001
  const expiredEntries = [...manager.failures.values()].filter((failure) => now - failure.failedAt > 600000).length
  succeed = true
  const retry = await manager.requestAnalysis(requests[0])
  emit({ kind: 'analysisFailureRetention', failedFiles: requests.length, afterFailures, expiredEntries,
    retryStatus: retry.status, afterSuccessfulRetry: manager.failures.size,
    inFlightAfterCompletion: manager.inFlight.size, activeGenerationsAfterCompletion: manager.activeGenerations.size })
}
