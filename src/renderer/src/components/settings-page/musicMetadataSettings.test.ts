import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreSettingsRepository } from '../../../../core/persistence/settingsRepository.ts'
import type { EntityMetadataPolicyView } from '../../../../shared/entityMetadata.ts'
import {
  defaultMusicIdentificationSettings,
  type MusicIdentificationSettings
} from '../../../../shared/musicIdentificationSchedule.ts'
import { createMusicMetadataSettings, metadataSourceOptions } from './musicMetadataSettings.ts'
import { SETTINGS_SEARCH_INDEX, settingsDisclosurePath } from './types.ts'

const policy = (): EntityMetadataPolicyView => ({
  enabled: true,
  identity: false,
  introduction: false,
  reason: 'public_service_not_approved',
  sources: [
    {
      provider: 'musicbrainz',
      identification: [{ kind: 'artist', reason: 'public_service_not_approved' }],
      enrichment: [
        { provider: 'musicbrainz-details', kind: 'artist', reason: 'public_service_not_approved' }
      ]
    },
    {
      provider: 'platform.ncm',
      identification: [
        { kind: 'artist', reason: null },
        { kind: 'release', reason: null }
      ],
      enrichment: [
        { provider: 'platform.ncm', kind: 'artist', reason: 'platform_metadata_cache_not_approved' }
      ]
    },
    {
      provider: 'platform.disabled',
      identification: [{ kind: 'artist', reason: 'provider_disabled' }],
      enrichment: []
    }
  ]
})
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('settings controls persist separate scopes, actual sources and optional language in the original file and reload them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-settings-'))
  t.after(() => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })
  const options = {
    filePath: join(root, 'settings.json'),
    environment: {
      platform: 'win32' as const,
      resolvePath: resolve,
      defaultCachePath: join(root, 'cache')
    },
    changed() {}
  }
  const repository = new CoreSettingsRepository(options)
  const model = createMusicMetadataSettings({
    current: () => repository.read().musicIdentification,
    save: async (musicIdentification) => repository.update({ musicIdentification }),
    policy: async () => policy()
  })
  t.after(model.dispose)
  assert.deepEqual(repository.read().musicIdentification, defaultMusicIdentificationSettings())
  await model.refresh()
  await model.scope('newImports')
  await model.scope('history')
  await model.source('musicbrainz', false)
  await model.source('platform.ncm', true)
  await model.language('zh-Hant')
  assert.deepEqual(new CoreSettingsRepository(options).read().musicIdentification, {
    newImports: true,
    history: true,
    sources: ['platform.ncm'],
    language: 'zh-Hant'
  })
  await model.language(undefined)
  await model.scope('history')
  assert.deepEqual(new CoreSettingsRepository(options).read().musicIdentification, {
    newImports: true,
    history: false,
    sources: ['platform.ncm']
  })
  assert.equal(model.state.value.notice, '已保存')
})

test('available identification does not promise text permission and public MB restrictions do not disable a platform', () => {
  const options = metadataSourceOptions(policy(), ['musicbrainz', 'platform.removed'])
  assert.equal(options.find((s) => s.provider === 'musicbrainz')!.available, false)
  const ncm = options.find((s) => s.provider === 'platform.ncm')!
  assert.equal(ncm.available, true)
  assert.ok(ncm.descriptions.some((s) => s.includes('识别可用：艺人、具体发行')))
  assert.ok(ncm.descriptions.some((s) => s.includes('缓存权限尚未获批')))
  assert.equal(options.find((s) => s.provider === 'platform.removed')!.available, false)
})

test('unavailable and removed sources remain selected until explicitly unchecked; unavailable sources cannot be newly enabled', async (t) => {
  let settings: MusicIdentificationSettings = {
    newImports: false,
    history: false,
    sources: ['musicbrainz', 'platform.removed']
  }
  const writes: MusicIdentificationSettings[] = []
  const model = createMusicMetadataSettings({
    current: () => settings,
    save: async (next) => {
      writes.push(next)
      settings = next
    },
    policy: async () => policy()
  })
  t.after(model.dispose)
  await model.refresh()
  assert.deepEqual(settings.sources, ['musicbrainz', 'platform.removed'])
  await model.source('platform.disabled', true)
  await model.source('platform.unknown', true)
  assert.equal(writes.length, 0)
  await model.source('platform.removed', false)
  await model.source('musicbrainz', false)
  assert.deepEqual(settings.sources, [])
  await model.source('platform.ncm', true)
  assert.deepEqual(settings.sources, ['platform.ncm'])
})

