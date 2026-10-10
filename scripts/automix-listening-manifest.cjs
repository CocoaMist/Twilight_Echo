const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
function manifest(directory, count = 100) {
  const tracks = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(source)
      else if (entry.isFile() && /\.(flac|wav|aiff?|mp3|m4a|ogg|opus|ape|wv)$/i.test(entry.name)) {
        const stat = fs.statSync(source)
        tracks.push({
          source,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          identity: createHash('sha256')
            .update(JSON.stringify([source, stat.size, stat.mtimeMs]))
            .digest('hex')
        })
      }
    }
  }
  walk(path.resolve(directory))
  tracks.sort((a, b) => a.identity.localeCompare(b.identity))
  if (tracks.length < 2) throw new Error('At least two supported music files are required')
  const pairs = []
  for (let stride = 1; pairs.length < count && stride < tracks.length; ++stride) {
    for (let i = 0; i < tracks.length && pairs.length < count; ++i) {
      const j = (i + stride) % tracks.length
      pairs.push({
        id: `AM-${String(pairs.length + 1).padStart(3, '0')}`,
        outgoing: tracks[i],
        incoming: tracks[j],
        categories: [],
        fullTrackPlayed: false,
        listened: false,
        natural: null,
        severeClick: null,
        truncated: null,
        wrongResume: null,
        notes: ''
      })
    }
  }
  return {
    format: 1,
    kind: 'fixed-listening-review-manifest',
    seed: 'sha256-file-identity-order-v1',
    sourceDirectory: path.resolve(directory),
    trackCount: tracks.length,
    pairCount: pairs.length,
    assessed: 0,
    releaseListeningGatePassed: false,
    requiredCategories: [
      'Chinese vocals',
      'other-language vocals',
      'dance',
      'hip-hop',
      'pop',
      'acoustic',
      'variable tempo',
      'live',
      'silence',
      'adjacent album',
      'CUE'
    ],
    categoryCoverage: 'unannotated',
    pairs
  }
}
if (require.main === module) {
  const a = process.argv.slice(2)
  const read = (k) => a[a.indexOf(k) + 1]
  if (!a.includes('--music') || !a.includes('--out'))
    throw new Error(
      'Usage: node scripts/automix-listening-manifest.cjs --music <directory> --out <json>'
    )
  const result = manifest(read('--music'))
  fs.writeFileSync(read('--out'), JSON.stringify(result, null, 2) + '\n')
  console.log(
    JSON.stringify({
      tracks: result.trackCount,
      pairs: result.pairCount,
      assessed: result.assessed,
      output: read('--out')
    })
  )
}
module.exports = { manifest }
