import assert from 'node:assert/strict'
import test from 'node:test'
import { PublicMusicSource, type PublicMusicPolicy } from './publicMusicSources.ts'
import { MetadataHttp } from './metadataHttp.ts'
import { metadataProviderReference } from '../../shared/metadataProviders.ts'
import type { IdentificationInput } from '../../shared/musicIdentification.ts'

const MB = '151bb385-1af0-40b6-9269-bf2ed982311f'
const policy = (): PublicMusicPolicy => ({
  enabled: true,
  contact: 'https://github.com/Px-asen/Twilight_Echo',
  musicbrainzApproved: true,
  vocadb: true,
  theaudiodb: true,
  audioDbKey: '123',
  discogs: true,
  discogsToken: ''
})
const input = (name = 'Camellia'): IdentificationInput => ({
  entityId: 'local',
  kind: 'artist',
  name,
  artist: name,
  version: '1',
  linkRevision: 0,
  sources: []
})
const signal = () => new AbortController().signal
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })

test('VocaDB exact aliases are independent of MB and never authorize first-result adoption', async () => {
  const p = { ...policy(), musicbrainzApproved: false }
  let seen: URL | undefined
  const provider = new PublicMusicSource(
    'vocadb',
    () => p,
    async (url) => {
      seen = new URL(String(url))
      return json({
        totalCount: 2,
        items: [
          { id: 87747, name: 'xi', artistType: 'Producer', names: [{ value: 'xi' }] },
          { id: 15780, name: 'XI', artistType: 'Animator' }
        ]
      })
    }
  )
  const result = await provider.recall(input('xi'), signal())
  assert.equal(seen!.searchParams.get('nameMatchMode'), 'Exact')
  assert.equal(seen!.searchParams.get('maxResults'), '10')
  assert.equal(result.proposals.length, 2)
  assert.equal(
    result.proposals.some((p) => p.evidence.verification),
    false
  )
  assert.ok(result.proposals.every((p) => p.evidence.missing.includes('recording_corroboration')))
  const slash = await provider.recall(input('AC/DC'), signal())
  assert.equal(seen!.searchParams.get('query'), 'AC/DC')
  assert.equal(slash.proposals.length, 2)
})

test('VocaDB truncation remains incomplete and text rights never authorize user-uploaded pictures', async () => {
  const p = policy()
  const provider = new PublicMusicSource(
    'vocadb',
    () => p,
    async (url) =>
      json(
        String(url).includes('/artists/445')
          ? {
              id: 445,
              name: 'かめりあ',
              names: [{ value: 'Camellia' }],
              version: 7,
              description: { original: '', english: 'Producer biography.' },
              mainPicture: { urlOriginal: 'https://static.vocadb.net/img/artist/445.jpg' },
              webLinks: [{ url: `https://musicbrainz.org/artist/${MB}` }]
            }
          : {
              totalCount: 11,
              items: [{ id: 445, name: 'かめりあ', names: [{ value: 'Camellia' }] }]
            }
      )
  )
  assert.equal((await provider.recall(input(), signal())).incomplete, true)
  const detail = await provider.enrich(
    { kind: 'artist', externalId: '445', language: 'en' },
    signal()
  )
  assert.equal(detail.facts.find((f) => f.field === 'introduction')?.value, 'Producer biography.')
  assert.equal(detail.facts[0].attribution.license, 'CC-BY-4.0')
  assert.equal(detail.artwork, undefined)
  p.artwork = { vocadb: { display: true, cache: true, crossSource: true, export: false } }
  assert.equal(
    (await provider.enrich({ kind: 'artist', externalId: '445', language: 'en' }, signal()))
      .artwork?.[0].targetRef?.value,
    '445'
  )
})

test('TheAudioDB free search is incomplete; exact MBID combines text and rights-checked images', async () => {
  const p = policy(),
    requests: string[] = []
  const row = {
    idArtist: '160215',
    strArtist: 'かめりあ',
    strMusicBrainzID: MB,
    strBiographyCN: '中文简介',
    strBiographyEN: 'English biography',
    strCreativeCommons: 'Yes',
    strArtistThumb: 'https://r2.theaudiodb.com/images/media/artist/thumb/picture.jpg'
  }
  const provider = new PublicMusicSource(
    'theaudiodb',
    () => p,
    async (url) => {
      requests.push(String(url))
      return json({ artists: [row] })
    },
    () => 1000
  )
  const result = await provider.recall(input(), signal())
  assert.equal(result.incomplete, true)
  assert.equal(result.proposals[0].references[1].value, MB)
  const detail = await provider.enrich(
    { kind: 'artist', externalId: MB, language: 'zh-Hans' },
    signal()
  )
  assert.ok(requests.at(-1)!.includes('artist-mb.php'))
  assert.deepEqual(
    detail.facts.filter((f) => f.field === 'introduction').map((f) => f.language),
    ['zh-Hans', 'en']
  )
  assert.equal(detail.artwork?.[0].targetRef?.provider, 'theaudiodb')
  assert.equal(detail.artwork?.[0].usage.export, false)
  assert.equal(detail.artwork?.[0].usage.expiresAt, 1000 + 7 * 86400000)
  row.strCreativeCommons = ''
  assert.equal(
    (await provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal())).artwork,
    undefined
  )
  row.strMusicBrainzID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  assert.equal(
    (await provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal()))
      .availability,
    'not_found'
  )
})

