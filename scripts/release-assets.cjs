// Release asset bookkeeping for the macOS and Linux packaging workflows.
//
// The packaging workflows upload their installers as run artifacts. When a
// release tag is present they hand those installers to this script, which
// writes the `<installer>.sha256` companion files and decides whether every
// platform is already attached to the GitHub release. A release only leaves
// draft state once both package workflows contributed their complete asset
// set, so a failed or cancelled half of a multi-platform release never becomes
// publicly downloadable.
const { createHash } = require('node:crypto')
const { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { basename, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const CHECKSUM_SUFFIX = '.sha256'
const MACOS_ARCHES = ['x64', 'arm64']
const MACOS_TARGETS = ['dmg', 'zip']
// Kebab and underscore forms are both produced by electron-builder's default
// Linux artifact names; matching on the extension keeps this independent of
// the installer naming scheme.
const LINUX_ASSET_EXTENSIONS = ['.AppImage', '.deb', '.rpm', '.tar.gz']
const PLATFORMS = ['macos', 'linux', 'all']

function hashFile(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function readProductName(projectRoot = root) {
  const config = readFileSync(join(projectRoot, 'electron-builder.yml'), 'utf8')
  const productName = config.match(/^productName:\s*(.+?)\s*$/m)?.[1]
  if (!productName) {
    throw new Error('electron-builder.yml does not declare productName')
  }
  return productName.replace(/^['"]|['"]$/g, '')
}

function readPackageVersion(projectRoot = root) {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  if (!manifest.version) {
    throw new Error('package.json does not declare a version')
  }
  return manifest.version
}

function macosAssetNames(productName, version) {
  return MACOS_ARCHES.flatMap((arch) =>
    MACOS_TARGETS.map((target) => `${productName}-${version}-mac-${arch}.${target}`)
  )
}

function isChecksumAsset(name) {
  return name.endsWith(CHECKSUM_SUFFIX)
}

function listPackagedFiles(directory) {
  return readdirSync(directory)
    .filter((name) => !isChecksumAsset(name))
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort()
}

async function writeChecksumFiles(directory, { hash = hashFile } = {}) {
  const files = listPackagedFiles(directory)
  if (files.length === 0) {
    throw new Error(`No release assets were found in ${directory}`)
  }
  const checksums = []
  for (const name of files) {
    const digest = await hash(join(directory, name))
    const checksumPath = join(directory, `${name}${CHECKSUM_SUFFIX}`)
    // `sha256sum` compatible format: digest, two spaces, file name.
    writeFileSync(checksumPath, `${digest}  ${basename(name)}\n`)
    checksums.push(checksumPath)
  }
  return checksums
}

function normalizePlatforms(platform) {
  if (platform === 'all') return ['macos', 'linux']
  if (platform === 'macos' || platform === 'linux') return [platform]
  throw new Error(`Unsupported platform "${platform}"; expected one of ${PLATFORMS.join(', ')}`)
}

/**
 * Decide whether a GitHub release already carries every package this project
 * publishes. `assets` accepts the `assets` array returned by the GitHub API /
 * `gh release view --json assets`.
 */
function evaluateReleaseAssets({
  productName,
  version,
  assets,
  platform = 'all',
  requireChecksums = true
}) {
  const platforms = normalizePlatforms(platform)
  const names = new Set(assets.map((asset) => asset.name))
  const payloads = assets.filter((asset) => !isChecksumAsset(asset.name))
  const missing = []

  if (platforms.includes('macos')) {
    for (const name of macosAssetNames(productName, version)) {
      if (!names.has(name)) missing.push(name)
    }
  }
  if (platforms.includes('linux')) {
    for (const extension of LINUX_ASSET_EXTENSIONS) {
      if (!payloads.some((asset) => asset.name.endsWith(extension))) {
        missing.push(`*${extension}`)
      }
    }
  }

  const missingChecksums = requireChecksums
    ? payloads
        .filter((asset) => !names.has(`${asset.name}${CHECKSUM_SUFFIX}`))
        .map((asset) => asset.name)
    : []
  const empty = assets.filter((asset) => !(Number(asset.size) > 0)).map((asset) => asset.name)

  return {
    complete: missing.length === 0 && missingChecksums.length === 0 && empty.length === 0,
    missing,
    missingChecksums,
    empty
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`)
    }
    options[argument.slice(2)] = value
    index += 1
  }
  return options
}

function readAssetsFile(filePath) {
  const parsed = JSON.parse(readFileSync(resolve(filePath), 'utf8'))
  const assets = Array.isArray(parsed) ? parsed : parsed.assets
  if (!Array.isArray(assets)) {
    throw new Error(`${filePath} does not contain a release asset list`)
  }
  return assets
}

function describe(result, platform) {
  const problems = []
  if (result.missing.length > 0) problems.push(`missing assets: ${result.missing.join(', ')}`)
  if (result.missingChecksums.length > 0) {
    problems.push(`missing .sha256 companions: ${result.missingChecksums.join(', ')}`)
  }
  if (result.empty.length > 0) problems.push(`empty assets: ${result.empty.join(', ')}`)
  return problems.length === 0
    ? `Release asset verification passed for ${platform}`
    : `Release asset verification failed for ${platform} (${problems.join('; ')})`
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === 'checksum') {
    const directory = rest[0]
    if (!directory) throw new Error('Usage: release-assets.cjs checksum <directory>')
    const checksums = await writeChecksumFiles(resolve(directory))
    console.log(`Wrote ${checksums.length} SHA-256 companion files in ${directory}`)
    return
  }
  if (command === 'verify') {
    const options = parseArguments(rest)
    if (!options.assets) {
      throw new Error(
        'Usage: release-assets.cjs verify --assets <release.json> [--version <version>] ' +
          '[--platform macos|linux|all] [--product <name>]'
      )
    }
    const version = options.version ?? readPackageVersion()
    const platform = options.platform ?? 'all'
    const result = evaluateReleaseAssets({
      productName: options.product ?? readProductName(),
      version,
      assets: readAssetsFile(options.assets),
      platform
    })
    console.log(describe(result, platform))
    if (!result.complete) process.exitCode = 1
    return
  }
  throw new Error(`Unknown command: ${command ?? '(none)'}`)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

module.exports = {
  CHECKSUM_SUFFIX,
  LINUX_ASSET_EXTENSIONS,
  MACOS_ARCHES,
  MACOS_TARGETS,
  evaluateReleaseAssets,
  hashFile,
  isChecksumAsset,
  listPackagedFiles,
  macosAssetNames,
  readPackageVersion,
  readProductName,
  writeChecksumFiles
}
