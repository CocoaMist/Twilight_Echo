import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CoreAutoMixService } from './autoMixService.ts'
import { ProviderPlaybackIdentityRegistry } from './providerPlaybackIdentity.ts'
import type {
  TwilightAutoMixCoordinator,
  TwilightAutoMixContext
} from './twilightAutoMixCoordinator.ts'
import { STEM_MODEL_VERSION, STEM_CHECKPOINT_SHA256 } from './autoMixStemService.ts'
import {
  TWILIGHT_AUTOMIX_MODEL_VERSION,
  type AutoMixAnalysisResult,
  type AutoMixStemMode
} from '../../shared/twilightAutoMix.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import { SourceResources } from '../playback/sourceResources.ts'

function features(options: string): AutoMixAnalysisResult {
  const o = JSON.parse(options),
    duration = o.sourceEndSeconds - o.sourceStartSeconds
  const start = o.rangeStartSeconds,
    end = Math.min(start + 30, duration)
  return {
    ok: true,
    algorithm: 'Twilight AutoMix',
    modelVersion: TWILIGHT_AUTOMIX_MODEL_VERSION,
    sourceIdentity: o.sourceIdentity,
    coverage: {
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
      complete: start === 0 && end === duration
    },
    bpm: 120,
    tempoConfidence: 0.9,
    rmsDb: -12,
    peak: 0.2,
    key: -1,
    keyConfidence: 0,
    beats: [],
    downbeats: [],
    voice: [],
    frameDb: Array(Math.ceil((end - start) * 50)).fill(-12),
    framePeak: Array(Math.ceil((end - start) * 50)).fill(0.2)
  }
}
async function fixture(
  t: test.TestContext,
  analyze?: (options: string, signal: AbortSignal) => Promise<AutoMixAnalysisResult>
) {
  const root = await mkdtemp(join(tmpdir(), 'core-automix-service-'))
  const sources = [join(root, 'one.flac'), join(root, 'two.flac')]
  await Promise.all(sources.map((path, i) => writeFile(path, `actual-source-${i}`)))
  const context: TwilightAutoMixContext = {
    queueToken: 'queue:one',
    current: { id: 'one', queueEntryId: 'occ:one', source: sources[0], duration: 60 },
    next: { id: 'two', queueEntryId: 'occ:two', source: sources[1], duration: 60 },
    info: {
      state: 'paused',
      duration: 60,
      position: 1,
      playbackRate: 1,
      autoMixState: 'ready',
      autoMixPlanId: 7
    } as PlaybackInfo
  }
  let coordinator: TwilightAutoMixCoordinator | null = null,
    environments = 0
  const calls: string[] = [],
    requests: Record<string, unknown>[] = []
  const settings = {
    autoMixStemMode: 'off' as AutoMixStemMode,
    autoMixStemDevice: 'cpu' as const,
    autoMixStemCacheMiB: 512 as const
  }
  const identities = new ProviderPlaybackIdentityRegistry(),
    resources = new SourceResources()
  const service = new CoreAutoMixService({
    root,
    settings: () => settings,
    identities,
    now: Date.now,
    engine: {
      setAutoMixCoordinator: (next) => {
        coordinator?.destroy()
        coordinator = next
        next?.setMode('natural')
      },
      getAutoMixContext: () => context,
      selectAutoMix: async () => {
        calls.push('select')
        return { ok: true, selectionId: 3, currentStartSeconds: 50 }
      },
      prepareAutoMix: async (request) => {
        requests.push(JSON.parse(request))
        calls.push('prepare')
        return true
      },
      submitAutoMix: async () => {
        calls.push('submit')
        return true
      },
      cancelAutoMix: async () => {
        calls.push('cancel')
        return true
      },
      getAutoMixNativeStatus: async () => context.info,
      reportAutoMixAnalysisState: (state) => {
        calls.push(`state:${state}`)
      },
      clearAutoMixAnalysisState: () => {},
      invalidateAutoMixSource: () => {
        coordinator?.invalidate('source_changed')
        coordinator?.observe()
      }
    },
    authorize: async (source) => {
      assert.ok(sources.includes(source))
      return source
    },
    analysis: {
      analyze: async (_source, options, priority, signal) => {
        calls.push(priority)
        return analyze ? analyze(options, signal!) : features(options)
      },
      cancel: () => assert.fail('scoped cancellation must not cancel another analysis consumer')
    },
    useSources: (action) => resources.use(action),
    environment: async () => {
      environments++
      return {
        candidates: [join(root, 'pack')],
        workerDirectory: root,
        temporaryDirectory: tmpdir()
      }
    },
    probe: async () => ({ cpu: true, gpu: false }),
    runWorker: async () => assert.fail('no model worker is needed in this fixture')
  })
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return {
    service,
    calls,
    requests,
    context,
    sources,
    root,
    settings,
    resources,
    identities,
    coordinator: () => coordinator!,
    environments: () => environments
  }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await delay(2)
  }
  assert.fail('AutoMix did not reach expected stage')
}

