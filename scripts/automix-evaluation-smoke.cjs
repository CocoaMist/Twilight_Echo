// Runs the packaged main/preload/renderer in an isolated hidden Electron harness.
// Native utility processes are real. --playback additionally runs real song
// analysis and transitions, without injecting features or mocking scheduling.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')

function parse(argv) {
  argv = argv.filter((value) => !value.startsWith('--user-data-dir='))
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(
      ['--package', '--output', '--profile', '--restore', '--playback', '--stems'].includes(
        argv[index]
      )
    )
    assert.ok(argv[index + 1])
    options[argv[index].slice(2)] = argv[index + 1]
  }
  assert.ok(options.package && options.output)
  return options
}

function verifyTempoMapping(observation, fixture) {
  const mixEvents = observation.events.filter(
    (value) => value.phase === 'mixing' && value.queueIndex === 0
  )
  const firstMix = mixEvents[0],
    lastMix = mixEvents.at(-1)
  assert.ok(firstMix && lastMix && lastMix.outputSeconds > firstMix.outputSeconds)
  const outputSpan = lastMix.outputSeconds - firstMix.outputSeconds
  observation.observedCurrentRate = (lastMix.position - firstMix.position) / outputSpan
  observation.observedNextRate = (lastMix.nextSeconds - firstMix.nextSeconds) / outputSpan
  if (fixture.requireTempoChange) {
    assert.ok(
      Math.abs(observation.observedNextRate - 1) > 0.015,
      'DJ fixture rendered an original-speed fade instead of its tempo-matched plan'
    )
    assert.ok(Math.abs(observation.observedNextRate - 1) <= 0.121)
  }
}

