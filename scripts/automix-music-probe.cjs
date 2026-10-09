// Native analysis/selection evidence; never assigns listening-quality ratings.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback = '') => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const modulePath = option('--module'),
    models = option('--models'),
    music = option('--music'),
    output = option('--output'),
    probe = option('--probe')
  if (!modulePath || !models || !music || !output || !probe)
    throw new Error(
      'Usage: automix-music-probe --module <addon> --models <assets> --music <folder> --output <evidence-folder> --probe <plan_probe.exe> [--max-tracks 24]'
    )
  fs.mkdirSync(output, { recursive: true })
  process.env.PATH = path.dirname(path.resolve(modulePath)) + path.delimiter + process.env.PATH
  const native = require(path.resolve(modulePath))
  const lock = JSON.parse(fs.readFileSync(path.join(models, 'dependencies.lock.json'), 'utf8'))
  const read = (value) => (typeof value === 'string' ? JSON.parse(value) : value)
  const limit = Number(option('--max-tracks', '24'))
  if (!Number.isInteger(limit) || limit < 2 || limit > 1000) throw new Error('Invalid track limit')
  const files = []
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(folder, entry.name))
      else if (entry.isFile() && /\.(flac|mp3|m4a|wav|ogg|opus|aiff|alac)$/i.test(entry.name))
        files.push(path.join(folder, entry.name))
    }
  }
  visit(music)
  files.sort((a, b) => a.localeCompare(b, 'en'))
  const records = []
  for (const source of files.slice(0, limit)) {
    const stats = fs.statSync(source),
      identity = JSON.stringify([
        path.resolve(source),
        stats.size,
        stats.mtimeMs,
        stats.birthtimeMs
      ])
    const key = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          identity,
          lock.independentAnalysis.version,
          lock.beatThis.onnxSha256,
          lock.yamnet.onnxSha256
        ])
      )
      .digest('hex')
    const featurePath = path.join(output, key + '.features.json')
    let features
    if (fs.existsSync(featurePath)) features = JSON.parse(fs.readFileSync(featurePath, 'utf8'))
    else {
      features = read(
        native.AnalyzeAutoMix(
          source,
          JSON.stringify({ segment: 'both', modelDirectory: path.resolve(models) })
        )
      )
      // Persist features only, never decoded audio.
      fs.writeFileSync(featurePath, JSON.stringify(features) + '\n')
    }
    records.push({ source, identity, featurePath, features })
    console.log(
      JSON.stringify({
        source,
        available: features.available,
        headRegions: features.windows?.head?.stableRegions?.length ?? 0,
        tailRegions: features.windows?.tail?.stableRegions?.length ?? 0
      })
    )
  }
  const pairs = []
  for (const outgoing of records)
    for (const incoming of records) {
      if (outgoing === incoming || !outgoing.features.available || !incoming.features.available)
        continue
      const result = spawnSync(
        probe,
        [
          String(outgoing.features.durationSeconds),
          String(incoming.features.durationSeconds),
          outgoing.featurePath,
          incoming.featurePath
        ],
        { encoding: 'utf8', windowsHide: true }
      )
      if (result.status !== 0) throw new Error(result.stderr || 'Native plan probe failed')
      const selected = JSON.parse(result.stdout)
      if (selected.styleId === 1) continue
      const pairFile = path.join(output, `pair-${pairs.length}.json`)
      fs.writeFileSync(
        pairFile,
        JSON.stringify({
          outgoingSource: outgoing.source,
          incomingSource: incoming.source,
          outgoing: outgoing.features,
          incoming: incoming.features
        }) + '\n'
      )
      pairs.push({ outgoing: outgoing.source, incoming: incoming.source, selected, pairFile })
    }
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        format: 1,
        tracks: records.map(({ features: _features, ...record }) => record),
        pairs,
        listeningQuality: 'not-rated',
        fullSong: 'not-tested',
        releaseGatePassed: false
      },
      null,
      2
    ) + '\n'
  )
  console.log(
    JSON.stringify({
      tracks: records.length,
      intelligentPairs: pairs.length,
      manifest: path.join(output, 'manifest.json')
    })
  )
}
if (require.main === module)
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
