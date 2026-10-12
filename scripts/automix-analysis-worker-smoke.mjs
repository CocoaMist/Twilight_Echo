// Development integration probe: real bundled worker/native model execution
// through the production scheduler, with Node IPC adapting utilityProcess.
// This is not full Electron/application or human listening acceptance.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import asar from '@electron/asar'
import { AudioAnalysisServiceClient } from '../src/main/audioAnalysisServiceClient.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (data) => createHash('sha256').update(data).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(options) {
  const packageDir = path.resolve(options.package)
  const output = path.resolve(options.output)
  const serviceEntry = path.join(root, 'out/main/audioAnalysisService.js')
  const archive = path.join(packageDir, 'resources/app.asar')
  const worker = readFileSync(serviceEntry)
  assert.equal(
    sha(worker),
    sha(asar.extractFile(archive, path.join('out', 'main', 'audioAnalysisService.js')))
  )
  // Verify the exact worker's shared implementation chunks, too.
  for (const match of worker.toString().matchAll(/require\("(\.\/chunks\/[^"\n]+)"\)/g)) {
    const relative = match[1].slice(2)
    assert.equal(
      sha(readFileSync(path.join(path.dirname(serviceEntry), relative))),
      sha(asar.extractFile(archive, path.join('out', 'main', relative)))
    )
  }
  const nativeDir = path.join(packageDir, 'resources/audio-engine')
  const corpus = JSON.parse(readFileSync(options.corpus, 'utf8'))
  assert.ok(corpus.pairs.length >= 1)
  const sources = [corpus.pairs[0].current, corpus.pairs[0].next]
  const identities = sources.map((source) => sha(readFileSync(source)))
  const report = {
    schemaVersion: 1,
    kind: 'real-native-background-analysis-ipc',
    startedAt: new Date().toISOString(),
    passed: false,
    scope: 'Production scheduler and identical packaged worker/chunks over Node IPC; not full Electron application acceptance',
    workerSha256: sha(worker),
    dllSha256: sha(readFileSync(path.join(nativeDir, 'twilight-audio-engine.dll'))),
    moduleSha256: sha(readFileSync(path.join(nativeDir, 'twilight_audio_node.node'))),
    maximumSimultaneousAutoMix: 0,
    maximumLiveScheduledWorkers: 0,
    workerStarts: 0,
    cancellationRecovered: false,
    analyses: []
  }
  const inFlight = new Map()
  const children = new Set()
  const client = new AudioAnalysisServiceClient({
    serviceEntry,
    maxConcurrency: 4,
    restartDelayMs: 100,
    taskTimeoutMs: 30_000,
    electron: {
      utilityProcess: {
        fork(entry) {
          const child = fork(entry, [], {
            cwd: packageDir,
            execArgv: [],
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, PATH: `${nativeDir}${path.delimiter}${process.env.PATH ?? ''}` }
          })
          children.add(child)
          report.workerStarts++
          child.on('message', (message) => {
            if (message.kind === 'response') inFlight.delete(message.requestId)
          })
          child.on('exit', () => {
            children.delete(child)
            for (const [id, owner] of inFlight) if (owner === child) inFlight.delete(id)
          })
          return {
            postMessage(message) {
              if (message.analysis === 'automix') {
                inFlight.set(message.requestId, child)
                report.maximumSimultaneousAutoMix = Math.max(
                  report.maximumSimultaneousAutoMix,
                  inFlight.size
                )
              }
              child.send(message)
            },
            kill: () => child.kill(),
            on: (event, listener) => child.on(event, listener),
            stdout: child.stdout,
            stderr: child.stderr
          }
        }
      }
    }
  })
  client.on('error-log', () => {})
  const monitor = setInterval(() => {
    report.maximumLiveScheduledWorkers = Math.max(
      report.maximumLiveScheduledWorkers,
      client.getStatus().liveWorkers
    )
  }, 20)
  const analyze = (deck, extra = {}) =>
    client.analyzeAutoMix(
      sources[deck],
      JSON.stringify({
        sourceIdentity: identities[deck],
        windowStartSeconds: 0,
        windowEndSeconds: 30
      }),
      extra
    )
  try {
    for (let cycle = 0; cycle < options.cycles; cycle++) {
      const results = await Promise.all([analyze(0), analyze(1), analyze(0)])
      for (let i = 0; i < results.length; i++) {
        const result = results[i], deck = i === 1 ? 1 : 0
        assert.equal(result.ok, true)
        assert.equal(result.sourceIdentity, identities[deck])
        assert.equal(result.coverage.startSeconds, 0)
        assert.ok(result.coverage.endSeconds <= 30)
        report.analyses.push({
          cycle,
          sourceIdentity: result.sourceIdentity,
          coverage: result.coverage,
          modelVersion: result.modelVersion
        })
      }
      console.log(JSON.stringify({ cycle, completed: report.analyses.length }))
    }
    const cancelled = analyze(0).then(
      () => { throw new Error('Cancelled native inference unexpectedly completed') },
      (error) => error
    )
    const deadline = Date.now() + 15_000
    while (inFlight.size === 0 && Date.now() < deadline) await sleep(10)
    assert.equal(inFlight.size, 1)
    assert.equal(client.cancelBySource(sources[0], 'automix'), 1)
    assert.equal((await cancelled).code, 'ERR_AUDIO_ANALYSIS_CANCELLED')
    // Wait for the cancelled OS process to exit before the recovery request.
    while (children.size > 0 && Date.now() < deadline) await sleep(10)
    assert.equal(children.size, 0)
    const recovered = await analyze(1)
    assert.equal(recovered.ok, true)
    assert.equal(recovered.sourceIdentity, identities[1])
    report.cancellationRecovered = true
    assert.equal(report.maximumSimultaneousAutoMix, 1)
    assert.equal(report.maximumLiveScheduledWorkers, 1)
    report.passed = true
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    clearInterval(monitor)
    client.destroy()
    report.finishedAt = new Date().toISOString()
    mkdirSync(path.dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  }
}

const options = { cycles: 2 }
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '')
  assert.ok(['package', 'corpus', 'output', 'cycles'].includes(key))
  assert.ok(process.argv[i + 1], `Missing --${key} value`)
  options[key] = key === 'cycles' ? Number(process.argv[i + 1]) : process.argv[i + 1]
}
assert.ok(options.package && options.corpus && options.output)
assert.ok(Number.isInteger(options.cycles) && options.cycles >= 1 && options.cycles <= 64)
await run(options)
