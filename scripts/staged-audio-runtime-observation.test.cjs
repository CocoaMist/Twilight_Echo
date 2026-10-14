const assert = require('node:assert/strict')
const test = require('node:test')

const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')

const manifest = {
  nativeArtifacts: [
    { path: 'twilight-audio-engine.dll', sha256: 'engine' },
    { path: 'twilight_audio_node.node', sha256: 'node' },
    { path: 'twilight-asio-helper.exe', sha256: 'helper' }
  ]
}

test('staged addon observations bind engine capability facts to every artifact hash', () => {
  const observation = readStagedAudioRuntimeObservation({
    artifactDir: 'C:/staged',
    manifest,
    loadAddon: () => ({
      GetEngineCapabilities: () =>
        JSON.stringify({
          features: { asio: true, ebur128: true, sacdIsoDstDsdProvider: false }
        })
    })
  })
  assert.deepEqual(observation, {
    observation: {
      schemaVersion: 1,
      source: 'audio-engine-runtime-observation',
      artifactSha256: {
        'twilight-audio-engine.dll': 'engine',
        'twilight_audio_node.node': 'node',
        'twilight-asio-helper.exe': 'helper'
      }
    },
    capabilities: {
      asio: { enabled: true },
      ebur128: { available: true },
      nativeDsdProvider: { available: false }
    }
  })
})

test('an unloadable staged addon provides no capability fact', () => {
  assert.equal(
    readStagedAudioRuntimeObservation({
      artifactDir: 'C:/staged',
      manifest,
      loadAddon: () => {
        throw new Error('missing runtime')
      }
    }),
    null
  )
})

test('production inspection uses a hidden bounded child and never loads the staging DLL in the parent', () => {
  let calls = 0
  const result = readStagedAudioRuntimeObservation({
    artifactDir: 'C:/staged',
    manifest,
    runProbe: (executable, args, options) => {
      calls++
      assert.equal(executable, process.execPath)
      assert.equal(args[0], require.resolve('./staged-audio-runtime-observation.cjs'))
      assert.ok(args[1].endsWith('twilight_audio_node.node'))
      assert.equal(options.windowsHide, true)
      assert.equal(options.timeout, 15_000)
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
      return { status: 0, stdout: JSON.stringify({ features: { asio: true } }) }
    }
  })
  assert.equal(calls, 1)
  assert.equal(result.capabilities.asio.enabled, true)
})

test('timed-out and invalid child observations remain unknown', () => {
  for (const child of [
    { status: null, error: new Error('timeout') },
    { status: 1, stdout: '{}' },
    { status: 0, stdout: 'invalid' }
  ]) {
    assert.equal(
      readStagedAudioRuntimeObservation({
        artifactDir: 'C:/staged',
        manifest,
        runProbe: () => child
      }),
      null
    )
  }
})
