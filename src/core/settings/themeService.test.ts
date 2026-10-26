import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ThemeLibraryRepository } from '../persistence/themeLibraryRepository.ts'
import { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { CoreSettingsService } from './service.ts'
import { CoreThemeService, type CoreThemePlatform } from './themeService.ts'
import {
  createDefaultThemeLibraryDocument,
  TWILIGHT_DEFAULT_THEME_ID,
  type ThemeLibrarySnapshot,
  type ThemeProfileV2
} from '../../shared/theme.ts'
import { validCoreThemePayload } from '../../shared/coreThemes.ts'

const signal = () => new AbortController().signal
const profile: ThemeProfileV2 = {
  schemaVersion: 2,
  id: 'user:test',
  name: 'Saved',
  description: '',
  baseThemeId: 'builtin:studio-split',
  source: { kind: 'builtin-preset', presetId: 'builtin:studio-split' },
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
  overrides: { pureWhite: {}, dark: {} },
  modes: {}
}
function fixture(t: test.TestContext, overrides: Partial<CoreThemePlatform> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-themes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const settings = new CoreSettingsRepository({
    filePath: join(root, 'settings.json'),
    environment: { platform: 'win32', defaultCachePath: join(root, 'cache'), resolvePath: resolve },
    changed: () => {}
  })
  const settingsService = new CoreSettingsService({
    repository: settings,
    authorizePaths: async (paths) => paths,
    serialize: (action) => action(),
    configureLibrary: async () => {},
    schedule: () => () => {},
    failed: (error) => {
      throw error
    },
    audio: { setAutoMixMode: async () => true, invalidateAutoMixSource() {}, stop: async () => {} }
  })
  const repository = new ThemeLibraryRepository(
    join(root, 'themes.json'),
    createDefaultThemeLibraryDocument
  )
  const changed: ThemeLibrarySnapshot[] = [],
    removed: string[] = []
  const platform: CoreThemePlatform = {
    validateAssets: async () => true,
    deleteAssets: async (id) => {
      removed.push(id)
    },
    importArchive: async () => structuredClone(profile),
    exportArchive: async () => 'chosen.tetheme',
    importAsset: async () => null,
    copyAssets: async () => {},
    ...overrides
  }
  const service = new CoreThemeService({
    repository,
    settings: () => settings.read(),
    updateSettings: (patch) => settingsService.editOwned(patch),
    platform,
    pluginTheme: async () => null,
    changed: (snapshot) => changed.push(snapshot),
    now: () => '2026-10-23T00:00:00.000Z'
  })
  return { service, settings, repository, changed, removed }
}

test('theme Core owner preserves profile history and stale-window revision results', async (t) => {
  const f = fixture(t)
  const result = await f.service.edit({ kind: 'save', revision: 0, profile }, signal())
  assert.ok('data' in result)
  const outcomes = await Promise.all([
    f.service.edit({ kind: 'save', revision: 1, profile: { ...profile, name: 'First' } }, signal()),
    f.service.edit({ kind: 'save', revision: 1, profile: { ...profile, name: 'Second' } }, signal())
  ])
  assert.ok('data' in outcomes[0])
  assert.equal('code' in outcomes[1] && outcomes[1].code, 'ERR_PERSISTENCE_REVISION_CONFLICT')
  const state = await f.service.list()
  assert.equal(state.data.profiles[0].name, 'First')
  assert.equal(state.data.profileHistory[profile.id][0].profile.name, 'Saved')
  assert.equal(f.changed.length, 2)
})

test('activation, inheritance, removal and plugin fallback update the single settings writer', async (t) => {
  const f = fixture(t)
  await f.service.edit({ kind: 'save', revision: 0, profile }, signal())
  await f.service.edit(
    { kind: 'active', revision: 1, selection: { kind: 'user', id: profile.id } },
    signal()
  )
  assert.deepEqual(f.settings.read().activeTheme, { kind: 'user', id: profile.id })
  await f.service.edit(
    { kind: 'inheritance', revision: 2, inheritance: { miniPlayer: false, desktopLyrics: true } },
    signal()
  )
  assert.deepEqual(f.settings.read().themeWindowInheritance, {
    miniPlayer: false,
    desktopLyrics: true
  })
  await f.service.edit({ kind: 'remove', revision: 3, id: profile.id }, signal())
  assert.deepEqual(f.removed, [profile.id])
  assert.deepEqual(f.settings.read().activeTheme, {
    kind: 'builtin',
    id: TWILIGHT_DEFAULT_THEME_ID
  })
  await f.service.edit(
    {
      kind: 'active',
      revision: 4,
      selection: { kind: 'plugin', pluginId: 'gone', themeId: 'one' }
    },
    signal()
  )
  await f.service.reconcile()
  assert.equal(f.settings.read().pluginThemeId, null)
  assert.equal((await f.service.bootstrap()).library.revision, 6)
})

test('theme archive import cleans rejected assets; a committed reply is not replayed', async (t) => {
  const f = fixture(t)
  const imported = await f.service.import(0, signal())
  assert.ok(imported && 'data' in imported)
  const stale = await f.service.import(0, signal())
  assert.equal(stale && 'code' in stale && stale.code, 'ERR_PERSISTENCE_REVISION_CONFLICT')
  assert.deepEqual(f.removed, [profile.id])
  assert.equal((await f.service.list()).revision, 1)
  assert.equal(await f.service.export(profile.id, signal()), 'chosen.tetheme')
})

test('invalid resource bindings cannot publish a theme; backup replacement joins the same lane', async (t) => {
  const f = fixture(t, { validateAssets: async () => false })
  await assert.rejects(
    f.service.edit(
      {
        kind: 'save',
        revision: 0,
        profile: {
          ...profile,
          assets: [{ id: 'cover', type: 'image', path: 'cover.png' }],
          assetBindings: { appBackground: 'cover' }
        }
      },
      signal()
    ),
    /本地资源不可用/
  )
  assert.equal((await f.service.list()).revision, 0)
  const document = createDefaultThemeLibraryDocument()
  document.profiles = [profile]
  await f.service.replaceDocument(document, 0)
  assert.equal((await f.service.load()).data.profiles[0].id, profile.id)
  await assert.rejects(f.service.replaceDocument(document, 0), {
    code: 'ERR_PERSISTENCE_REVISION_CONFLICT'
  })
})

test('theme finite contract rejects arbitrary paths and malformed selection', () => {
  assert.equal(validCoreThemePayload('themes.import', { revision: 0, path: 'private' }), false)
  assert.equal(
    validCoreThemePayload('themes.edit', { revision: 0, kind: 'active', selection: {} }),
    false
  )
  assert.equal(
    validCoreThemePayload('themes.edit', {
      revision: 0,
      kind: 'active',
      selection: { kind: 'user', id: profile.id }
    }),
    true
  )
})
