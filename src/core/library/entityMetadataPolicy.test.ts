import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataPolicy
} from '../../shared/entityMetadata.ts'
import type { MetadataUsage } from '../../shared/musicMetadata.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider, MusicBrainzDetailsProvider } from './entityMetadataProvider.ts'
import {
  MusicBrainzIdentificationProvider,
  PlatformIdentificationProvider
} from './musicIdentificationProvider.ts'
import { PlatformMetadataProvider } from './platformMetadataProvider.ts'
import { PublicArtworkProvider } from './publicArtworkProvider.ts'

test('policy exposes registered identification and detail capabilities independently, without network calls or account contexts', () => {
  const policy: EntityMetadataPolicy = {
    enabled: true,
    publicServiceApproved: false,
    contact: '',
    wikipediaText: false
  }
  let enabled = true
  const usage: MetadataUsage | null = null
  const inventory = () => [
    {
      id: 'test',
      enabled,
      supportedMethods: ['searchArtists', 'fetchArtistMetadata'],
      configuration: 'private-account-epoch'
    }
  ]
  const service = new CoreEntityMetadataService({
    database: {} as EntityMetadataDatabaseApi,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    now: () => 1000,
    changed() {},
    failed() {},
    identificationProviders: () => [
      new MusicBrainzIdentificationProvider(() => policy),
      new PlatformIdentificationProvider('test', {
        inventory,
        search: async () => {
          assert.fail('read policy must not search')
        }
      })
    ],
    enrichmentProviders: () => [
      new MusicBrainzDetailsProvider(() => policy),
      new PlatformMetadataProvider('test', {
        inventory,
        usage: () => usage,
        now: () => 1000,
        call: async () => {
          assert.fail('read policy must not fetch')
        }
      })
    ]
  })
  let sources = service.policy().sources!
  assert.ok(
    sources
      .find((s) => s.provider === 'musicbrainz')!
      .identification.every((c) => c.reason === 'public_service_not_approved')
  )
  const platform = sources.find((s) => s.provider === 'platform.test')!
  assert.deepEqual(platform.identification, [{ kind: 'artist', reason: null }])
  assert.deepEqual(platform.enrichment, [
    { provider: 'platform.test', kind: 'artist', reason: 'platform_metadata_cache_not_approved' }
  ])
  assert.doesNotMatch(JSON.stringify(sources), /private-account-epoch|contact|configuration/)
  enabled = false
  sources = service.policy().sources!
  assert.equal(
    sources.find((s) => s.provider === 'platform.test')!.identification[0].reason,
    'provider_disabled'
  )
  policy.enabled = false
  assert.ok(
    service
      .policy()
      .sources!.every((s) =>
        [...s.identification, ...s.enrichment].every((c) => c.reason === 'metadata_disabled')
      )
  )
})

test('MusicBrainz selection groups structured detail and public artwork while retaining their separate permissions', () => {
  const policy = {
    enabled: true,
    publicServiceApproved: true,
    contact: 'https://example.invalid/contact',
    wikipediaText: false,
    commonsImages: false,
    caaUsage: null
  }
  const service = new CoreEntityMetadataService({
    database: {} as EntityMetadataDatabaseApi,
    provider: new MusicBrainzWikiProvider(() => policy),
    policy: () => policy,
    now: () => 1000,
    changed() {},
    failed() {},
    identificationProviders: () => [new MusicBrainzIdentificationProvider(() => policy)],
    enrichmentProviders: () => [
      new MusicBrainzDetailsProvider(() => policy),
      new PublicArtworkProvider(() => policy)
    ]
  })
  const view = service.policy()
  assert.equal(view.introduction, false)
  assert.equal(view.sources!.length, 1)
  const source = view.sources![0]
  assert.equal(source.provider, 'musicbrainz')
  assert.equal(source.identification.length, 4)
  assert.ok(
    source.enrichment
      .filter((c) => c.provider === 'musicbrainz-details')
      .every((c) => c.reason === null)
  )
  assert.deepEqual(
    source.enrichment.filter((c) => c.provider === 'public-artwork').map((c) => [c.kind, c.reason]),
    [
      ['artist', 'commons_images_not_permitted'],
      ['album_project', 'caa_artwork_cache_not_approved'],
      ['release', 'caa_artwork_cache_not_approved']
    ]
  )
})
