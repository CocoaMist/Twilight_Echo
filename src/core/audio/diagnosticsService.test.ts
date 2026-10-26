import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDefaultSettings } from '../settings/normalization.ts'
import { createDefaultPlaybackInfo, normalizeOutputConfig } from './audioEngineHelpers.ts'
import { createLegacyDspGraph } from '../../shared/dspGraph.ts'
import { CoreAudioDiagnosticsService } from './diagnosticsService.ts'

const environment = {
  appName: 'TwilightEcho',
  appVersion: 'test',
  packaged: true,
  platform: process.platform,
  architecture: process.arch,
  osRelease: 'test',
  locale: 'zh-CN',
  processVersions: { node: process.versions.node, modules: process.versions.modules }
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'core-diagnostics-'))
  const settings = createDefaultSettings('win32')
  const info = createDefaultPlaybackInfo('wasapi', 'test-dac', false, normalizeOutputConfig())
  const cursors: number[] = []
  let ring: (cursor: number) => Promise<string | null> = async () => '[]'
  const engine = Object.assign(new EventEmitter(), {
    getPlaybackInfo: async () => info,
    getAudioOutputState: async () => ({ state: 'ready' }) as never,
    getOutputConfig: () => settings.audioOutputConfig,
    getEffectiveOutputConfig: () => settings.audioOutputConfig,
    getOutputConfigApplyStatus: () => ({ state: 'applied' }) as never,
    getAudioProcessing: () => settings.audioProcessing,
    getDspSceneState: () => ({
      scenes: [],
      activeSceneId: null,
      pinnedSceneId: null,
      graph: createLegacyDspGraph(settings.audioProcessing),
      requiresPcmFallback: false,
      dsdPcmFallbackApplied: false
    }),
    getDspGraphStatus: async () => ({ compileState: 'ready', nodes: [], revision: 0 }) as never,
    getNativeRuntimeIdentity: () => ({ build: 'test-engine' }),
    readEngineDiagnosticLog: async (cursor: number) => {
      cursors.push(cursor)
      return ring(cursor)
    }
  })
  const failures: unknown[] = []
  const service = new CoreAudioDiagnosticsService({
    engine,
    settings: () => settings,
    directory,
    environment,
    failed: (error) => failures.push(error)
  })
  t.after(async () => {
    await service.shutdown()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    service,
    engine,
    info,
    cursors,
    failures,
    ring(value: typeof ring) {
      ring = value
    },
    directory
  }
}

test('Core reports full persisted events, native ring evidence and current snapshot without a renderer', async (t) => {
  const f = await fixture(t)
  f.ring(async () =>
    JSON.stringify([
      {
        sequence: 7,
        event: 'native-output-opened',
        level: 'warning',
        message: 'failed D:\\Private Music\\song.dsf',
        details: {
          url: 'https://music.test/song.dsf?token=secret-value',
          authorization: 'Bearer private-value'
        }
      }
    ])
  )
  f.engine.emit('playback-info', f.info)
  f.engine.emit('playback-info', { ...f.info, position: 5 })
  f.engine.emit('config-applied', { revision: 9 })
  const report = await f.service.report('zh-CN')
  assert.equal(report.locale, 'zh-CN')
  assert.ok(report.snapshot.outputState)
  assert.ok(report.snapshot.dspGraphStatus)
  assert.equal(report.events.filter((e) => e.event === 'playback-state').length, 1)
  assert.ok(report.events.some((e) => e.event === 'output-config-applied'))
  assert.ok(report.events.some((e) => e.event === 'native-output-opened'))
  assert.doesNotMatch(JSON.stringify(report), /Private Music|secret-value|private-value/)
  assert.deepEqual(f.failures, [])
  await f.service.shutdown()
  const next = new CoreAudioDiagnosticsService({
    engine: f.engine,
    settings: () => createDefaultSettings('win32'),
    directory: f.directory,
    environment,
    failed: (error) => f.failures.push(error)
  })
  try {
    assert.ok((await next.report('en-US')).events.some((e) => e.event === 'native-output-opened'))
  } finally {
    await next.shutdown()
  }
})

test('Core discards ring replies from a crashed service generation and restarts its cursor', async (t) => {
  const f = await fixture(t)
  let release!: (value: string) => void
  f.ring(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = f.service.report('zh-CN')
  f.engine.emit('audio-service-crash', { code: 1 })
  release(JSON.stringify([{ sequence: 99, event: 'obsolete-ring' }]))
  assert.ok(!(await pending).events.some((e) => e.event === 'obsolete-ring'))
  f.ring(async () => JSON.stringify([{ sequence: 2, event: 'new-engine-ring' }]))
  assert.ok((await f.service.report('zh-CN')).events.some((e) => e.event === 'new-engine-ring'))
  assert.deepEqual(f.cursors, [0, 0])
  await f.service.shutdown()
  assert.equal(f.engine.listenerCount('playback-info'), 0)
  assert.equal(f.engine.listenerCount('config-applied'), 0)
})
