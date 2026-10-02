import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractAssetDigestSha256,
  extractChecksumFromBody,
  pickLatestAvailableRelease,
  pickWindowsAsset,
  compareAppVersions,
  parseAppVersion
} from './appUpdateHelpers.ts'

test('pickWindowsAsset prefers setup.exe over plain exe', () => {
  const picked = pickWindowsAsset([
    { name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt' },
    { name: 'TwilightEcho-1.0.2.exe', browser_download_url: 'https://example.com/a.exe' },
    {
      name: 'TwilightEcho-1.0.2-setup.exe',
      browser_download_url: 'https://example.com/setup.exe'
    }
  ])
  assert.equal(picked?.name, 'TwilightEcho-1.0.2-setup.exe')
})

test('preview channel skips drafts and accepts a published prerelease', () => {
  const release = pickLatestAvailableRelease(
    [
      { tag_name: 'v1.0.3', draft: true },
      { tag_name: 'v1.0.2', prerelease: true }
    ],
    'preview'
  )

  assert.equal(release?.tag_name, 'v1.0.2')
})

test('stable channel excludes prerelease flags and tags and sorts by SemVer', () => {
  assert.equal(
    pickLatestAvailableRelease([
      { tag_name: 'v2.0.0-beta.1' },
      { tag_name: 'v3.0.0', prerelease: true },
      { tag_name: 'v1.0.0' },
      { tag_name: 'v1.2.0' },
      { tag_name: 'garbage' }
    ])?.tag_name,
    'v1.2.0'
  )
  assert.equal(pickLatestAvailableRelease([{ tag_name: 'v2.0.0-beta' }]), null)
})

test('SemVer follows prerelease precedence, numeric identifiers, and build metadata', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0'
  ]
  for (let i = 1; i < ordered.length; i++)
    assert.ok(compareAppVersions(ordered[i], ordered[i - 1]) > 0)
  assert.ok(compareAppVersions('1.2.4-beta.1', '1.2.4') < 0)
  assert.equal(compareAppVersions('v1.2.4+build.3', '1.2.4+other'), 0)
  assert.ok(compareAppVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992') > 0)
  for (const invalid of ['1.2', '01.2.3', '1.2.3-beta.01', 'latest', '1.2.3-'])
    assert.equal(parseAppVersion(invalid), null)
})

test('installer selection rejects paths and other CPU architectures', () => {
  const assets = [
    '../bad-setup.exe',
    'TwilightEcho-arm64-setup.exe',
    'TwilightEcho-x64-setup.exe'
  ].map((name) => ({ name, browser_download_url: 'https://example.com/a.exe' }))
  assert.equal(pickWindowsAsset(assets, 'x64')?.name, 'TwilightEcho-x64-setup.exe')
})

test('checksum matching does not use a different installer filename', () => {
  assert.equal(
    extractChecksumFromBody(
      `${'a'.repeat(64)}  other-TwilightEcho-setup.exe`,
      'TwilightEcho-setup.exe'
    ),
    undefined
  )
})

test('extractAssetDigestSha256 accepts GitHub release asset digests', () => {
  const checksum = 'a'.repeat(64)

  assert.equal(extractAssetDigestSha256(`sha256:${checksum.toUpperCase()}`), checksum)
  assert.equal(extractAssetDigestSha256('sha512:abc'), undefined)
})

test('extractChecksumFromBody finds hash next to asset name', () => {
  const body = `
## Checksums
abc123 is wrong
deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  TwilightEcho-1.0.2-setup.exe
`
  const hash = extractChecksumFromBody(body, 'TwilightEcho-1.0.2-setup.exe')
  assert.equal(hash, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
})

test('extractChecksumFromBody returns undefined when missing', () => {
  assert.equal(extractChecksumFromBody('no hashes here', 'a-setup.exe'), undefined)
})
