const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const rules = [
  ['dance-original', '0x22745b338', 'implementation/dance-original-score.asm'],
  ['dance-shifted', '0x22745b980', 'implementation/dance-shifted-score.asm'],
  ['filtered-direct', '0x227461768', 'candidate-paths/filtered-direct.asm'],
  ['filtered-shifted', '0x227461f04', 'implementation/filtered-shifted-score.asm'],
  ['hiphop-direct', '0x227466860', 'candidate-paths/hiphop-direct.asm'],
  ['hiphop-shifted', '0x227466f28', 'candidate-paths/hiphop-shifted.asm'],
  ['pop-scaled-shifted', '0x227469f58', 'candidate-paths/pop-shifted.asm'],
  ['smart-crossfade', '0x227470e0c', 'candidate-paths/smart-direct.asm'],
  ['dead-air', '0x22746ad10', 'candidate-paths/deadair-style.asm'],
  ['fallback-crossfade', '0x22746c7a4', 'candidate-paths/fallback-root.asm'],
  ['soft-skip', '0x227474a3c', 'candidate-paths/softskip-root.asm']
]
const dependencies = {
  selection: [
    'v4-selection-final/weighted-score-selection.asm',
    'v4-selection-final/uniform-range-selection.asm',
    'v4-selection-final/preferred-results.asm',
    'v4-selection-final/sort-score-comparator.asm'
  ],
  timing: [
    'implementation/continuous-playback-rate.asm',
    'implementation/continuous-transition-time.asm',
    'implementation/automation-ramp-value.asm',
    'implementation/automation-easing.asm'
  ],
  catalogue: ['template-call-map.json', 'template-curve-id.asm', 'template-curve-easing-id.asm'],
  scoreFold: ['score-core.asm']
}
function generate(reference) {
  const evidence = path.join(reference, 'evidence')
  const files = [...new Set([...rules.map((x) => x[2]), ...Object.values(dependencies).flat()])]
    .sort()
    .map((name) => {
      const bytes = fs.readFileSync(path.join(evidence, name))
      return {
        path: `evidence/${name}`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    })
  return {
    format: 1,
    referencePackage: 'automix-c',
    referenceLicense: 'not-specified-in-reference-package',
    baseline: 'raw evidence disassembly; compiled-asm is not behavioral evidence',
    scoring: rules.map(([name, address, file]) => ({
      name,
      address,
      evidence: `evidence/${file}`,
      implementation: 'x64/scoring.S',
      oracle: 'recovered/am_scoring.c',
      validation: 'tests/differential.cpp',
      scope: 'recovered arithmetic; upstream analysis is separate'
    })),
    groups: dependencies,
    files,
    independent: [
      'CandidatePlanner.cpp',
      'FeatureFrontend.cpp',
      'ModelRuntime.cpp',
      'TransitionEffects.cpp',
      'AutoMixAnalyzer.cpp'
    ],
    unresolved: [
      'native entropy/seconds-to-milliseconds environment',
      'Apple regional loudness calibration',
      'private AU effect sound and ordinal mapping',
      'original Song structure/model parity'
    ],
    distributionExclusions: [
      'raw evidence snapshots',
      'Apple framework binaries',
      'Apple original executable/models',
      'compiled-asm reference output',
      'oracle library',
      'conversion fixtures'
    ]
  }
}
if (require.main === module) {
  const i = process.argv.indexOf('--reference')
  if (i < 0 || !process.argv[i + 1])
    throw new Error(
      'Usage: node scripts/automix-evidence-manifest.cjs --reference <automix-c directory>'
    )
  const manifest = generate(path.resolve(process.argv[i + 1]))
  const target = path.join(root, 'audio-engine/automix/evidence-manifest.json')
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    JSON.stringify({
      manifest: target,
      rules: manifest.scoring.length,
      evidenceFiles: manifest.files.length
    })
  )
}
module.exports = { generate }
