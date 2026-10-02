import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

// node --experimental-strip-types scripts/code-relief-benchmark.mjs [--small]
// Optional --baseline=<git-ref>, --removals=1000,2000. Large removals have a slow baseline.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const baseline = option('baseline', '4af3094f')
const small = process.argv.includes('--small')
const repetitions = small ? 3 : 5
const warmups = small ? 1 : 2
const removals = option('removals', small ? '20' : '1000')
  .split(',')
  .map(Number)
assert.ok(removals.every((count) => Number.isSafeInteger(count) && count > 0))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const sources = []

async function loadPair(relativePath, extraExports = '') {
  sources.push(relativePath)
  const url = pathToFileURL(join(repository, relativePath))
  return Promise.all(
    [true, false].map(async (old) => {
      const source = old ? git('show', `${baseline}:${relativePath}`) : readFileSync(url, 'utf8')
      const code = stripTypeScriptTypes(source + extraExports).replace(
        /(from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
        (_, prefix, quote, specifier) => `${prefix}${quote}${new URL(specifier, url).href}${quote}`
      )
      return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
    })
  )
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median_ms: sorted[Math.floor(sorted.length / 2)],
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples_ms: samples
  }
}

const results = []
async function compare(name, functions, size) {
  assert.deepEqual(await functions[0](), await functions[1](), `${name}: initial parity`)
  const samples = [[], []]
  for (let iteration = -warmups; iteration < repetitions; iteration++) {
    for (const side of iteration % 2 === 0 ? [0, 1] : [1, 0]) {
      const started = performance.now()
      await functions[side]()
      if (iteration >= 0) samples[side].push(performance.now() - started)
    }
    await new Promise((done) => setImmediate(done))
  }
  assert.deepEqual(await functions[0](), await functions[1](), `${name}: final parity`)
  const [before, after] = samples.map(summarize)
  results.push({ name, ...size, complete_result_equal: true, before, after })
}

const collectionModules = await loadPair('src/renderer/src/utils/libraryCollectionView.ts')
const collectionCount = small ? 20 : 2000
const collections = Array.from({ length: collectionCount }, (_, index) => ({
  id: String(index),
  name: ['专辑', 'Album', 'Écho', 'album'][index % 4] + ((index * 7919) % collectionCount),
  tracks: Array.from({ length: small ? 3 : 50 }, (_, trackIndex) => ({
    addedAt: (index * 7919 + trackIndex * 37) % 10000
  }))
}))
for (const sort of ['name-asc', 'name-desc', 'added-newest', 'added-oldest']) {
  await compare(
    `collection-${sort}`,
    collectionModules.map(
      (api) => () => api.applyLibraryCollectionView(collections, { sort, genre: null })
    ),
    { collections: collectionCount, tracks: collectionCount * (small ? 3 : 50) }
  )
}
const albumModules = await loadPair('src/renderer/src/stores/library/musicStoreData.ts')
const albumTracks = Array.from({ length: small ? 50 : 5000 }, (_, index) => ({
  fileName: `曲目${(index * 7919) % 5000}.flac`,
  title: `歌曲${index}`
}))
await compare(
  'album-order-without-tags',
  albumModules.map((api) => () => [...albumTracks].sort(api.compareAlbumTrackOrder)),
  { tracks: albumTracks.length }
)

const coordinators = await loadPair(
  'src/main/library/libraryIndexCoordinator.ts',
  '\nexport { createScanAccumulator, finalizeScanAccumulator }\n'
)
for (const count of removals) {
  const tracks = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    filePath: `C:\\Benchmark\\Music\\Track-${index}.flac`
  }))
  const document = { version: 2, revision: 7, tracks, folders: [], exclusions: [] }
  const worker = {
    removedFilePaths: tracks.map((track) => track.filePath),
    completeIdentitySnapshot: true,
    identities: []
  }
  await compare(
    'scan-removal-finalization',
    coordinators.map(
      (api) => () =>
        api.finalizeScanAccumulator(document, api.createScanAccumulator(document), worker)
    ),
    { tracks: count }
  )
}

const storeModules = await loadPair('src/main/persistence/versionedDataStore.ts')
const directory = mkdtempSync(join(tmpdir(), 'echora-code-relief-benchmark-'))
try {
  const data = Array.from({ length: small ? 100 : 20000 }, (_, index) => ({
    id: `local:${index}`,
    title: `Track ${index}`,
    artist: 'Synthetic Artist',
    album: `Album ${Math.floor(index / 12)}`,
    filePath: `C:\\Benchmark\\Music\\Track-${index}.flac`,
    duration: 180,
    size: 10000000,
    cover: null,
    lyrics: null
  }))
  const paths = ['baseline.json', 'current.json'].map((name) => join(directory, name))
  const functions = storeModules.map((api, side) => {
    const store = new api.VersionedDataStore({
      filePath: paths[side],
      label: 'benchmark playlist',
      maxBytes: 32 * 1024 * 1024,
      isData: Array.isArray,
      isLegacy: Array.isArray,
      now: () => '2026-10-03T00:00:00.000Z'
    })
    let revision = 0
    return async () => {
      const saved = await store.save(data, revision)
      revision = saved.revision
      return saved
    }
  })
  await compare('versioned-atomic-save', functions, {
    tracks: data.length,
    serialized_bytes: Buffer.byteLength(JSON.stringify(data))
  })
  for (const suffix of ['', '.bak']) {
    assert.equal(readFileSync(paths[0] + suffix, 'utf8'), readFileSync(paths[1] + suffix, 'utf8'))
  }
  results.at(-1).primary_and_backup_bytes_equal = true
} finally {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  rmSync(directory, { recursive: true, force: true })
}

const report = {
  measured_at: new Date().toISOString(),
  baseline_commit: git('rev-parse', baseline),
  current_commit: git('rev-parse', 'HEAD'),
  changes: git('status', '--short', '--', ...sources),
  environment: {
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    locale: Intl.DateTimeFormat().resolvedOptions().locale
  },
  warmups,
  repetitions,
  methodology:
    'Synthetic functions and temporary atomic JSON writes; no audio, devices or network. Alternating baseline/current; nearest-rank p95; complete equality checks outside timing. Relative dependencies resolve to the working tree; target implementations are loaded from each revision.',
  results
}
console.log(JSON.stringify(report, null, 2))