test('a pending save cannot issue competing nested updates; failure leaves confirmed switches unchanged and visible', async (t) => {
  const pending = deferred<unknown>()
  const settings = defaultMusicIdentificationSettings()
  const writes: MusicIdentificationSettings[] = []
  const model = createMusicMetadataSettings({
    current: () => settings,
    save: async (next) => {
      writes.push(next)
      await pending.promise
      throw new Error('disk full')
    },
    policy: async () => policy()
  })
  t.after(model.dispose)
  const saving = model.scope('newImports')
  assert.equal(model.state.value.saving, true)
  await model.language('en')
  await model.scope('history')
  assert.equal(writes.length, 1)
  assert.equal(settings.newImports, false, 'no optimistic mutation')
  pending.resolve(null)
  await saving
  assert.equal(model.state.value.saving, false)
  assert.match(model.state.value.error, /disk full/)
  assert.equal(settings.history, false)
})

test('source selection is bounded, deduplicated and retains other saved fields', async (t) => {
  let settings: MusicIdentificationSettings = {
    newImports: true,
    history: false,
    language: 'en',
    sources: Array.from({ length: 16 }, (_, i) => `platform.source${i}`)
  }
  const model = createMusicMetadataSettings({
    current: () => settings,
    save: async (next) => {
      settings = next
    },
    policy: async () => policy()
  })
  t.after(model.dispose)
  await model.refresh()
  await model.source('platform.ncm', true)
  assert.match(model.state.value.error, /16/)
  assert.equal(settings.sources.length, 16)
  await model.source('platform.source0', false)
  await model.source('platform.ncm', true)
  await model.source('platform.ncm', true)
  assert.equal(settings.sources.length, 16)
  assert.equal(settings.language, 'en')
  assert.equal(settings.newImports, true)
})

test('capability invalidation cancels stale reads; late responses and disposal cannot restore old permission', async (t) => {
  const pending = deferred<EntityMetadataPolicyView>(),
    third = deferred<EntityMetadataPolicyView>()
  let calls = 0
  const signals: AbortSignal[] = []
  const model = createMusicMetadataSettings({
    current: defaultMusicIdentificationSettings,
    save: async () => {
      assert.fail('a stale capability cannot enable a source')
    },
    policy: async (signal) => {
      signals.push(signal)
      return ++calls === 1
        ? pending.promise
        : calls === 2
          ? { ...policy(), enabled: false }
          : third.promise
    }
  })
  t.after(model.dispose)
  const first = model.refresh()
  await model.refresh()
  pending.resolve(policy())
  await first
  assert.equal(signals[0].aborted, true)
  assert.equal(model.state.value.policy!.enabled, false)
  const previous = model.state.value.policy
  const thirdRead = model.refresh()
  assert.equal(model.state.value.policy, previous, 'keep the inventory stable while rechecking')
  await model.source('platform.ncm', true)
  model.dispose()
  third.resolve(policy())
  await thirdRead
  assert.equal(
    model.state.value.policy,
    previous,
    'a late response after disposal cannot restore permission'
  )
  await model.refresh()
  assert.equal(signals[2].aborted, true)
  assert.equal(calls, 3)
})

test('policy failures remain visible without changing saved configuration or enabling unavailable sources', async (t) => {
  const settings = defaultMusicIdentificationSettings()
  const model = createMusicMetadataSettings({
    current: () => settings,
    save: async () => {
      assert.fail('must not save')
    },
    policy: async () => {
      throw new Error('not attached')
    }
  })
  t.after(model.dispose)
  await model.refresh()
  assert.match(model.state.value.policyError, /not attached/)
  assert.equal(model.state.value.loading, false)
  await model.source('musicbrainz', true)
  assert.deepEqual(settings, defaultMusicIdentificationSettings())
})

test('all controls are discoverable in the original library settings group and use the existing writer/command entry points', () => {
  for (const id of [
    'metadata-new-imports',
    'metadata-history',
    'metadata-language',
    'metadata-sources'
  ]) {
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id)!
    assert.equal(entry.section, 'library')
    assert.deepEqual(settingsDisclosurePath(entry), ['music-metadata'])
  }
  const settings = readFileSync(new URL('./MusicMetadataSettings.vue', import.meta.url), 'utf8')
  assert.match(settings, /updateSettings\(\{ musicIdentification \}\)/)
  assert.match(settings, /core\.query\('metadata.entity.policy'/)
  assert.doesNotMatch(settings, /metadata\.entity\.(?:enrich|resolve)|fetch\(/)
  const editor = readFileSync(
    new URL('../music-metadata/IntroductionEditor.vue', import.meta.url),
    'utf8'
  )
  assert.match(editor, /core\.command\('metadata.entity.override', request\)/)
  assert.match(editor, /maxlength="20000"/)
})
