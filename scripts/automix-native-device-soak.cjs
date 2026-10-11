const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const expect = (ok, message) => {
  if (!ok) throw new Error(message)
}

function parseArgs(argv) {
  const result = { seconds: 60, volume: 0.02, buffer: 512, backend: 'wasapi' }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    expect(
      [
        'module',
        'device',
        'corpus',
        'evidence',
        'output',
        'seconds',
        'volume',
        'buffer',
        'backend'
      ].includes(key),
      `Unknown argument ${argv[i]}`
    )
    expect(i + 1 < argv.length, `Missing value for ${argv[i]}`)
    result[key] = ['seconds', 'volume', 'buffer'].includes(key) ? Number(argv[++i]) : argv[++i]
  }
  for (const key of ['module', 'device', 'corpus', 'evidence', 'output'])
    expect(result[key], `--${key} required`)
  expect(Number.isFinite(result.seconds) && result.seconds >= 30, '--seconds must be >=30')
  expect(
    Number.isFinite(result.volume) && result.volume >= 0 && result.volume <= 0.05,
    'Development soak volume must be 0..0.05'
  )
  expect(
    ['wasapi', 'wasapi-exclusive'].includes(result.backend),
    'Explicit WASAPI backend required'
  )
  return result
}
function resolveAnalysisDirectory(directory, evidence) {
  if (!evidence.analysisReuse) return directory
  const origin = path.resolve(evidence.analysisReuse.directory)
  const file = path.join(origin, 'pairs.validation.json')
  expect(sha(file) === evidence.analysisReuse.reportSha256, 'Reused analysis report changed')
  const previous = json(file)
  expect(
    previous.manifestSha256 === evidence.manifestSha256 &&
      previous.analysisDllSha256 === evidence.analysisDllSha256,
    'Reused analysis corpus/runtime provenance mismatch'
  )
  expect(
    Object.keys(previous.graphs).length === Object.keys(evidence.graphs).length &&
      Object.entries(evidence.graphs).every(([name, digest]) => previous.graphs[name] === digest),
    'Reused public model graphs changed'
  )
  return origin
}
async function run(options) {
  const modulePath = path.resolve(options.module)
  process.env.PATH = `${path.dirname(modulePath)}${path.delimiter}${process.env.PATH || ''}`
  const audio = require(modulePath)
  const devices = JSON.parse(audio.EnumerateDevices())
  const device = devices.find((d) => d.id === options.device && d.id !== 'auto')
  expect(device, 'Select an enumerated concrete output device ID')
  const corpus = json(options.corpus),
    evidence = json(path.join(options.evidence, 'pairs.validation.json'))
  expect(evidence.manifestSha256 === sha(options.corpus), 'Corpus changed since analysis/render')
  const analysisDirectory = resolveAnalysisDirectory(options.evidence, evidence)
  const cases = []
  for (const mode of ['natural', 'dj']) {
    const eligible = evidence.pairs.filter((p) => p.modes[mode].intelligent)
    const pair = eligible.find((p) => p.modes[mode].currentRate !== 1) ?? eligible[0]
    expect(pair, `No genuinely prepared real pair for ${mode}`)
    const source = corpus.pairs.find((p) => p.id === pair.id)
    const windows =
      evidence.schemaVersion === 2
        ? ['current', 'next'].map((deck) =>
            json(path.join(analysisDirectory, `${pair.id}-${deck}-windows.json`))
          )
        : null
    const features = pair.sourceSha256.map((hash, deck) => {
      if (windows) {
        expect(
          windows[deck].every(
            (f) =>
              f.ok &&
              f.sourceIdentity === hash &&
              /^twilight-automix-native-1:[a-f0-9]{64}:[a-f0-9]{64}$/.test(f.modelVersion) &&
              f.coverage.endSeconds - f.coverage.startSeconds <= 30.001
          ),
          'V2 window binding mismatch'
        )
        return windows[deck][0]
      }
      const stored = json(
        path.join(analysisDirectory, `${hash}-${deck ? 'head' : 'tail'}.analysis.json`)
      )
      expect(stored.dllSha256 === evidence.analysisDllSha256, 'Analysis provenance mismatch')
      expect(
        stored.features?.ok &&
          stored.features.sourceIdentity === hash &&
          Object.entries(evidence.graphs).every(
            ([name, digest]) => stored.graphs?.[name] === digest
          ),
        'Analysis source/model provenance mismatch'
      )
      return stored.features
    })
    expect(
      sha(source.current) === pair.sourceSha256[0] && sha(source.next) === pair.sourceSha256[1],
      'Real source bytes changed'
    )
    cases.push({ mode, pair, source, features, windows })
  }
  const startedAt = new Date().toISOString(),
    start = performance.now()
  const report = {
    schemaVersion: 1,
    kind: 'real-device-automix-soak',
    startedAt,
    moduleSha256: sha(modulePath),
    dllSha256: sha(path.join(path.dirname(modulePath), 'twilight-audio-engine.dll')),
    renderEvidenceSha256: sha(path.join(options.evidence, 'pairs.validation.json')),
    analysisDirectory,
    analysisReuse: evidence.analysisReuse ?? null,
    device,
    requestedSeconds: options.seconds,
    verifiedRunSeconds: 0,
    stress24HoursPassed: false,
    callbackDeadlineMisses: 0,
    underruns: 0,
    completedCycles: 0,
    scope:
      'Native prepared PCM transport on a real WASAPI device; human listening and online account are separate gates',
    cycles: [],
    memory: [],
    passed: false
  }
  const output = path.resolve(options.output)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const save = () => {
    const tmp = `${output}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2))
    fs.renameSync(tmp, output)
  }
  const info = () => JSON.parse(audio.GetPlaybackInfo())
  let lastObservation = Date.now()
  const checkStop = () => {
    const now = Date.now()
    report.maxObservationGapMilliseconds = Math.max(
      report.maxObservationGapMilliseconds ?? 0,
      now - lastObservation
    )
    expect(
      now - lastObservation < 10000,
      'Observation gap exceeds 10 seconds; sleep/suspension cannot count as continuous stress'
    )
    lastObservation = now
    if (fs.existsSync(`${output}.stop`)) {
      report.cancelled = true
      throw new Error('Stopped by explicit stop file')
    }
  }
  try {
    let cycle = 0
    while (performance.now() - start < options.seconds * 1000) {
      checkStop()
      const test = cases[cycle % cases.length],
        { mode, pair, source, features, windows } = test
      report.activeCycle = { cycle, mode, pair: pair.id, stage: 'configuring' }
      audio.Stop()
      audio.SetOutputBackend(options.backend)
      audio.SetOutputDevice(device.id)
      audio.SetOutputConfig(
        JSON.stringify({
          preferredBufferSize: options.buffer,
          continuityFirst: true,
          routingMode: 'auto'
        })
      )
      audio.SetDspConfig(JSON.stringify({ gapless: true, crossfadeSeconds: 2, fftEnabled: false }))
      audio.SetReplayGainMode('off', 0, 0, true)
      audio.SetVolume(options.volume)
      audio.SetAutoMixMode(mode)
      audio.LoadQueue(
        JSON.stringify([
          {
            id: 'outgoing',
            source: source.current,
            duration: features[0].coverage.durationSeconds
          },
          { id: 'incoming', source: source.next, duration: features[1].coverage.durationSeconds }
        ]),
        0
      )
      const frameRate = 48000 // pair renderer provenance
      audio.Play(source.current, Math.max(0, pair.modes[mode].currentStart / frameRate - 4))
      await sleep(300)
      let before = info()
      expect(
        before.actualSampleRate === frameRate,
        'Device source mapping needs a 48000Hz output; regenerate renderer evidence for other rates'
      )
      expect(
        before.actualBackend === options.backend,
        'Requested actual device backend was not opened'
      )
      report.activeCycle.stage = 'preparing'
      const request = {
        ruleVersion: 'twilight-rules-3',
        currentSource: source.current,
        nextSource: source.next,
        currentSourceStartSeconds: 0,
        currentSourceEndSeconds: features[0].coverage.durationSeconds,
        nextSourceStartSeconds: 0,
        nextSourceEndSeconds: features[1].coverage.durationSeconds,
        currentFeatures: features[0],
        nextFeatures: features[1],
        ...(mode === 'dj' && windows ? { currentWindows: windows[0], nextWindows: windows[1] } : {})
      }
      const selected = JSON.parse(audio.SelectAutoMix(JSON.stringify(request)))
      expect(selected.ok, `Selection failed: ${selected.reason}`)
      audio.PrepareAutoMix(JSON.stringify({ ...request, selectionId: selected.selectionId }))
      for (let i = 0; i < 2000; i++) {
        before = info()
        if (before.autoMixState !== 'preparing') break
        await sleep(10)
      }
      expect(before.autoMixState === 'ready', `Preparation failed: ${before.autoMixReason}`)
      audio.SubmitAutoMix(before.autoMixPlanId)
      report.activeCycle.stage = 'handoff'
      report.activeCycle.planId = before.autoMixPlanId
      save()
      let mixed = false,
        paused = false,
        promotions = 0,
        previous = source.current,
        after = before
      const deadline = performance.now() + 45000
      while (performance.now() < deadline) {
        checkStop()
        await sleep(50)
        after = info()
        if (after.autoMixState === 'mixing') {
          mixed = true
          expect(!after.outputPerfect, 'AutoMix falsely claimed outputPerfect')
          if (!paused) {
            audio.Pause()
            await sleep(100)
            const frozen = info()
            await sleep(200)
            const check = info()
            expect(
              check.position === frozen.position &&
                check.autoMixOutputSeconds === frozen.autoMixOutputSeconds,
              'Pause did not freeze both mapped clocks'
            )
            audio.Pause()
            paused = true
          }
        }
        if (after.source !== previous) {
          promotions++
          previous = after.source
        }
        if (after.source === source.next) break
        expect(after.state !== 'stopped', 'Playback stopped before native handoff')
      }
      expect(
        mixed && paused && promotions === 1 && after.queueIndex === 1,
        'Missing intelligent overlap or duplicate queue promotion'
      )
      expect(
        after.position >= selected.nextEndSeconds - 0.02,
        'Incoming source continuation went backwards'
      )
      await sleep(150)
      expect(info().queueIndex === 1, 'Queue advanced more than once')
      const diagnostics = after.outputInfo?.diagnostics ?? after.diagnostics ?? {}
      const render = after.outputInfo?.renderPerformance ?? after.renderPerformance ?? {}
      report.callbackDeadlineMisses += render.deadlineMissCount ?? 0
      report.underruns += diagnostics.sessionUnderrunCount ?? 0
      const load =
        render.totalDeadlineNanoseconds > 0
          ? (100 * render.totalCallbackNanoseconds) / render.totalDeadlineNanoseconds
          : Infinity
      expect(
        render.callbackCount > 0 && render.deadlineMissCount === 0 && load < 80,
        'Callback performance gate failed'
      )
      expect(
        diagnostics.sessionUnderrunCount === 0 && diagnostics.deviceLostCount === 0,
        'Underrun/device loss detected'
      )
      report.cycles.push({
        cycle,
        mode,
        pair: pair.id,
        planId: before.autoMixPlanId,
        promotions,
        paused,
        after,
        callbackDeadlineLoadPercent: load
      })
      fs.appendFileSync(`${output}.cycles.jsonl`, JSON.stringify(report.cycles.at(-1)) + '\n')
      report.completedCycles++
      if (report.cycles.length > 64) report.cycles.shift()
      // Exercise control invalidation/recovery before the following preparation.
      report.activeCycle.stage = 'control-invalidation'
      audio.Seek(1)
      audio.CancelAutoMix()
      audio.SetAutoMixMode(mode === 'natural' ? 'dj' : 'natural')
      expect(info().autoMixState !== 'mixing', 'Seek/mode retained an old live plan')
      report.memory.push({
        elapsedSeconds: (performance.now() - start) / 1000,
        rssBytes: process.memoryUsage().rss
      })
      const elapsed = (performance.now() - start) / 1000
      if (elapsed >= 1800 && elapsed <= 3600) {
        report.memoryBaseline ??= { bytesSum: 0, count: 0 }
        report.memoryBaseline.bytesSum += process.memoryUsage().rss
        report.memoryBaseline.count++
      }
      if (report.memory.length > 2048) report.memory.splice(1, 1)
      report.verifiedRunSeconds = (performance.now() - start) / 1000
      checkStop()
      delete report.activeCycle
      save()
      console.log(
        JSON.stringify({
          cycle,
          mode,
          pair: pair.id,
          verifiedSeconds: report.verifiedRunSeconds,
          load
        })
      )
      cycle++
    }
    expect(
      report.cycles.some((c) => c.mode === 'natural') && report.cycles.some((c) => c.mode === 'dj'),
      'Both modes must play through a device'
    )
    report.passed = true
    // 24 hours means elapsed successful operation; a shorter probe never passes it.
    if (report.verifiedRunSeconds >= 86400) {
      expect(report.memoryBaseline?.count > 0, 'Missing warmed memory baseline')
      const recent = report.memory.slice(-100)
      const growth =
        recent.reduce((sum, m) => sum + m.rssBytes, 0) / recent.length -
        report.memoryBaseline.bytesSum / report.memoryBaseline.count
      report.warmedMemoryGrowthBytes = growth
      expect(
        growth <= 16 * 1024 * 1024,
        'Long-run RSS growth exceeds 16MiB; investigate retained generations'
      )
      report.stress24HoursPassed = true
    }
  } catch (error) {
    report.passed = false
    report.error = error.message
    report.failureCapturedAt = new Date().toISOString()
    report.failureElapsedSeconds = (performance.now() - start) / 1000
    try {
      report.failurePlayback = info()
    } catch (capture) {
      report.failurePlaybackError = capture.message
    }
    try {
      report.failureDiagnosticLog = JSON.parse(audio.GetDiagnosticLog(0, 256))
    } catch (capture) {
      report.failureDiagnosticLogError = capture.message
    }
    throw error
  } finally {
    try {
      audio.Stop()
    } finally {
      report.finishedAt = new Date().toISOString()
      save()
    }
  }
  return report
}
if (require.main === module)
  run(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
module.exports = { parseArgs, resolveAnalysisDirectory, run }
