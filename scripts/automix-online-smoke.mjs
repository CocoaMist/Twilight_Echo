// Explicit development HTTP-range + native WASAPI check, outside no-device CI.
// The parent serves audio while the child's synchronous native calls execute.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { AutoMixCoordinator } from '../src/main/audio/autoMixCoordinator.ts'
import { createAutoMixOnlineResolver } from '../src/main/audio/autoMixOnlineSource.ts'
import { ProviderPlaybackSourceRegistry } from '../src/main/security/providerPlaybackSources.ts'
import { RemoteMediaGrantService } from '../src/main/security/remoteMediaGrants.ts'

const args = process.argv.slice(2)
const option = (key, fallback = '') => {
  const index = args.indexOf(key)
  return index < 0 ? fallback : args[index + 1]
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const read = (value) => (typeof value === 'string' ? JSON.parse(value) : value)

async function child() {
  if (process.env.TAE_AUTOMIX_EXPERIMENTAL !== '1')
    throw new Error('Experimental startup opt-in required')
  const modulePath = resolve(option('--module'))
  process.env.PATH = dirname(modulePath) + delimiter + process.env.PATH
  const native = createRequire(import.meta.url)(modulePath)
  const fixture = JSON.parse(process.env.TAE_AUTOMIX_HTTP_FIXTURE)
  const models = resolve(option('--models'))
  const grants = new RemoteMediaGrantService()
  const registry = new ProviderPlaybackSourceRegistry()
  const identities = {}
  const cache = new Map()
  let refresh = 0
  const report = {
    format: 1,
    passed: false,
    kind: 'development-http-range-native-wasapi',
    realProvider: 'not-tested',
    listeningQuality: 'not-rated',
    fullSong: 'not-tested',
    soak24Hours: 'not-tested',
    releaseGatePassed: false,
    device: option('--device'),
    analysis: [],
    observations: [],
    deliveries: 0
  }
  const resolver = createAutoMixOnlineResolver({
    registry,
    authorize: async (source) => grants.resolve(source, 'audio').source,
    callProvider: async (provider, method, callArgs, callOptions) => {
      assert.equal(provider, 'fixture')
      assert.equal(method, 'getPlaybackUrl')
      assert.equal(callOptions.expectedPluginId, 'fixture-owner')
      assert.equal(callArgs[1].force, true)
      const id = callArgs[0].id
      return {
        streamUrl: grants.grant(`${fixture.base}/${id}?token=fresh-${++refresh}`, 'audio'),
        autoMixIdentity: identities[id]
      }
    }
  })
  const queue = ['out', 'in'].map((id) => ({ id, source: `${fixture.base}/${id}?token=original` }))
  try {
    // Real HTTP native analysis first; keep only features in process memory.
    for (const [index, track] of queue.entries()) {
      const metadata = read(native.GetMetadata(track.source))
      const duration = Number(metadata.duration || metadata.durationSeconds)
      assert.ok(duration > 20)
      identities[track.id] = {
        contentId: fixture.hashes[track.id],
        quality: 'original-fixture-file',
        durationSeconds: duration,
        seekable: true
      }
      registry.register(track.source, {
        providerId: 'fixture',
        pluginId: 'fixture-owner',
        args: [{ id: track.id }, {}],
        identity: identities[track.id]
      })
      const resolved = await resolver(track)
      const segment = index ? 'head' : 'tail'
      const started = performance.now()
      const features = read(
        native.AnalyzeAutoMix(resolved.source, JSON.stringify({ segment, modelDirectory: models }))
      )
      assert.equal(features.available, true, JSON.stringify(features))
      assert.ok(features.windows[segment])
      cache.set(resolved.contentId, features)
      report.analysis.push({
        id: track.id,
        segment,
        milliseconds: performance.now() - started,
        durationSeconds: duration
      })
    }
    native.SetVolume(0.02)
    native.SetOutputBackend('wasapi')
    native.SetOutputDevice(option('--device'))
    native.SetOutputConfig(
      JSON.stringify({
        preferredBufferSize: 256,
        playbackPolicy: 'continuity-first',
        continuitySampleRate: 48000
      })
    )
    native.SetDspConfig(JSON.stringify({ gapless: true, dspEnabled: false }))
    native.SetAutoMixConfig(
      JSON.stringify({ enabled: true, allowIntelligentSkip: false, maxTransitionSeconds: 4 })
    )
    native.LoadQueue(JSON.stringify(queue), 0)
    native.Play(queue[0].source, identities.out.durationSeconds - 15)
    process.send({ kind: 'expire-original' })
    // Wait for parent acknowledgement before any refreshed preparation.
    await new Promise((done) => process.once('message', done))
    const coordinator = new AutoMixCoordinator(
      {
        snapshot: async () => ({
          queueToken: 'http-fixture',
          outgoing: queue[0],
          incoming: queue[1],
          status: read(native.GetAutoMixStatus())
        }),
        resolveOnline: resolver,
        analyze: async () => {
          throw new Error('The authorized warm cache must be reused')
        },
        deliver: async (json) => {
          native.SetAutoMixFeatures(json)
          report.deliveries++
        }
      },
      { get: async (identity) => cache.get(identity.contentId) ?? null, put: async () => {} }
    )
    const readyDeadline = Date.now() + 5000
    while (Date.now() < readyDeadline && report.deliveries === 0) {
      await coordinator.update()
      await pause(25)
    }
    assert.equal(report.deliveries, 1)
    let mixing = false,
      promoted = false,
      switches = 0,
      lastIndex = 0
    const deadline = Date.now() + 27000
    while (Date.now() < deadline && !promoted) {
      const status = read(native.GetAutoMixStatus()),
        playback = read(native.GetPlaybackInfo())
      report.observations.push({
        status,
        source: playback.source,
        position: playback.position,
        queueIndex: playback.queueIndex,
        outputPerfect: playback.outputPerfect,
        perfectReasonCode: playback.perfectReasonCode
      })
      if (status.state === 'mixing') {
        assert.equal(status.styleId, Number(option('--require-style', '8')))
        mixing = true
        if (status.progress > 0.1) {
          assert.equal(playback.outputPerfect, false)
          assert.equal(playback.perfectReasonCode, 'automix_active')
        }
      }
      if (playback.queueIndex !== lastIndex) {
        switches++
        lastIndex = playback.queueIndex
      }
      if (playback.source === queue[1].source) {
        assert.ok(playback.position >= 3, 'incoming must retain already audible source time')
        promoted = true
      }
      await pause(50)
    }
    assert.ok(mixing && promoted)
    assert.equal(switches, 1)
    await pause(1000)
    report.finalPlayback = read(native.GetPlaybackInfo())
    assert.equal(report.finalPlayback.source, queue[1].source)
    coordinator.destroy()
    report.passed = true
  } catch (error) {
    report.error = error.stack
  } finally {
    native.Stop()
    process.send({ kind: 'result', report })
    process.exit(report.passed ? 0 : 1)
  }
}

async function parent() {
  for (const required of ['--module', '--models', '--device', '--out', '--in', '--report']) {
    if (!option(required)) throw new Error(`Missing ${required}`)
  }
  const files = { out: resolve(option('--out')), in: resolve(option('--in')) }
  const hashes = {}
  for (const [id, path] of Object.entries(files)) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    hashes[id] = hash.digest('hex')
  }
  let expired = false,
    result
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'),
      id = url.pathname.slice(1)
    if (!files[id] || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end()
      return
    }
    const token = url.searchParams.get('token')
    if (!token || (token === 'original' && expired)) {
      requests.push({ id, token, status: 403 })
      response.writeHead(403).end()
      return
    }
    const size = statSync(files[id]).size
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1
    if (start > end || start >= size || (request.headers.range && !range)) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return
    }
    const status = range ? 206 : 200
    requests.push({ id, token, status, start, end })
    response.writeHead(status, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (request.method === 'HEAD') response.end()
    else {
      const stream = createReadStream(files[id], { start, end })
      stream.on('error', () => response.destroy())
      response.on('close', () => stream.destroy())
      stream.pipe(response)
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const worker = fork(fileURLToPath(import.meta.url), [...args, '--child'], {
    execArgv: ['--experimental-strip-types'],
    env: {
      ...process.env,
      TAE_AUTOMIX_HTTP_FIXTURE: JSON.stringify({
        base: `http://127.0.0.1:${server.address().port}`,
        hashes
      })
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  const timer = setTimeout(() => worker.kill(), 180000)
  worker.on('message', (message) => {
    if (message.kind === 'expire-original') {
      expired = true
      worker.send({ kind: 'expired' })
    }
    if (message.kind === 'result') result = message.report
  })
  const code = await new Promise((done, reject) => {
    worker.once('exit', done)
    worker.once('error', reject)
  })
  clearTimeout(timer)
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  result ??= { format: 1, passed: false, error: `Child exited ${code} without a result` }
  result.httpRequests = requests
  result.originalUrlsExpiredBeforePreparation = expired
  const freshRanges = requests.filter(
    (request) => request.token?.startsWith('fresh-') && request.status === 206
  )
  if (!expired || freshRanges.length === 0) {
    result.passed = false
    result.error ??= 'Refreshed range transport was not observed'
  }
  writeFileSync(resolve(option('--report')), JSON.stringify(result, null, 2) + '\n')
  console.log(
    JSON.stringify({
      passed: result.passed,
      refreshRangeRequests: freshRanges.length,
      report: option('--report'),
      error: result.error
    })
  )
  process.exitCode = result.passed ? 0 : 1
}

;(args.includes('--child') ? child() : parent()).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
