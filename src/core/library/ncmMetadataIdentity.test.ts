import test from 'node:test'
import assert from 'node:assert/strict'
import { ncmMetadataIdentity } from './ncmMetadataIdentity.ts'
import { metadataProviderReference } from '../../shared/metadataProviders.ts'
import { PlatformMetadataProvider } from './platformMetadataProvider.ts'

const MB = '151bb385-1af0-40b6-9269-bf2ed982311f'
const policy = { publicServiceApproved: true, contact: 'https://example.org/player' }
const signal = () => new AbortController().signal
const rel = (resource: string) => ({ 'target-type': 'url', url: { resource } })
test('NCM follows only unique typed MusicBrainz cross-links, never the first search result or a release-group', async () => {
  let relations = [rel('https://music.163.com/#/artist?id=999238')],
    calls = 0
  const resolver = ncmMetadataIdentity(
    () => policy,
    async (url, init) => {
      calls++
      assert.match(String(url), /\/artist\/151bb385.*inc=url-rels/)
      assert.ok(init?.signal)
      return new Response(JSON.stringify({ id: MB, relations }))
    }
  )
  assert.equal(await resolver.resolve('artist', '999238', signal()), '999238')
  assert.equal(calls, 0)
  assert.equal(await resolver.resolve('artist', MB, signal()), '999238')
  relations.push(rel('http://music.163.com/artist?id=999238'))
  assert.equal(await resolver.resolve('artist', MB, signal()), '999238')
  relations.push(rel('https://music.163.com/artist?id=42'))
  assert.equal(await resolver.resolve('artist', MB, signal()), null)
  for (const url of [
    'https://music.163.com/album?id=42',
    'https://music.163.com.evil/artist?id=42',
    'https://user:password@music.163.com/artist?id=42',
    'https://music.163.com/artist?id=42&redirect=x'
  ]) {
    relations = [rel(url)]
    assert.equal(await resolver.resolve('artist', MB, signal()), null)
  }
  await assert.rejects(resolver.resolve('album_project', MB, signal()), /Invalid NCM/)
  assert.equal(
    metadataProviderReference('platform.ncm', 'album_project', [
      { provider: 'musicbrainz', kind: 'album_project', idType: 'mbid', value: MB }
    ]),
    undefined
  )
  assert.equal(
    metadataProviderReference('platform.ncm', 'artist', [
      { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: MB },
      { provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }
    ])?.value,
    '42'
  )
})

test('native IDs remain usable without MB permission; cross-link failures and cancellation are not empty successes', async () => {
  const disabled = ncmMetadataIdentity(
    () => ({ ...policy, publicServiceApproved: false }),
    async () => {
      throw Error('must not fetch')
    }
  )
  assert.equal(await disabled.resolve('artist', '42', signal()), '42')
  await assert.rejects(disabled.resolve('artist', MB, signal()), /not_approved/)
  for (const status of [403, 429, 503]) {
    const resolver = ncmMetadataIdentity(
      () => policy,
      async () => new Response('', { status })
    )
    await assert.rejects(resolver.resolve('artist', MB, signal()), new RegExp(String(status)))
  }
  const resolver = ncmMetadataIdentity(
    () => policy,
    async () => new Response(JSON.stringify({ id: 'wrong', relations: [] }))
  )
  await assert.rejects(resolver.resolve('artist', MB, signal()), /Invalid MusicBrainz/)
  const c = new AbortController()
  c.abort(Error('cancelled'))
  await assert.rejects(resolver.resolve('artist', '42', c.signal), /cancelled/)
})

test('MB permission changes fence an active cross-link request without disabling native cached context', async () => {
  const state = { ...policy }
  const resolver = ncmMetadataIdentity(() => state, async () => {
    state.publicServiceApproved = false
    return new Response(JSON.stringify({ id: MB, relations: [rel('https://music.163.com/artist?id=42')] }))
  })
  const original = resolver.context()
  await assert.rejects(resolver.resolve('artist', MB, signal()), /configuration_changed/)
  assert.equal(resolver.context(), original)
  assert.equal(await resolver.resolve('artist', '42', signal()), '42')
})

test('resolved native identity is verified against the actual DTO and fenced across configuration changes', async () => {
  let configuration = 'a',
    calls = 0,
    responseId = '42',
    change = false
  const provider = new PlatformMetadataProvider('ncm', {
    inventory: () => [
      { id: 'ncm', enabled: true, supportedMethods: ['fetchArtistMetadata'], configuration }
    ],
    usage: () => ({ display: true, cache: true, crossSource: true, export: false }),
    identity: {
      context: () => configuration,
      resolve: async () => {
        if (change) configuration = 'b'
        return '42'
      }
    },
    call: async (_p, _m, id) => {
      calls++
      assert.equal(id, '42')
      return {
        status: 'ok',
        metadata: {
          schemaVersion: 1,
          provider: 'ncm',
          kind: 'artist',
          id: responseId,
          name: 'Name',
          texts: []
        }
      }
    }
  })
  await provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal())
  responseId = '43'
  await assert.rejects(
    provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal()),
    /identity mismatch/
  )
  change = true
  await assert.rejects(
    provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal()),
    /configuration_changed/
  )
  assert.equal(calls, 2)
})
