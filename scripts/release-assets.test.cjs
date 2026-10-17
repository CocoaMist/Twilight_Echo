const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  CHECKSUM_SUFFIX,
  LINUX_ASSET_EXTENSIONS,
  evaluateReleaseAssets,
  macosAssetNames,
  writeChecksumFiles
} = require('./release-assets.cjs')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function releaseAssets(names, { size = 1024 } = {}) {
  return names.map((name) => ({ name, size }))
}

function macosRelease(productName = 'TwilightEcho', version = '1.3.1') {
  const names = macosAssetNames(productName, version)
  return releaseAssets([...names, ...names.map((name) => `${name}${CHECKSUM_SUFFIX}`)])
}

function linuxRelease() {
  const names = [
    'TwilightEcho-1.3.1.AppImage',
    'TwilightEcho_1.3.1_amd64.deb',
    'TwilightEcho-1.3.1.x86_64.rpm',
    'TwilightEcho-1.3.1.tar.gz'
  ]
  return releaseAssets([...names, ...names.map((name) => `${name}${CHECKSUM_SUFFIX}`)])
}

test('checksum companions carry the sha256sum format and skip existing digests', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-checksums-'))
  try {
    fs.writeFileSync(path.join(directory, 'TwilightEcho-1.3.1-mac-arm64.dmg'), 'mac-package')
    fs.writeFileSync(path.join(directory, 'TwilightEcho-1.3.1.tar.gz'), 'linux-package')
    fs.writeFileSync(path.join(directory, 'stale.sha256'), 'stale')

    const checksums = await writeChecksumFiles(directory)
    assert.deepEqual(checksums.map((file) => path.basename(file)).sort(), [
      'TwilightEcho-1.3.1-mac-arm64.dmg.sha256',
      'TwilightEcho-1.3.1.tar.gz.sha256'
    ])
    const digest = createHash('sha256').update('mac-package').digest('hex')
    assert.equal(
      fs.readFileSync(path.join(directory, 'TwilightEcho-1.3.1-mac-arm64.dmg.sha256'), 'utf8'),
      `${digest}  TwilightEcho-1.3.1-mac-arm64.dmg\n`
    )
    assert.equal(fs.readFileSync(path.join(directory, 'stale.sha256'), 'utf8'), 'stale')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('checksum generation refuses a directory without release assets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-empty-'))
  try {
    await assert.rejects(() => writeChecksumFiles(directory), /No release assets were found/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a macOS release requires both dmg and zip packages for x64 and arm64', () => {
  const result = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: macosRelease(),
    platform: 'macos'
  })
  assert.equal(result.complete, true)
  assert.deepEqual(result.missing, [])

  const missing = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: releaseAssets([
      'TwilightEcho-1.3.1-mac-x64.dmg',
      'TwilightEcho-1.3.1-mac-x64.dmg.sha256'
    ]),
    platform: 'macos'
  })
  assert.equal(missing.complete, false)
  assert.deepEqual(
    missing.missing,
    macosAssetNames('TwilightEcho', '1.3.1').filter(
      (name) => name !== 'TwilightEcho-1.3.1-mac-x64.dmg'
    )
  )
})

test('macOS asset names stay bound to the release version', () => {
  assert.deepEqual(macosAssetNames('TwilightEcho', '1.3.1'), [
    'TwilightEcho-1.3.1-mac-x64.dmg',
    'TwilightEcho-1.3.1-mac-x64.zip',
    'TwilightEcho-1.3.1-mac-arm64.dmg',
    'TwilightEcho-1.3.1-mac-arm64.zip'
  ])
  const stale = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.2',
    assets: macosRelease('TwilightEcho', '1.3.1'),
    platform: 'macos'
  })
  assert.equal(stale.complete, false)
})

test('a Linux release requires every packaged format and ignores checksum suffixes', () => {
  const result = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: linuxRelease(),
    platform: 'linux'
  })
  assert.equal(result.complete, true)

  const missing = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: releaseAssets(
      [
        'TwilightEcho-1.3.1.AppImage',
        'TwilightEcho-1.3.1.AppImage.sha256',
        'TwilightEcho_1.3.1_amd64.deb',
        'TwilightEcho_1.3.1_amd64.deb.sha256'
      ],
      { size: 16 }
    ),
    platform: 'linux'
  })
  assert.equal(missing.complete, false)
  assert.deepEqual(missing.missing, ['*.rpm', '*.tar.gz'])
})