async function runElectron(options) {
  const { app, BrowserWindow } = require('electron')
  const packageDir = path.resolve(options.package)
  const resources = path.join(packageDir, 'resources')
  const archive = path.join(resources, 'app.asar')
  app.setPath('userData', path.resolve(options.profile))
  app.setAppPath(archive)
  // Electron exposes a read-only but configurable property. Assignment silently
  // leaves the harness runtime path in place instead of the packaged resources.
  Object.defineProperty(process, 'resourcesPath', { value: resources })
  // Only window visibility is adapted; the actual application owns all IPC,
  // settings, scheduling, preload security and native audio-service calls.
  BrowserWindow.prototype.show = function () {
    // Keep the real renderer hidden during automated evaluation.
  }
  BrowserWindow.prototype.showInactive = function () {
    // Keep auxiliary windows hidden during automated evaluation.
  }
  const report = {
    scope: 'Packaged application in hidden Electron harness with real native utility processes',
    launchDirectory: process.cwd(),
    packagedRuntimeSha256: Object.fromEntries(
      ['twilight-audio-engine.dll', 'twilight_audio_node.node'].map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(resources, 'audio-engine', name)))
          .digest('hex')
      ])
    ),
    restore: options.restore === '1',
    startedAt: new Date().toISOString(),
    passed: false,
    observations: []
  }
  const save = () => fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const timeout = options.playback ? 600_000 : 55_000
  let deadline = Date.now() + timeout
  const poll = async (read, accepts, description) => {
    let last
    while (Date.now() < deadline) {
      last = await read()
      if (accepts(last)) return last
      await sleep(100)
    }
    throw new Error(`${description}: ${JSON.stringify(last)}`)
  }
  const fatal = setTimeout(() => {
    report.error = 'Application smoke deadline exceeded'
    save()
    app.exit(1)
  }, timeout + 5000)
  try {
    report.phase = 'loading-main'
    save()
    require(path.join(archive, 'out/main/index.js'))
    report.phase = 'loading-renderer'
    save()
    const window = await poll(
      () =>
        BrowserWindow.getAllWindows().find((value) =>
          /\/renderer\/index\.html/.test(value.webContents.getURL().replaceAll('\\', '/'))
        ),
      (value) => Boolean(value && !value.webContents.isLoading()),
      'Main renderer did not load'
    )
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    await poll(
      () => evaluate('Boolean(window.api?.settings && window.api?.audioEngine)'),
      Boolean,
      'Preload API unavailable'
    )
    // getPlaybackInfo awaits production engine initialization, including service
    // readiness. No renderer/main/native boundary is mocked.
    const initial = await evaluate('window.api.settings.get()')
    assert.equal(initial.settings.autoMixStemCacheMiB, 512, 'Legacy profile cache migration failed')
    assert.equal(
      initial.settings.autoMixStemDevice,
      'auto',
      'Stem device preference was not restored'
    )
    assert.equal(
      initial.settings.autoMixStemMode,
      'auto',
      'Stem switch preference was not restored'
    )
    report.stemCapabilities = await evaluate(
      'window.api.audioEngine.getAutoMixStemCapabilities(true)'
    )
    assert.ok(['missing', 'ready', 'unavailable'].includes(report.stemCapabilities.status))
    if (options.stems === 'missing') assert.equal(report.stemCapabilities.status, 'missing')
    if (options.stems === 'gpu' || options.stems === 'cpu') {
      assert.equal(report.stemCapabilities.status, 'ready')
      assert.equal(report.stemCapabilities.cpu, true)
      assert.equal(report.stemCapabilities.gpu, options.stems === 'gpu')
    }
    if (process.env.TWILIGHT_AUTOMIX_STEM_PACK)
      assert.equal(report.stemCapabilities.status, 'ready')
    report.stemPreferences = []
    for (const [device, mode] of [
      ['cpu', 'off'],
      ['gpu', 'auto'],
      ['auto', 'auto']
    ]) {
      const saved = await evaluate(
        `window.api.settings.update(${JSON.stringify({ autoMixStemDevice: device, autoMixStemMode: mode })})`
      )
      assert.equal(saved.settings.autoMixStemDevice, device)
      assert.equal(saved.settings.autoMixStemMode, mode)
      const disk = JSON.parse(fs.readFileSync(path.join(options.profile, 'settings.json'), 'utf8'))
      assert.equal(disk.autoMixStemDevice, device)
      assert.equal(disk.autoMixStemMode, mode)
      report.stemPreferences.push({ device, mode })
    }
    report.stemCacheCapacities = []
    for (const capacity of [0, 256, 512, 1024, 2048, 512]) {
      const saved = await evaluate(
        `window.api.settings.update(${JSON.stringify({ autoMixStemCacheMiB: capacity })})`
      )
      assert.equal(saved.settings.autoMixStemCacheMiB, capacity)
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(options.profile, 'settings.json'), 'utf8'))
          .autoMixStemCacheMiB,
        capacity
      )
      report.stemCacheCapacities.push(capacity)
    }
    const initialMode = options.restore === '1' ? 'natural' : 'off'
    assert.equal(initial.settings.autoMixMode, initialMode)
    const nativeInitial = await poll(
      () => evaluate('window.api.audioEngine.getPlaybackInfo()'),
      (value) => value.autoMixMode === initialMode,
      'Initial native mode mismatch'
    )
    report.loadedRuntime = await poll(
      () => {
        const file = path.join(app.getPath('logs'), 'audio', 'audio-diagnostics.jsonl')
        if (!fs.existsSync(file)) return null
        return fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .map((entry) => entry.details?.nativeRuntime)
          .find(Boolean)
      },
      Boolean,
      'Loaded engine identity missing from diagnostics'
    )
    assert.equal(
      report.loadedRuntime.addonPath.fingerprint,
      createHash('sha256')
        .update(path.join(resources, 'audio-engine', 'twilight_audio_node.node'))
        .digest('hex')
        .slice(0, 16)
    )
    for (const [name, digest] of Object.entries(report.packagedRuntimeSha256))
      assert.equal(report.loadedRuntime[name], digest, 'Loaded packaged runtime digest mismatch')
    report.observations.push({ savedMode: initialMode, nativeMode: nativeInitial.autoMixMode })
    for (const mode of options.restore === '1' ? ['off'] : ['natural', 'dj', 'off', 'natural']) {
      const saved = await evaluate(
        `window.api.settings.update(${JSON.stringify({ autoMixMode: mode })})`
      )
      assert.equal(saved.settings.autoMixMode, mode)
      const native = await poll(
        () => evaluate('window.api.audioEngine.getPlaybackInfo()'),
        (value) => value.autoMixMode === mode,
        'Selected native mode mismatch'
      )
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(options.profile, 'settings.json'), 'utf8'))
          .autoMixMode,
        mode
      )
      report.observations.push({
        savedMode: mode,
        nativeMode: native.autoMixMode,
        nativeState: native.autoMixState
      })
    }
    if (options.playback) {
      const fixtures = JSON.parse(fs.readFileSync(options.playback, 'utf8')).pairs
      report.transitions = []
      await evaluate(`window.__autoMixEvents = [];
        window.api.audioEngine.onPlaybackInfo(info => window.__autoMixEvents.push({
          state:info.state,source:info.source,queueIndex:info.queueIndex,position:info.position,
          duration:info.duration,phase:info.autoMixState,reason:info.autoMixReason,
          strategy:info.autoMixStrategy,
          planId:info.autoMixPlanId,outputSeconds:info.autoMixOutputSeconds,
          nextSeconds:info.autoMixNextSourceSeconds,outputPerfect:info.outputPerfect
        })); void 0;`)
      for (const rawFixture of fixtures) {
        const fixture = {
          ...rawFixture,
          current: path.resolve(rawFixture.current),
          next: path.resolve(rawFixture.next)
        }
        deadline = Date.now() + 110_000
        const observation = { id: fixture.id, mode: fixture.mode, snapshots: [] }
        report.transitions.push(observation)
        await evaluate('window.api.audioEngine.stop()')
        await evaluate(
          `window.api.settings.update(${JSON.stringify({ autoMixMode: fixture.enableDuringPlayback ? 'off' : fixture.mode })})`
        )
        const tracks = []
        for (const source of [fixture.current, fixture.next]) {
          const metadata = await evaluate(
            `window.api.audioEngine.getMetadata(${JSON.stringify(source)}).then(m=>({duration:m.duration}))`
          )
          assert.ok(metadata.duration > 30, JSON.stringify(metadata))
          tracks.push({
            id: source,
            source,
            duration: Math.round(metadata.duration),
            actualDuration: metadata.duration
          })
        }
        observation.tracks = tracks
        await evaluate(`window.api.audioEngine.loadQueue(${JSON.stringify(tracks)})`)
        const start = tracks[0].actualDuration - 28
        const result = await evaluate(
          `window.api.audioEngine.play(${JSON.stringify(fixture.current)},${start})`
        )
        assert.equal(result.nativeStarted, true, JSON.stringify(result))
        await poll(
          () => evaluate('window.api.audioEngine.getPlaybackInfo()'),
          (info) => info.source === fixture.current && info.state === 'playing',
          'Real song did not start'
        )
        await evaluate('window.api.audioEngine.togglePause()')
        await poll(
          () => evaluate('window.api.audioEngine.getPlaybackInfo()'),
          (info) => info.state === 'paused',
          'Preparation pause failed'
        )
        if (fixture.enableDuringPlayback) {
          await evaluate(
            `window.api.settings.update(${JSON.stringify({ autoMixMode: fixture.mode })})`
          )
          const paused = await evaluate('window.api.audioEngine.getPlaybackInfo()')
          assert.equal(paused.state, 'paused', 'Enabling AutoMix must preserve pause')
          observation.enabledDuringPlayback = true
        }
        const ready = await poll(
          async () => {
            const info = await evaluate('window.api.audioEngine.getPlaybackInfo()')
            observation.snapshots.push({
              phase: info.autoMixState,
              reason: info.autoMixReason,
              strategy: info.autoMixStrategy,
              planId: info.autoMixPlanId
            })
            save()
            return info
          },
          (info) =>
            fixture.expectedFallback
              ? info.autoMixState === 'degraded' && info.autoMixReason === fixture.expectedFallback
              : info.autoMixState === 'ready' &&
                info.autoMixPlanId > 0 &&
                (!fixture.strategy || info.autoMixStrategy === fixture.strategy),
          'Real model transition never became ready'
        )
        if (fixture.expectedFallback) {
          assert.equal(ready.nativePlaybackActive, true)
          assert.equal(ready.state, 'paused')
          assert.equal(ready.preloadReady, true)
          observation.expectedFallback = ready.autoMixReason
          observation.decodedDuration = ready.duration
          observation.decodedNextDuration = ready.upcomingTrack?.duration
          observation.passed = true
          save()
          continue
        }
        observation.ready = {
          duration: ready.duration,
          nextDuration: ready.upcomingTrack?.duration,
          strategy: ready.autoMixStrategy,
          planId: ready.autoMixPlanId
        }
        if (fixture.strategy) assert.equal(ready.autoMixStrategy, fixture.strategy)
        if (tracks[0].actualDuration !== tracks[0].duration)
          assert.notEqual(
            ready.duration,
            tracks[0].duration,
            'Rounded library duration was retained'
          )
        assert.ok(
          Math.abs(ready.duration - tracks[0].actualDuration) < 0.03,
          'Decoder duration changed'
        )
        await evaluate('window.__autoMixEvents = []')
        await evaluate('window.api.audioEngine.togglePause()')
        let sawMix = false,
          incomingPosition = 0,
          pausedMix = false
        const promoted = await poll(
          async () => {
            const info = await evaluate('window.api.audioEngine.getPlaybackInfo()')
            if (info.autoMixState === 'mixing') {
              sawMix = true
              assert.equal(info.outputPerfect, false)
              incomingPosition = info.autoMixNextSourceSeconds
              if (!pausedMix) {
                await evaluate('window.api.audioEngine.togglePause()')
                const paused = await poll(
                  () => evaluate('window.api.audioEngine.getPlaybackInfo()'),
                  (value) => value.state === 'paused',
                  'Mix pause failed'
                )
                observation.pauseCheck = {
                  pausedOutput: paused.autoMixOutputSeconds,
                  pausedNext: paused.autoMixNextSourceSeconds
                }
                await sleep(400)
                const frozen = await evaluate('window.api.audioEngine.getPlaybackInfo()')
                observation.pauseCheck.frozenOutput = frozen.autoMixOutputSeconds
                observation.pauseCheck.frozenNext = frozen.autoMixNextSourceSeconds
                assert.equal(frozen.autoMixOutputSeconds, paused.autoMixOutputSeconds)
                assert.equal(frozen.autoMixNextSourceSeconds, paused.autoMixNextSourceSeconds)
                await evaluate('window.api.audioEngine.togglePause()')
                pausedMix = true
              }
            }
            return info
          },
          (info) => info.source === fixture.next && info.queueIndex === 1,
          'Mix did not promote the next song'
        )
        assert.ok(sawMix && pausedMix, 'Ready plan never rendered a mix')
        assert.ok(
          promoted.position > 4 && promoted.position >= incomingPosition - 0.2,
          `Incorrect incoming continuation: ${promoted.position} vs ${incomingPosition}`
        )
        await sleep(1200)
        const continued = await evaluate('window.api.audioEngine.getPlaybackInfo()')
        assert.equal(continued.queueIndex, 1)
        assert.equal(continued.source, fixture.next)
        assert.ok(continued.position > promoted.position)
        observation.outputDevice = continued.outputDevice
        observation.renderPerformance = continued.renderPerformance
        observation.diagnostics = continued.diagnostics
        assert.equal(continued.renderPerformance?.deadlineMissCount, 0)
        assert.equal(continued.diagnostics?.sessionUnderrunCount, 0)
        observation.events = await evaluate('window.__autoMixEvents')
        verifyTempoMapping(observation, fixture)
        const queueChanges = observation.events.filter(
          (value, index, array) =>
            value.queueIndex === 1 && (index === 0 || array[index - 1].queueIndex !== 1)
        )
        assert.equal(queueChanges.length, 1, 'Queue did not advance exactly once')
        observation.promotedPosition = promoted.position
        observation.continuedPosition = continued.position
        observation.passed = true
        save()
      }
      await evaluate('window.api.audioEngine.stop()')
    }
    report.passed = true
    report.finishedAt = new Date().toISOString()
    save()
    clearTimeout(fatal)
    console.log('AUTOMIX_EVALUATION_APPLICATION_OK')
    app.quit()
    setTimeout(() => app.exit(0), 500)
  } catch (error) {
    report.error = error.stack
    save()
    clearTimeout(fatal)
    console.error(error)
    app.quit()
    setTimeout(() => app.exit(1), 500)
  }
}

