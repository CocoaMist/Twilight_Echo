// Explicit hardware validation, excluded from ordinary/no-device CI.
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const args = process.argv.slice(2)
  const option = (key, fallback = '') => {
    const i = args.indexOf(key)
    return i >= 0 ? args[i + 1] : fallback
  }
  const modulePath = option('--module'),
    device = option('--device'),
    outgoing = option('--out'),
    incoming = option('--in')
  if (!modulePath || !device || !outgoing || !incoming)
    throw new Error(
      'Usage: node scripts/automix-playback-smoke.cjs --module <addon> --device <endpoint> --out <music> --in <music> [--backend wasapi|wasapi-exclusive] [--report <json>]'
    )
  if (process.env.TAE_AUTOMIX_EXPERIMENTAL !== '1')
    throw new Error(
      'Start this process with TAE_AUTOMIX_EXPERIMENTAL=1; the native runtime reads its startup environment'
    )
  process.env.PATH = path.dirname(path.resolve(modulePath)) + path.delimiter + process.env.PATH
  const native = require(path.resolve(modulePath))
  const read = (value) => (typeof value === 'string' ? JSON.parse(value) : value)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const featureFile = option('--features'),
    requiredStyle = option('--require-style')
  const report = {
    format: 1,
    passed: false,
    kind: featureFile ? 'automix-analyzed-real-playback' : 'automix-conservative-real-playback',
    backend: option('--backend', 'wasapi'),
    device,
    volume: 0.02,
    sources: [outgoing, incoming],
    observations: [],
    asioHardware: 'not-tested-user-deferred',
    listeningQuality: 'not-rated',
    fullSong: 'not-tested',
    soak24Hours: 'not-tested'
  }
  try {
    const metadata = read(native.GetMetadata(outgoing))
    const duration = Number(metadata.duration || metadata.durationSeconds)
    if (!Number.isFinite(duration) || duration < 20)
      throw new Error('Outgoing track requires a known duration of at least 20 seconds')
    native.SetVolume(report.volume)
    native.SetOutputBackend(report.backend)
    native.SetOutputDevice(device)
    native.SetOutputConfig(
      JSON.stringify({
        preferredBufferSize: Number(option('--frames', '256')),
        playbackPolicy: 'continuity-first',
        continuitySampleRate: Number(option('--rate', '48000'))
      })
    )
    native.SetDspConfig(JSON.stringify({ gapless: true, dspEnabled: false }))
    native.SetAutoMixConfig(
      JSON.stringify({ enabled: true, allowIntelligentSkip: false, maxTransitionSeconds: 4 })
    )
    native.LoadQueue(
      JSON.stringify([
        { id: 'automix-smoke-out', source: outgoing },
        { id: 'automix-smoke-in', source: incoming }
      ]),
      0
    )
    native.Play(outgoing, Math.max(0, duration - Number(option('--lead-seconds', '10'))))
    if (featureFile) {
      const features = JSON.parse(fs.readFileSync(featureFile, 'utf8'))
      if (features.outgoingSource !== outgoing || features.incomingSource !== incoming)
        throw new Error('Feature file source identities disagree with the playback pair')
      native.SetAutoMixFeatures(
        JSON.stringify({
          pairRevision: read(native.GetAutoMixStatus()).pairRevision,
          outgoing: { id: 'automix-smoke-out', source: outgoing, features: features.outgoing },
          incoming: { id: 'automix-smoke-in', source: incoming, features: features.incoming }
        })
      )
      report.featureFile = path.resolve(featureFile)
    }
    let mixing = false,
      promoted = false,
      lastIndex = 0,
      promotions = 0
    let transitionSeconds = 0
    const deadline = Date.now() + Number(option('--lead-seconds', '10')) * 1000 + 12000
    while (Date.now() < deadline && !promoted) {
      const status = read(native.GetAutoMixStatus()),
        playback = read(native.GetPlaybackInfo())
      report.observations.push({
        autoMix: status,
        source: playback.source,
        position: playback.position,
        queueIndex: playback.queueIndex,
        outputPerfect: playback.outputPerfect,
        perfectReasonCode: playback.perfectReasonCode,
        actualBackend: playback.outputInfo?.actualBackend
      })
      if (status.state === 'mixing') {
        mixing = true
        transitionSeconds = status.transitionSeconds
        if (requiredStyle && status.styleId !== Number(requiredStyle))
          throw new Error(`Expected style ${requiredStyle}, observed ${status.styleId}`)
        // PlaybackInfo is published by the existing 100 ms engine clock;
        // compare inside the overlap, after its first status publication.
        if (
          status.progress > 0.06 &&
          (playback.outputPerfect !== false || playback.perfectReasonCode !== 'automix_active')
        )
          throw new Error('AutoMix canonical output diagnosis disagrees with mixed playback')
      }
      if (playback.queueIndex !== lastIndex) {
        promotions++
        lastIndex = playback.queueIndex
      }
      if (playback.source === incoming) {
        promoted = true
        if (playback.position < transitionSeconds - 0.1)
          throw new Error('Incoming track restarted instead of resuming its audible transition')
      }
      await pause(50)
    }
    if (!mixing || !promoted || promotions !== 1)
      throw new Error(
        `Transition incomplete: mixing=${mixing}, promoted=${promoted}, switches=${promotions}`
      )
    await pause(1000)
    report.finalPlayback = read(native.GetPlaybackInfo())
    const performance =
      report.finalPlayback.outputInfo?.renderPerformance ?? report.finalPlayback.renderPerformance
    report.performance = {
      ...performance,
      p999BinWidthDeadlineRatio: 0.001,
      requestedRate: Number(option('--rate', '48000')),
      requestedFrames: Number(option('--frames', '256')),
      actualRate: report.finalPlayback.actualSampleRate,
      actualDeviceBufferFrames: report.finalPlayback.outputInfo?.bufferSizeFrames,
      meanObservedCallbackPeriodMilliseconds:
        performance?.callbackCount > 0
          ? performance.totalDeadlineNanoseconds / performance.callbackCount / 1000000
          : null,
      enoughTailSamples: (performance?.autoMixSegmentCount ?? 0) >= 10000,
      matrixComplete: false,
      releaseGatePassed: false
    }
    report.passed = true
  } catch (error) {
    report.error = error.message
  } finally {
    native.Stop()
    const output = option('--report')
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(
      JSON.stringify({
        passed: report.passed,
        backend: report.backend,
        device,
        observations: report.observations.length,
        error: report.error
      })
    )
    process.exit(report.passed ? 0 : 1)
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
