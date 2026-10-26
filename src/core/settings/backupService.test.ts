import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { ThemeLibraryRepository } from '../persistence/themeLibraryRepository.ts'
import { CoreSettingsService, type CoreSettingsServiceOptions } from './service.ts'
import { CoreSettingsBackupService } from './backupService.ts'
import { createDefaultThemeLibraryDocument, TWILIGHT_DEFAULT_THEME_ID } from '../../shared/theme.ts'
import {
  MAX_SETTINGS_BACKUP_BYTES,
  validCoreSettingsBackupPayload
} from '../../shared/coreSettingsBackup.ts'

const signal = () => new AbortController().signal
const tick = () => new Promise<void>((done) => setImmediate(done))
function fixture(t: test.TestContext, overrides: Partial<CoreSettingsServiceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-settings-backup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const events: unknown[] = []
  const repository = new CoreSettingsRepository({
    filePath: join(root, 'settings.json'),
    environment: { platform: 'win32', defaultCachePath: join(root, 'cache'), resolvePath: resolve },
    changed: (patch) => events.push(['commit', patch.language])
  })
  const settings = new CoreSettingsService({
    repository,
    authorizePaths: async (paths) => {
      events.push(['authorize', paths])
      return paths
    },
    configureLibrary: async (_previous, next) => {
      events.push(['library', next.libraryFolders])
    },
    serialize: (action) => action(),
    schedule: () => () => {},
    failed: (error) => {
      throw error
    },
    audio: {
      setAutoMixMode: async () => true,
      invalidateAutoMixSource: () => events.push('invalidate'),
      stop: async () => {}
    },
    importEffects: {
      prepare: async (next) => {
        events.push('prepare')
        return next
      },
      apply: async () => {
        events.push('apply')
        return {}
      },
      rollback: async () => {
        events.push('rollback')
      }
    },
    ...overrides
  })
  const themes = new ThemeLibraryRepository(
    join(root, 'themes.json'),
    createDefaultThemeLibraryDocument
  )
  const backup = new CoreSettingsBackupService({
    settings,
    normalize: (patch) => repository.normalize(patch),
    themes,
    validateThemeAssets: async () => false,
    pluginTheme: async () => null,
    themesChanged: (snapshot) => events.push(['themes', snapshot.revision])
  })
  return { root, events, repository, settings, themes, backup }
}

test('old flat backup imports through Core normalization and exports the existing v2 bundle', async (t) => {
  const f = fixture(t)
  const result = await f.backup.import(
    {
      revision: 0,
      json: JSON.stringify({
        language: 'en-US',
        proxyPort: 70000,
        libraryFolders: ['D:/Music'],
        cookie: 'not-a-settings-field',
        playMode: 'shuffle',
        softwareVolume: 0.25
      })
    },
    signal()
  )
  assert.equal(result.settings.language, 'en-US')
  assert.equal(result.settings.proxyPort, 65535)
  assert.equal(result.settings.playMode, 'shuffle')
  assert.equal(result.settings.softwareVolume, 0.25)
  assert.deepEqual(result.settings.libraryFolders, ['D:/Music'])
  assert.equal('cookie' in result.settings, false)
  assert.equal(f.events.filter((event) => event === 'apply').length, 1)
  const exported = JSON.parse(await f.backup.export())
  assert.equal(exported.schemaVersion, 2)
  assert.deepEqual(exported.settings, result.settings)
  assert.deepEqual(exported.themeLibrary, createDefaultThemeLibraryDocument())
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'settings.json'), 'utf8')), result.settings)
})

test('v2 theme profiles and history survive export/import; unavailable plugin selection falls back', async (t) => {
  const f = fixture(t)
  const themeLibrary = createDefaultThemeLibraryDocument()
  themeLibrary.activeTheme = { kind: 'plugin', pluginId: 'missing', themeId: 'dark' }
  themeLibrary.profiles.push({
    schemaVersion: 2,
    id: 'user:backup',
    name: 'Backup',
    description: '',
    baseThemeId: 'builtin:studio-split',
    source: { kind: 'builtin-preset', presetId: 'builtin:studio-split' },
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    overrides: { pureWhite: {}, dark: {} },
    modes: {}
  })
  themeLibrary.profileHistory['user:backup'] = [
    {
      savedAt: '2026-07-23T00:01:00.000Z',
      profile: { ...themeLibrary.profiles[0], name: 'Earlier Backup' }
    }
  ]
  const imported = await f.backup.import(
    {
      revision: 0,
      json: JSON.stringify({
        schemaVersion: 2,
        settings: { theme: 'dark', pluginThemeId: 'missing:dark' },
        themeLibrary
      })
    },
    signal()
  )
  assert.deepEqual(imported.settings.activeTheme, {
    kind: 'builtin',
    id: TWILIGHT_DEFAULT_THEME_ID
  })
  assert.equal(imported.settings.pluginThemeId, null)
  const exported = JSON.parse(await f.backup.export())
  assert.equal(
    exported.themeLibrary.profileHistory['user:backup'][0].profile.name,
    'Earlier Backup'
  )
  assert.deepEqual(exported.themeLibrary.activeTheme, imported.settings.activeTheme)
  assert.deepEqual(f.events.at(-1), ['themes', 1])
})

