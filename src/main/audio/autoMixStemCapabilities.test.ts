import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoMixStemDetector } from './autoMixStemCapabilities.ts'
import { STEM_CHECKPOINT_SHA256, STEM_MODEL_VERSION } from './autoMixStemService.ts'
import { normalizeAutoMixStemDevice } from '../../shared/twilightAutoMix.ts'

async function install(directory: string): Promise<void> {
  await mkdir(join(directory, 'runtime'), { recursive: true })
  await mkdir(join(directory, 'models'), { recursive: true })
  const metadata = JSON.stringify({
    modelVersion: STEM_MODEL_VERSION,
    checkpointSha256: STEM_CHECKPOINT_SHA256
  })
  await writeFile(join(directory, 'manifest.json'), metadata)
  await writeFile(join(directory, 'model.lock.json'), metadata)
  await writeFile(join(directory, 'runtime/python.exe'), 'fixture')
  await writeFile(join(directory, 'models/955717e8-8726e21a.th'), 'fixture')
}

test('stem device preferences preserve explicit choices and migrate legacy settings', () => {
  for (const value of [undefined, null, '', 'cuda', 1, false])
    assert.equal(normalizeAutoMixStemDevice(value), 'auto')
  for (const value of ['cpu', 'gpu', 'auto']) assert.equal(normalizeAutoMixStemDevice(value), value)
})

test('install, invalid metadata, removal and repair invalidate capability detection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stem-discovery-test-'))
  const directory = join(root, 'automix-enhancement')
  let probes = 0
  const detector = new AutoMixStemDetector(
    () => [directory, directory],
    () => 'worker',
    async () => {
      probes++
      return { cpu: true, gpu: false }
    }
  )
  try {
    assert.equal((await detector.get()).status, 'missing')
    await install(directory)
    assert.equal((await detector.get()).status, 'ready')
    assert.equal(await detector.resolveDevice('cpu'), directory)
    assert.equal(await detector.resolveDevice('auto'), directory)
    assert.equal(
      await detector.resolveDevice('gpu'),
      null,
      'explicit GPU must not silently select CPU'
    )
    assert.equal(probes, 1, 'duplicate directories and repeated reads must share the probe')
    await writeFile(join(directory, 'model.lock.json'), '{}')
    const invalid = await detector.get()
    assert.equal(invalid.status, 'unavailable')
    assert.equal(invalid.reason, 'pack_invalid')
    assert.equal(probes, 1, 'invalid packages must not launch Python')
    await install(directory)
    assert.equal((await detector.get()).status, 'ready')
    await rm(join(directory, 'runtime/python.exe'))
    assert.equal((await detector.get()).status, 'unavailable')
    await rm(directory, { recursive: true, force: true })
    assert.equal((await detector.get()).status, 'missing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent UI and playback reads share one probe; manual refresh discovers changed hardware', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stem-probe-sharing-test-'))
  await install(root)
  let release!: () => void
  let probes = 0,
    gpu = false
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const detector = new AutoMixStemDetector(
    () => [root],
    () => 'worker',
    async () => {
      probes++
      await gate
      return { cpu: true, gpu, gpuName: gpu ? 'GPU fixture' : undefined }
    }
  )
  try {
    const first = detector.get()
    assert.equal(detector.get(true), first, 'refresh while probing must join existing work')
    const playback = detector.resolveDevice('auto')
    release()
    assert.equal((await first).gpu, false)
    assert.equal(await playback, root)
    assert.equal(probes, 1)
    gpu = true
    assert.equal((await detector.get()).gpu, false, 'normal read must use cached hardware result')
    assert.equal((await detector.get(true)).gpu, true)
    assert.equal(await detector.resolveDevice('gpu'), root)
    assert.equal(probes, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a broken first package cannot hide a usable GPU or CPU package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stem-multiple-pack-test-'))
  const directories = ['broken', 'cpu', 'gpu'].map((name) => join(root, name))
  for (const directory of directories) await install(directory)
  const detector = new AutoMixStemDetector(
    () => directories,
    () => 'worker',
    async (directory) => {
      if (directory === directories[0]) throw new Error('probe_timeout')
      return { cpu: true, gpu: directory === directories[2], gpuName: 'GPU fixture' }
    }
  )
  try {
    const result = await detector.get()
    assert.equal(result.status, 'ready')
    assert.equal(result.gpu, true)
    assert.equal(result.packs.length, 2)
    assert.equal(await detector.resolveDevice('cpu'), directories[1])
    assert.equal(await detector.resolveDevice('gpu'), directories[2])
    assert.equal(await detector.resolveDevice('auto'), directories[2])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('probe timeout or runtime failure leaves the separator unavailable and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stem-probe-retry-test-'))
  await install(root)
  let failure = 'probe_timeout'
  const detector = new AutoMixStemDetector(
    () => [root],
    () => 'worker',
    async () => {
      if (failure) throw new Error(failure)
      return { cpu: true, gpu: false }
    }
  )
  try {
    assert.equal((await detector.get()).reason, 'probe_timeout')
    failure = 'runtime_unavailable'
    assert.equal((await detector.get(true)).reason, 'runtime_unavailable')
    failure = ''
    assert.equal((await detector.get(true)).status, 'ready')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