test('readiness attaches one coordinator; preparation and cached source ranges do not require clients', async (t) => {
  const f = await fixture(t)
  assert.equal(f.calls.length, 0)
  f.service.activate()
  await f.coordinator().idle()
  assert.equal(f.calls.filter((call) => call === 'submit').length, 1)
  assert.ok(f.calls.indexOf('boundary') < f.calls.indexOf('prepare'))
  assert.equal(f.requests[0].currentSource, f.sources[0])
  assert.equal(f.requests[0].nextSource, f.sources[1])
  assert.equal(f.environments(), 0, 'disabled stems must not probe optional runtimes')
  const boundaries = f.calls.filter((call) => call === 'boundary').length
  f.coordinator().observe()
  await f.coordinator().idle()
  assert.equal(
    f.calls.filter((call) => call === 'submit').length,
    1,
    'reattachment cannot resubmit a plan'
  )
  await f.service.maintain(() =>
    f.resources.maintain(async () => {
      f.calls.push('maintenance')
    })
  )
  await f.coordinator().idle()
  assert.equal(
    f.calls.filter((call) => call === 'boundary').length,
    boundaries,
    'prepared content windows are reused'
  )
})

test('source maintenance aborts and joins active analysis before allowing cache deletion', async (t) => {
  let joined!: () => void,
    cancelled = false,
    entered = false
  const f = await fixture(
    t,
    (_options, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true
            joined = () => reject(signal.reason)
          },
          { once: true }
        )
      })
  )
  f.service.activate()
  await until(() => f.calls.includes('boundary'))
  const maintenance = f.service.maintain(() =>
    f.resources.maintain(async () => {
      entered = true
      f.context.info.state = 'stopped'
    })
  )
  await until(() => cancelled)
  assert.equal(entered, false)
  joined()
  await maintenance
  assert.equal(entered, true)
  assert.equal(f.calls.includes('submit'), false)
})

test('quit joins scoped analysis and removes provider/native observers without submitting late work', async (t) => {
  let joined!: () => void,
    cancelled = false,
    stopped = false
  const f = await fixture(
    t,
    (_options, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true
            joined = () => reject(signal.reason)
          },
          { once: true }
        )
      })
  )
  f.service.activate()
  await until(() => f.calls.includes('boundary'))
  const shutdown = f.service.shutdown().then(() => {
    stopped = true
  })
  await until(() => cancelled)
  assert.equal(stopped, false)
  assert.equal(f.identities.listenerCount('changed'), 0)
  joined()
  await shutdown
  assert.equal(f.calls.includes('submit'), false)
})

test('capability refresh discovers installed packs but exposes no executable paths and does not cancel playback preparation', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.service.capabilities(false)).status, 'missing')
  const pack = join(f.root, 'pack')
  await mkdir(join(pack, 'runtime'), { recursive: true })
  await mkdir(join(pack, 'models'))
  const meta = JSON.stringify({
    modelVersion: STEM_MODEL_VERSION,
    checkpointSha256: STEM_CHECKPOINT_SHA256
  })
  await Promise.all([
    writeFile(join(pack, 'manifest.json'), meta),
    writeFile(join(pack, 'model.lock.json'), meta),
    writeFile(join(pack, 'runtime/python.exe'), 'fixture'),
    writeFile(join(pack, 'models/955717e8-8726e21a.th'), 'fixture')
  ])
  f.service.activate()
  await f.coordinator().idle()
  const cancels = f.calls.filter((call) => call === 'cancel').length
  const state = await f.service.capabilities(true)
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.packs, [{ cpu: true, gpu: false, gpuName: undefined }])
  assert.doesNotMatch(JSON.stringify(state), /directory|python|exe|worker/)
  assert.equal(f.calls.filter((call) => call === 'cancel').length, cancels)
  assert.equal(f.environments(), 2)
})
