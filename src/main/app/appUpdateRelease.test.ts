import assert from 'node:assert/strict'
import test from 'node:test'
import { AppUpdateReleaseClient } from './appUpdateRelease.ts'
import { GITHUB_API_LATEST_RELEASE_URL, GITHUB_API_RELEASES_URL } from '../../shared/projectUrls.ts'

const sha = 'a'.repeat(64)
const installer = {
  name: 'TwilightEcho-setup.exe',
  size: 40,
  browser_download_url: 'https://example.com/setup.exe'
}
const resolve = (client: AppUpdateReleaseClient, channel: 'stable' | 'preview' = 'stable') =>
  client.resolve('1.0.0', channel, 'win32', 'x64', new AbortController().signal)

test('stable fallback ignores preview releases while the preview channel includes them', async () => {
  const client = new AppUpdateReleaseClient(async (url) =>
    String(url) === GITHUB_API_LATEST_RELEASE_URL
      ? new Response('', { status: 404 })
      : Response.json([
          {
            tag_name: '3.0.0-beta.1',
            prerelease: true,
            assets: [{ ...installer, digest: 'sha256:' + sha }]
          },
          { tag_name: '2.0.0', assets: [{ ...installer, digest: 'sha256:' + sha }] }
        ])
  )
  assert.equal((await resolve(client)).check.latestVersion, '2.0.0')
  assert.equal((await resolve(client, 'preview')).check.latestVersion, '3.0.0-beta.1')
})

test('release ETags support conditional checks without losing metadata', async () => {
  let calls = 0
  const client = new AppUpdateReleaseClient(async (_url, init) => {
    if (++calls === 1)
      return Response.json(
        { tag_name: '2.0.0', assets: [{ ...installer, digest: 'sha256:' + sha }] },
        { headers: { etag: 'release-v2' } }
      )
    assert.equal(new Headers(init?.headers).get('if-none-match'), 'release-v2')
    return new Response(null, { status: 304 })
  })
  assert.equal((await resolve(client)).asset?.sha256, sha)
  assert.equal((await resolve(client)).asset?.sha256, sha)
})

test('checksum lists require an exact filename, and only exact companion files allow bare hashes', async () => {
  let name = 'SHA256SUMS',
    content = `${sha}  another-setup.exe`
  const client = new AppUpdateReleaseClient(async (url) =>
    String(url).endsWith('/sums')
      ? new Response(content)
      : Response.json({
          tag_name: '2.0.0',
          assets: [installer, { name, browser_download_url: 'https://example.com/sums' }]
        })
  )
  assert.equal((await resolve(client)).check.error, 'no-checksum')
  content = `${sha}  TwilightEcho-setup.exe`
  assert.equal((await resolve(client)).asset?.sha256, sha)
  content = sha
  assert.equal((await resolve(client)).check.error, 'no-checksum')
  name = 'TwilightEcho-setup.exe.sha256'
  assert.equal((await resolve(client)).asset?.sha256, sha)
})

test('failed checksum requests are network failures, not missing checksums', async () => {
  const client = new AppUpdateReleaseClient(async (url) => {
    if (String(url).endsWith('/sums')) throw new Error('network failed')
    return Response.json({
      tag_name: '2.0.0',
      assets: [installer, { name: 'SHA256SUMS', browser_download_url: 'https://example.com/sums' }]
    })
  })
  await assert.rejects(resolve(client), /network failed/)
})

test('invalid metadata and rate limits have explicit failures', async () => {
  const limited = new AppUpdateReleaseClient(
    async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  )
  await assert.rejects(resolve(limited), { code: 'rate-limit' })
  const invalid = new AppUpdateReleaseClient(async () => Response.json({ tag_name: 'garbage' }))
  await assert.rejects(resolve(invalid), { code: 'invalid-release' })
  const insecure = new AppUpdateReleaseClient(async () =>
    Response.json({
      tag_name: '2.0.0',
      assets: [
        {
          ...installer,
          browser_download_url: 'http://example.com/setup.exe',
          digest: 'sha256:' + sha
        }
      ]
    })
  )
  await assert.rejects(resolve(insecure), { code: 'invalid-release' })
})

test('preview checks use the release list and non-Windows platforms offer manual downloads', async () => {
  const client = new AppUpdateReleaseClient(async (url) => {
    assert.equal(String(url), GITHUB_API_RELEASES_URL)
    return Response.json([
      { tag_name: '2.0.0', assets: [{ ...installer, digest: 'sha256:' + sha }] }
    ])
  })
  const result = await client.resolve(
    '1.0.0',
    'preview',
    'linux',
    'x64',
    new AbortController().signal
  )
  assert.equal(result.check.error, 'unsupported-platform')
  assert.equal(result.check.hasUpdate, true)
  assert.equal(result.asset, null)
})
