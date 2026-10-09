const { createHash } = require('node:crypto')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const lock = JSON.parse(
  readFileSync(join(root, 'audio-engine/automix/dependencies.lock.json'), 'utf8')
)
const files = [
  [lock.beatThis.onnxFile, lock.beatThis.onnxSha256],
  [lock.yamnet.onnxFile, lock.yamnet.onnxSha256],
  [lock.onnxRuntime.runtimeFile, lock.onnxRuntime.runtimeSha256]
]

function verify(directory) {
  return files.map(([name, expected]) => {
    const file = join(directory, name)
    if (!existsSync(file)) throw new Error(`Missing AutoMix asset: ${file}`)
    const bytes = readFileSync(file)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) throw new Error(`AutoMix asset checksum mismatch: ${name}`)
    return { name, sha256: actual, bytes: bytes.length }
  })
}

if (require.main === module) {
  try {
    const sourceIndex = process.argv.indexOf('--source')
    const targetIndex = process.argv.indexOf('--target')
    if (
      sourceIndex < 0 ||
      !process.argv[sourceIndex + 1] ||
      (targetIndex >= 0 && !process.argv[targetIndex + 1])
    )
      throw new Error(
        'Usage: node scripts/stage-automix-assets.cjs --source <verified model directory> [--target <staging directory>] [--verify-only]'
      )
    const source = resolve(process.argv[sourceIndex + 1])
    const assets = verify(source)
    if (!process.argv.includes('--verify-only')) {
      if (process.platform !== 'win32' || process.arch !== 'x64')
        throw new Error('Only the Windows x64 runtime is pinned')
      const target =
        targetIndex >= 0
          ? resolve(process.argv[targetIndex + 1])
          : join(root, 'resources/audio-engine/automix')
      mkdirSync(target, { recursive: true })
      // Explicit allowlist: source checkpoints, conversion fixtures and Apple
      // snapshots are never copied to a distribution directory.
      for (const [name] of files) copyFileSync(join(source, name), join(target, name))
      const licenses = [
        'Beat-This-LICENSE.txt',
        'YAMNet-LICENSE.txt',
        'ONNXRuntime-LICENSE.txt',
        'Signalsmith-Stretch-LICENSE.txt',
        'Signalsmith-Linear-LICENSE.txt'
      ]
      for (const name of licenses)
        copyFileSync(join(root, 'audio-engine/automix/vendor', name), join(target, name))
      writeFileSync(join(target, 'dependencies.lock.json'), JSON.stringify(lock, null, 2) + '\n')
      writeFileSync(
        join(target, 'assets.json'),
        JSON.stringify({ format: 1, platform: lock.runtimePlatform, assets, licenses }, null, 2) +
          '\n'
      )
      verify(target)
    }
    console.log(JSON.stringify({ verified: true, assets }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = { verify }
