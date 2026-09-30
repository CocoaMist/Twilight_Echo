const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const {
  PRESETS,
  createStressLibraryDocument,
  createThemeGoldenCases,
  parseArgs,
  seedStressLibrary
} = require('./theme-visual-regression.cjs')

test('theme golden matrix covers 90 no-cover combinations and seven built-in presets', () => {
  const cases = createThemeGoldenCases()
  const matrix = cases.filter((entry) => entry.kind === 'matrix')
  const presets = cases.filter((entry) => entry.kind === 'preset')

  assert.equal(cases.length, 97)
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 97)
  assert.equal(matrix.length, 2 * 3 * 5 * 3)
  assert.equal(presets.length, PRESETS.length)
  assert.deepEqual(new Set(matrix.map((entry) => entry.scale)), new Set([1, 1.25, 1.5]))
  assert.ok(cases.every((entry) => entry.id.endsWith('no-cover')))
})

test('theme visual stress fixture writes an isolated 10k schema-v2 library', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-theme-visual-'))
  try {
    const { library } = seedStressLibrary(root)
    const document = JSON.parse(readFileSync(library, 'utf8'))
    assert.equal(document.version, 2)
    assert.equal(document.tracks.length, 10_000)
    assert.equal(document.tracks[0].cover, '')
    assert.equal(document.tracks.at(-1).id, 'local:p7-stress:9999')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('theme visual seed writes a no-BOM settings profile that skips onboarding', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-theme-seed-'))
  const mediaFolder = join(root, 'media')
  const { mkdirSync, writeFileSync } = require('node:fs')
  mkdirSync(mediaFolder, { recursive: true })
  writeFileSync(join(mediaFolder, 'a.wav'), Buffer.alloc(64))
  try {
    const { settings } = seedStressLibrary(root, 10_000, [mediaFolder])
    const bytes = readFileSync(settings)
    assert.equal(bytes[0] !== 0xef, true, 'settings.json must not start with a UTF-8 BOM')
    const parsed = JSON.parse(bytes.toString('utf8'))
    assert.equal(parsed.onboardingCompleted, true)
    assert.equal(parsed.startupHomePage, 'local')
    assert.deepEqual(parsed.libraryFolders, [mediaFolder])

    const withoutFolder = seedStressLibrary(join(root, 'plain'), 1, null)
    const plain = JSON.parse(readFileSync(withoutFolder.settings, 'utf8'))
    assert.deepEqual(plain.libraryFolders, [])
    assert.equal(plain.onboardingCompleted, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('theme visual seed can generate a real mini-WAV library for the stress benchmark', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-theme-wav-'))
  try {
    const seeded = seedStressLibrary(root, 10_000, null, 4)
    assert.ok(seeded.mediaFolder, 'media folder was not generated')
    const wavFiles = readdirSync(seeded.mediaFolder).filter((file) => file.endsWith('.wav'))
    assert.equal(wavFiles.length, 4)
    assert.equal(wavFiles[0], 'track-00001.wav')
    const settings = JSON.parse(readFileSync(seeded.settings, 'utf8'))
    assert.deepEqual(settings.libraryFolders, [seeded.mediaFolder])
    assert.equal(settings.onboardingCompleted, true)

    const { parseFile } = require('music-metadata')
    const meta = await parseFile(join(seeded.mediaFolder, wavFiles[0]))
    assert.equal(meta.format.container, 'WAVE')
    assert.equal(meta.format.codec, 'PCM')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('theme visual runner parses explicit CDP, output, baseline, and viewport options', () => {
  const mediaFolder = join(tmpdir(), 'twilight-theme-visual-media')
  const options = parseArgs([
    '--port',
    '9333',
    '--output',
    'output/current',
    '--baseline',
    'output/baseline',
    '--width',
    '1200',
    '--height',
    '800',
    '--seed-library-folder',
    mediaFolder,
    '--seed-real-files',
    '100'
  ])
  assert.equal(options.port, 9333)
  assert.equal(options.width, 1200)
  assert.equal(options.height, 800)
  assert.match(options.outputDir, /output[\\/]current$/)
  assert.match(options.baselineDir, /output[\\/]baseline$/)
  assert.equal(options.seedLibraryFolder, mediaFolder)
  assert.equal(options.seedRealFiles, 100)
  assert.equal(createStressLibraryDocument(3).tracks.length, 3)
  assert.equal(parseArgs(['--help']).help, true)
})
