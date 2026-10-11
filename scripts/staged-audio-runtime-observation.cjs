const path = require('node:path')
const { spawnSync } = require('node:child_process')

function booleanFact(value) {
  return typeof value === 'boolean' ? value : undefined
}

function readStagedAudioRuntimeObservation({
  artifactDir,
  manifest,
  loadAddon,
  runProbe = spawnSync
}) {
  try {
    const modulePath = path.join(path.resolve(artifactDir), 'twilight_audio_node.node')
    let raw
    if (loadAddon) {
      const addon = loadAddon(modulePath)
      if (!addon || typeof addon.GetEngineCapabilities !== 'function') return null
      raw = addon.GetEngineCapabilities()
    } else {
      // Windows cannot delete a DLL loaded into the packaging process. Keep
      // capability inspection in a bounded child that exits before cleanup.
      const child = runProbe(process.execPath, [__filename, modulePath], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      if (child.error || child.status !== 0) return null
      raw = child.stdout
    }
    const capabilities = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!capabilities || typeof capabilities !== 'object') return null
    const features = capabilities.features
    if (!features || typeof features !== 'object') return null
    return {
      observation: {
        schemaVersion: 1,
        source: 'audio-engine-runtime-observation',
        artifactSha256: Object.fromEntries(
          manifest.nativeArtifacts.map((artifact) => [artifact.path, artifact.sha256])
        )
      },
      capabilities: {
        asio: { enabled: booleanFact(features.asio) },
        ebur128: { available: booleanFact(features.ebur128) },
        nativeDsdProvider: { available: booleanFact(features.sacdIsoDstDsdProvider) }
      }
    }
  } catch {
    return null
  }
}

if (require.main === module) {
  try {
    const addon = require(path.resolve(process.argv[2]))
    const value = addon.GetEngineCapabilities()
    process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
  } catch (error) {
    process.stderr.write(error.message)
    process.exitCode = 1
  }
}

module.exports = { readStagedAudioRuntimeObservation }