test('path rejection, malformed JSON and stale requests never apply settings or themes', async (t) => {
  const f = fixture(t, {
    authorizePaths: async () => {
      throw new Error('path denied')
    }
  })
  await assert.rejects(f.backup.import({ revision: 0, json: '{bad' }, signal()), /Invalid settings/)
  await assert.rejects(f.backup.import({ revision: 0, json: '{}' }, signal()), /path denied/)
  await assert.rejects(f.backup.import({ revision: 1, json: '{}' }, signal()), {
    code: 'STALE_REVISION'
  })
  assert.equal(f.settings.getRevision(), 0)
  assert.equal((await f.themes.load()).revision, 0)
  assert.deepEqual(f.events, [])
})

test('authorization rechecks the revision before effects and a lost committed reply cannot replay', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const f = fixture(t, {
    authorizePaths: async (paths) => {
      await gate
      return paths
    }
  })
  const request = { revision: 0, json: '{"language":"en-US"}' }
  const first = f.backup.import(request, signal())
  await tick()
  f.repository.update({ audioDevice: 'new-dac' })
  release()
  await assert.rejects(first, { code: 'STALE_REVISION' })
  assert.equal(f.events.includes('apply'), false)
  const accepted = { ...request, revision: 1 }
  await f.backup.import(accepted, signal()) // caller discards this reply
  await assert.rejects(f.backup.import(accepted, signal()), { code: 'STALE_REVISION' })
  assert.equal(f.events.filter((event) => event === 'apply').length, 1)
})

test('accepted import finishes after client detach; shutdown joins its real completion', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const f = fixture(t, {
    importEffects: {
      prepare: async (next) => next,
      apply: async () => {
        await gate
        return { audioDevice: 'actual-dac' }
      },
      rollback: async () => {}
    }
  })
  const controller = new AbortController()
  const result = f.backup.import({ revision: 0, json: '{"language":"en-US"}' }, controller.signal)
  await tick()
  controller.abort(new Error('window destroyed'))
  let joined = false
  const shutdown = f.backup.shutdown().then(() => {
    joined = true
  })
  await tick()
  assert.equal(joined, false)
  release()
  assert.equal((await result).settings.audioDevice, 'actual-dac')
  await shutdown
  assert.equal(f.settings.state().settings.language, 'en-US')
})

test('effect failure rolls transient preferences back without publishing the import', async (t) => {
  let rolledBack = 0
  const f = fixture(t, {
    importEffects: {
      prepare: async (next) => next,
      apply: async () => {
        throw new Error('native refused')
      },
      rollback: async () => {
        rolledBack++
      }
    }
  })
  await assert.rejects(
    f.backup.import({ revision: 0, json: '{"language":"en-US"}' }, signal()),
    /native refused/
  )
  assert.equal(rolledBack, 1)
  assert.equal(f.settings.getRevision(), 0)
})

test('backup contract retains its UTF-8 size bound and has no arbitrary file path', () => {
  assert.equal(validCoreSettingsBackupPayload('settings.backup', {}), true)
  assert.equal(
    validCoreSettingsBackupPayload('settings.restore', { revision: 0, json: '{}' }),
    true
  )
  assert.equal(
    validCoreSettingsBackupPayload('settings.restore', { revision: 0, json: '{}', path: 'secret' }),
    false
  )
  assert.equal(
    validCoreSettingsBackupPayload('settings.restore', {
      revision: 0,
      json: '中'.repeat(Math.ceil(MAX_SETTINGS_BACKUP_BYTES / 3))
    }),
    false
  )
})