test('only checksum assets do not satisfy the installer requirement', () => {
  const result = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: LINUX_ASSET_EXTENSIONS.map((extension) => ({
      name: `TwilightEcho-1.3.1${extension}.sha256`,
      size: 64
    })),
    platform: 'linux'
  })
  assert.equal(result.complete, false)
  assert.equal(result.missing.length, LINUX_ASSET_EXTENSIONS.length)
})

test('payload assets without a checksum companion fail verification', () => {
  const assets = [...linuxRelease(), { name: 'TwilightEcho-1.3.1-setup.exe', size: 4096 }]
  const result = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets,
    platform: 'all'
  })
  assert.equal(result.complete, false)
  assert.deepEqual(result.missingChecksums, ['TwilightEcho-1.3.1-setup.exe'])
})

test('empty uploads fail verification', () => {
  const assets = [...macosRelease(), ...linuxRelease()]
  assets[0].size = 0
  const result = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets,
    platform: 'all'
  })
  assert.equal(result.complete, false)
  assert.deepEqual(result.empty, [assets[0].name])
})

test('platform scopes let one package workflow publish its own half of the release', () => {
  const macosOnly = [...macosRelease()]
  const result = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: macosOnly,
    platform: 'macos'
  })
  assert.equal(result.complete, true)
  const aggregate = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: macosOnly,
    platform: 'all'
  })
  assert.equal(aggregate.complete, false)
  assert.deepEqual(
    aggregate.missing,
    LINUX_ASSET_EXTENSIONS.map((ext) => `*${ext}`)
  )

  const project = evaluateReleaseAssets({
    productName: 'TwilightEcho',
    version: '1.3.1',
    assets: [...macosRelease(), ...linuxRelease()],
    platform: 'all'
  })
  assert.equal(project.complete, true)
})

test('unknown release platforms are rejected instead of silently passing', () => {
  assert.throws(
    () =>
      evaluateReleaseAssets({
        productName: 'TwilightEcho',
        version: '1.3.1',
        assets: [],
        platform: 'windows'
      }),
    /Unsupported platform "windows"/
  )
})

test('the release configuration still declares the product name the assets are named after', () => {
  const config = read('electron-builder.yml')
  assert.match(config, /^productName:\s*TwilightEcho\s*$/m)
})

test('packaging workflows publish tag releases only after every platform uploaded', () => {
  for (const [workflowPath, platform] of [
    ['.github/workflows/build-macos.yml', 'macos'],
    ['.github/workflows/build-linux.yml', 'linux']
  ]) {
    const workflow = read(workflowPath)
    // Tag pushes publish; manual runs need an explicit release tag.
    assert.match(workflow, /^on:\n {2}workflow_dispatch:/m, workflowPath)
    assert.match(workflow, /^ {4}inputs:\n {6}release_tag:/m, workflowPath)
    assert.match(workflow, /^ {2}push:\n {4}tags:\n {6}- 'v\*'/m, workflowPath)
    // Packaging itself must never hand control to electron-builder's publisher.
    assert.match(workflow, /--publish never/, workflowPath)
    assert.match(
      workflow,
      /node scripts\/release-assets\.cjs checksum release-assets/,
      workflowPath
    )
    assert.match(
      workflow,
      /node scripts\/release-assets\.cjs verify --assets release-assets\.json/,
      workflowPath
    )
    assert.match(workflow, new RegExp(`--platform ${platform}\\n`), workflowPath)
    assert.match(workflow, /--platform all; then/, workflowPath)
    assert.match(
      workflow,
      /gh release upload "\$RELEASE_TAG" release-assets\/\* --clobber/,
      workflowPath
    )
    assert.match(workflow, /gh release edit "\$RELEASE_TAG" --draft=false/, workflowPath)
    assert.match(workflow, /contents: write/, workflowPath)
    // The draft title is user facing and must not claim a different version.
    assert.match(workflow, /--title "Twilight Echo \$\{RELEASE_TAG#v\}"/, workflowPath)
  }
})