function runNode(options) {
  const output = path.resolve(options.output)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const profile = fs.mkdtempSync(path.join(path.dirname(output), 'evaluation-profile-'))
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({
      onboardingCompleted: true,
      startupHomePage: 'local',
      autoMixMode: 'off',
      softwareVolume: 0,
      audioExclusiveMode: false,
      globalShortcutsEnabled: false,
      windowTransparency: false,
      closeWindowBehavior: 'quit',
      libraryFolders: options.playback
        ? [
            ...new Set(
              JSON.parse(fs.readFileSync(options.playback, 'utf8')).pairs.flatMap((p) => [
                path.dirname(p.current),
                path.dirname(p.next)
              ])
            )
          ]
        : []
    })
  )
  // Preserve the launching directory and PATH: changing them to the package
  // would conceal a utility-process native-loader dependency on the caller.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const phases = []
  for (const restore of options.playback ? ['0'] : ['0', '1']) {
    const reportPath = `${output}.${restore}.json`
    const phaseStartedAt = Date.now()
    const result = spawnSync(
      require('electron'),
      [
        __filename,
        `--user-data-dir=${profile}`,
        '--package',
        path.resolve(options.package),
        '--output',
        reportPath,
        '--profile',
        profile,
        '--restore',
        restore,
        ...(options.playback ? ['--playback', path.resolve(options.playback)] : []),
        ...(options.stems ? ['--stems', options.stems] : [])
      ],
      {
        cwd: process.cwd(),
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: options.playback ? 620_000 : 70_000
      }
    )
    console.log(result.stdout || '')
    if (result.stderr) console.error(result.stderr)
    assert.ifError(result.error)
    assert.equal(result.status, 0, 'Application evaluation smoke failed')
    const phase = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    assert.ok(
      Date.parse(phase.startedAt) >= phaseStartedAt,
      'A stale report cannot validate this launch'
    )
    assert.equal(phase.passed, true, phase.error || 'Application smoke report failed')
    phases.push(phase)
  }
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        packageDirectory: path.resolve(options.package),
        launchDirectory: process.cwd(),
        isolatedProfile: profile,
        releaseReady: false,
        passed: phases.every((value) => value.passed),
        phases
      },
      null,
      2
    ) + '\n'
  )
}

// Electron's application entry is not consistently exposed as require.main.
if (process.versions.electron || require.main === module) {
  const options = parse(process.argv.slice(2))
  if (process.versions.electron) void runElectron(options)
  else runNode(options)
}
module.exports = { verifyTempoMapping }
