import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import test from 'node:test'
import { createOutputTestWav, OutputTest, type OutputTestContext } from './outputTest.ts'

const context: OutputTestContext = {
  backend: 'wasapi',
  device: 'device-1',
  volume: 0.3,
  outputConfig: { preferredBufferSize: 512, routingMode: 'stereo' },
  playing: false
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('test WAV is quiet stereo with separated left and right notes and silent edges', () => {
  const wav = createOutputTestWav()
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(4), wav.length - 8)
  assert.equal(wav.readUInt16LE(22), 2)
  assert.equal(wav.readUInt32LE(24), 48000)
  const energy = [0, 0]
  for (let frame = 0; frame < (wav.length - 44) / 4; frame++) {
    const time = frame / 48000
    for (let channel = 0; channel < 2; channel++) {
      const sample = wav.readInt16LE(44 + frame * 4 + channel * 2)
      assert.ok(Math.abs(sample) <= 2065)
      if (
        time < 0.1 ||
        time >= 1.6 ||
        (channel === 0 && time >= 0.75) ||
        (channel === 1 && time < 0.95)
      )
        assert.equal(sample, 0)
      energy[channel] += sample * sample
    }
  }
  assert.ok(energy.every((value) => value > 1e9))
})

test('audition applies device, backend, gain and config in an isolated service and cleans its temporary file', async () => {
  const calls: [string, unknown[]][] = []
  let source = '',
    destroyed = false
  const audition = new OutputTest({
    context: async (exclusive) => ({
      ...context,
      backend: exclusive ? 'wasapi-exclusive' : 'wasapi'
    }),
    durationMs: 1,
    createService: () => ({
      destroy: () => {
        destroyed = true
      },
      callAsync: async (method, args) => {
        calls.push([method, args])
        if (method === 'Play') {
          source = args[0] as string
          assert.equal((await readFile(source)).toString('ascii', 0, 4), 'RIFF')
        }
        return method === 'GetPlaybackInfo'
          ? JSON.stringify({ state: 'playing', source })
          : undefined
      }
    })
  })
  assert.deepEqual(await audition.play(true), { cancelled: false })
  assert.deepEqual(calls.slice(0, 4), [
    ['SetVolume', [0.3]],
    ['SetOutputBackend', ['wasapi-exclusive']],
    ['SetOutputDevice', ['device-1']],
    ['SetOutputConfig', [JSON.stringify(context.outputConfig)]]
  ])
  assert.equal(destroyed, true)
  await assert.rejects(access(dirname(source)))
})

test('busy, muted and playing states cannot start a second or inaudible audition', async () => {
  let created = 0
  const gate = deferred<OutputTestContext>()
  const audition = new OutputTest({
    context: () => gate.promise,
    createService: () => {
      created++
      throw new Error('unexpected service')
    }
  })
  const result = audition.play(false)
  await assert.rejects(audition.play(false), /正在播放/)
  const stopped = audition.stop()
  gate.resolve(context)
  await stopped
  assert.deepEqual(await result, { cancelled: true })
  assert.equal(created, 0)
  for (const blocked of [
    { ...context, playing: true },
    { ...context, volume: 0 }
  ]) {
    const blockedTest = new OutputTest({
      context: async () => blocked,
      createService: () => {
        throw new Error('unexpected service')
      }
    })
    await assert.rejects(blockedTest.play(false), blocked.playing ? /暂停/ : /音量/)
  }
})

test('stop during native initialization prevents Play and allows a clean retry', async () => {
  const started = deferred<void>(),
    released = deferred<void>()
  let first = true,
    played = 0,
    destroyed = 0,
    source = ''
  const audition = new OutputTest({
    context: async () => context,
    durationMs: 1,
    createService: () => ({
      destroy: () => {
        destroyed++
        released.resolve()
      },
      callAsync: async (method, args) => {
        if (method === 'SetVolume' && first) {
          first = false
          started.resolve()
          await released.promise
        }
        if (method === 'Play') {
          played++
          source = args[0] as string
        }
        return method === 'GetPlaybackInfo' ? { state: 'playing', source } : undefined
      }
    })
  })
  const result = audition.play(false)
  await started.promise
  await audition.stop()
  assert.deepEqual(await result, { cancelled: true })
  assert.equal(played, 0)
  assert.ok(destroyed > 0)
  assert.deepEqual(await audition.play(false), { cancelled: false })
  assert.equal(played, 1)
})

test('native rejection or missing playback confirmation is surfaced and still cleans up', async () => {
  for (const fail of [true, false]) {
    let source = '',
      destroyed = false
    const audition = new OutputTest({
      context: async () => context,
      createService: () => ({
        destroy: () => {
          destroyed = true
        },
        callAsync: async (method, args) => {
          if (method === 'Play') {
            source = args[0] as string
            if (fail) throw new Error('device unavailable')
          }
          return method === 'GetPlaybackInfo' ? { state: 'stopped', source } : undefined
        }
      })
    })
    await assert.rejects(audition.play(false), fail ? /device unavailable/ : /没有确认/)
    assert.equal(destroyed, true)
    await assert.rejects(access(dirname(source)))
  }
})