test('MB fallback follows only exact outbound URLs and never searches a same-name person', async () => {
  const p = { ...policy(), discogsToken: 'test-token-for-unit-tests' },
    seen: string[] = []
  let links = ['https://www.discogs.com/artist/123-Artist']
  const provider = new PublicMusicSource(
    'discogs',
    () => p,
    async (url, init) => {
      seen.push(String(url))
      if (String(url).includes('musicbrainz')) {
        assert.equal(new Headers(init!.headers).has('Authorization'), false)
        return json({ id: MB, relations: links.map((resource) => ({ url: { resource } })) })
      }
      assert.equal(
        new Headers(init!.headers).get('Authorization'),
        `Discogs token=${p.discogsToken}`
      )
      return json({
        id: 123,
        name: 'Artist',
        profile: '[b]Biography[/b] [a=Alice] [a4806383] [l1111270]',
        images: [{ uri: 'https://i.discogs.com/picture.jpg' }]
      })
    },
    () => 1000
  )
  const result = await provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal())
  assert.equal(
    result.facts.find((f) => f.field === 'introduction')?.value,
    'Biography Alice Discogs artist #4806383 Discogs label #1111270'
  )
  assert.equal(result.facts[0].usage?.expiresAt, 21601000)
  assert.equal(result.artwork, undefined)
  assert.equal(provider.context().includes(p.discogsToken), false)
  links = [...links, 'https://www.discogs.com/artist/124-Other']
  assert.equal(
    (await provider.enrich({ kind: 'artist', externalId: MB, language: 'en' }, signal()))
      .availability,
    'not_found'
  )
  assert.equal(
    seen.some((url) => url.includes('search')),
    false
  )
})

test('missing keys are local blocked states and release/project namespaces stay distinct', async () => {
  let calls = 0
  const p = policy(),
    provider = new PublicMusicSource(
      'discogs',
      () => p,
      async () => {
        calls++
        return json({})
      }
    )
  assert.equal(provider.identification().blockedReason('artist'), 'discogs_token_required')
  assert.equal(
    provider.blockedReason('artist'),
    null,
    'exact public-ID details do not need a search token'
  )
  await assert.rejects(provider.recall(input(), signal()), /discogs_token_required/)
  assert.equal(calls, 0)
  const refs = [
    { provider: 'vocadb', kind: 'album_project' as const, idType: 'native', value: '10' }
  ]
  assert.equal(metadataProviderReference('vocadb', 'album_project', refs)?.value, '10')
  assert.equal(metadataProviderReference('vocadb', 'release', refs), undefined)
  assert.equal(new PublicMusicSource('vocadb', () => p).supports('release'), false)
})

test('public HTTP exits are exact GET endpoints and preserve bounded response/redirect handling', async () => {
  const seen: string[] = [],
    http = new MetadataHttp(async (url, init) => {
      seen.push(String(url))
      assert.equal(init!.redirect, 'error')
      return json({})
    }, 0)
  for (const url of [
    'https://vocadb.net/api/artists?query=AC%2FDC',
    'https://www.theaudiodb.com/api/v1/json/123/artist-mb.php?i=' + MB,
    'https://api.discogs.com/artists/123'
  ])
    await http.fetch(url)
  for (const url of [
    'https://vocadb.net/login',
    'https://vocadb.net/api/users',
    'https://api.discogs.com/users/me',
    'https://www.theaudiodb.com/api/v1/json/123/artist.php#x',
    'http://vocadb.net/api/artists',
    'https://api.discogs.com/artists/123/images'
  ])
    await assert.rejects(http.fetch(url), /Unsupported/)
  await assert.rejects(
    http.fetch('https://api.discogs.com/artists/123', { method: 'POST', body: '{}' }),
    /Unsupported/
  )
  assert.equal(seen.length, 3)
})
