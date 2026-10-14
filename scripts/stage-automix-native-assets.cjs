/* Public asset allowlist. Never accepts SDK directories, recursive copies,
 * converted graphs with unknown hashes, ORT, or private research manifests. */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const lock = require('../audio-engine/automix-native/dependencies.lock.json')
const licenses = [
  'Beat-This-LICENSE.txt',
  'YAMNet-LICENSE.txt',
  'Signalsmith-Stretch-LICENSE.txt',
  'Signalsmith-Linear-LICENSE.txt'
]
const allowed = new Set([
  ...Object.values(lock.models).map((m) => m.graphFile),
  ...licenses,
  'manifest.json'
])
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function validate(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !allowed.has(entry.name))
      throw new Error(`Unapproved AutoMix release asset: ${entry.name}`)
  }
  for (const m of Object.values(lock.models)) {
    if (sha(path.join(directory, m.graphFile)) !== m.graphSha256)
      throw new Error(`AutoMix public graph hash mismatch: ${m.graphFile}`)
  }
  for (const name of licenses) {
    if (
      sha(path.join(directory, name)) !==
      sha(path.join(root, 'audio-engine/automix-native/licenses', name))
    )
      throw new Error(`Missing or altered license: ${name}`)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  if (
    Object.keys(manifest).sort().join(',') !== 'graphAbi,models' ||
    manifest.graphAbi !== lock.graphAbi ||
    JSON.stringify(manifest.models) !== JSON.stringify(lock.models)
  )
    throw new Error('AutoMix asset manifest does not match the dependency lock')
  return { ok: true, files: [...allowed] }
}
function stage(source, destination) {
  for (const m of Object.values(lock.models)) {
    if (sha(path.join(source, m.graphFile)) !== m.graphSha256)
      throw new Error(`Unapproved public source graph: ${m.graphFile}`)
  }
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (!entry.isFile() || !allowed.has(entry.name))
      throw new Error(`Clean the unrelated staging asset explicitly: ${entry.name}`)
  }
  for (const m of Object.values(lock.models))
    fs.copyFileSync(path.join(source, m.graphFile), path.join(destination, m.graphFile))
  for (const name of licenses)
    fs.copyFileSync(
      path.join(root, 'audio-engine/automix-native/licenses', name),
      path.join(destination, name)
    )
  fs.writeFileSync(
    path.join(destination, 'manifest.json'),
    JSON.stringify({ graphAbi: lock.graphAbi, models: lock.models }, null, 2) + '\n'
  )
  return validate(destination)
}
if (require.main === module) {
  const [source, destination = path.join(root, 'resources/audio-engine/automix-native')] =
    process.argv.slice(2)
  if (!source)
    throw new Error(
      'Usage: node scripts/stage-automix-native-assets.cjs PUBLIC_GRAPH_CACHE [STAGING_DIRECTORY]'
    )
  console.log(JSON.stringify(stage(path.resolve(source), path.resolve(destination)), null, 2))
}
module.exports = { stage, validate, allowed }
