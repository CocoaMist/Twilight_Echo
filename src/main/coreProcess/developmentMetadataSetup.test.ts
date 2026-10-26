import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreSettingsRepository } from '../../core/persistence/settingsRepository.ts'
import { applyDevelopmentMetadataSetup } from './developmentMetadataSetup.ts'

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'development-metadata-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'profile')
  mkdirSync(root)
  const filePath = join(root, 'settings.json')
  const options = {
    filePath,
    environment: {
      platform: process.platform,
      defaultCachePath: join(root, 'cache'),
      resolvePath: resolve
    },
    changed: () => {}
  }
  const settings = new CoreSettingsRepository(options)
  const requestFile = join(directory, 'metadata-setup.json')
  const request = {
    version: 1,
    profileRoot: root,
    newImports: true,
    history: false,
    sources: ['musicbrainz']
  }
  const writeRequest = (value: unknown = request) =>
    writeFileSync(requestFile, JSON.stringify(value))
  return { directory, root, filePath, options, settings, requestFile, request, writeRequest }
}

test('development setup changes only identification preferences, consumes the request, and does not re-enable later', (t) => {
  const f = fixture(t)
  f.settings.update({
    language: 'zh-CN',
    audioDevice: 'saved-device',
    remoteControlEnabled: true,
    musicIdentification: {
      newImports: false,
      history: true,
      sources: ['platform.test'],
      language: 'zh-Hant'
    }
  })
  const before = f.settings.read()
  f.writeRequest()

  assert.deepEqual(applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings), {
    status: 'applied'
  })
  const expected = {
    ...before,
    musicIdentification: {
      ...before.musicIdentification,
      newImports: true,
      history: false,
      sources: ['musicbrainz']
    }
  }
  assert.deepEqual(f.settings.read(), expected)
  assert.deepEqual(new CoreSettingsRepository(f.options).read(), expected)
  assert.equal(existsSync(f.requestFile), false)
  assert.equal(existsSync(`${f.requestFile}.applied`), true)

  f.settings.update({ musicIdentification: { ...expected.musicIdentification, newImports: false } })
  const restarted = new CoreSettingsRepository(f.options)
  assert.deepEqual(applyDevelopmentMetadataSetup(f.requestFile, f.root, restarted), {
    status: 'missing'
  })
  assert.equal(restarted.read().musicIdentification.newImports, false)
})

test('missing or unconfigured requests leave the repository untouched', (t) => {
  const f = fixture(t)
  const before = f.settings.read()
  assert.deepEqual(applyDevelopmentMetadataSetup(undefined, f.root, f.settings), {
    status: 'not-requested'
  })
  assert.deepEqual(applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings), {
    status: 'missing'
  })
  assert.deepEqual(f.settings.read(), before)
  assert.equal(existsSync(f.filePath), false)
})

test('a request for another profile is preserved without writing settings', (t) => {
  const f = fixture(t)
  f.writeRequest({ ...f.request, profileRoot: join(f.directory, 'another-profile') })
  assert.deepEqual(applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings), {
    status: 'profile-mismatch'
  })
  assert.equal(f.settings.getRevision(), 0)
  assert.equal(existsSync(f.filePath), false)
  assert.equal(existsSync(f.requestFile), true)
})

test('profile matching normalizes paths and Windows path casing', (t) => {
  const f = fixture(t)
  const normalized = join(f.root, '..', 'profile')
  f.writeRequest({
    ...f.request,
    profileRoot: process.platform === 'win32' ? normalized.toUpperCase() : normalized
  })
  assert.deepEqual(applyDevelopmentMetadataSetup(f.requestFile, `${f.root}/`, f.settings), {
    status: 'applied'
  })
})

test('invalid JSON and every schema deviation preserve the request and settings', (t) => {
  const f = fixture(t)
  const invalid: unknown[] = [
    null,
    [],
    { ...f.request, version: 2 },
    { ...f.request, profileRoot: 'relative-profile' },
    { ...f.request, newImports: false },
    { ...f.request, history: true },
    { ...f.request, sources: ['platform.test'] },
    { ...f.request, sources: ['musicbrainz', 'musicbrainz'] },
    { ...f.request, additional: true },
    { version: 1, profileRoot: f.root, newImports: true, history: false }
  ]
  for (const value of invalid) {
    f.writeRequest(value)
    assert.equal(
      applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings).status,
      'invalid-request'
    )
    assert.equal(f.settings.getRevision(), 0)
    assert.equal(existsSync(f.requestFile), true)
  }
  writeFileSync(f.requestFile, '{invalid')
  assert.equal(
    applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings).status,
    'invalid-request'
  )
  assert.equal(readFileSync(f.requestFile, 'utf8'), '{invalid')
  assert.equal(existsSync(f.filePath), false)
})

test('corrupt or recovered settings defer setup without consuming the request', (t) => {
  for (const recovered of [false, true]) {
    const f = fixture(t)
    if (recovered) f.settings.update({ audioDevice: 'saved-device' })
    writeFileSync(f.filePath, '{corrupt')
    const settings = new CoreSettingsRepository(f.options)
    assert.equal(settings.issue?.kind, recovered ? 'recovered' : 'corrupt')
    const before = settings.read()
    f.writeRequest()
    assert.deepEqual(applyDevelopmentMetadataSetup(f.requestFile, f.root, settings), {
      status: 'settings-issue'
    })
    assert.deepEqual(settings.read(), before)
    assert.equal(settings.getRevision(), 0)
    assert.equal(existsSync(f.requestFile), true)
  }
})

test('failed settings publication reports the save failure and retains the request', (t) => {
  const f = fixture(t)
  f.settings.update({ audioDevice: 'saved-device' })
  const before = f.settings.read()
  const revision = f.settings.getRevision()
  renameSync(f.filePath, join(f.directory, 'saved-settings.json'))
  mkdirSync(f.filePath)
  writeFileSync(join(f.filePath, 'obstruction'), 'not a settings file')
  f.writeRequest()

  const result = applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings)
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.stage, 'save')
  assert.equal(result.settingsApplied, false)
  assert.ok(result.message)
  assert.deepEqual(f.settings.read(), before)
  assert.equal(f.settings.getRevision(), revision)
  assert.equal(existsSync(f.requestFile), true)
  assert.equal(existsSync(`${f.requestFile}.applied`), false)
})

test('failed consumption reports that settings were saved but the request remains pending', (t) => {
  const f = fixture(t)
  f.writeRequest()
  mkdirSync(`${f.requestFile}.applied`)
  writeFileSync(join(`${f.requestFile}.applied`, 'obstruction'), 'not an applied marker file')

  const result = applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings)
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.stage, 'consume')
  assert.equal(result.settingsApplied, true)
  assert.ok(result.message)
  assert.equal(f.settings.read().musicIdentification.newImports, true)
  assert.equal(new CoreSettingsRepository(f.options).read().musicIdentification.newImports, true)
  assert.equal(existsSync(f.requestFile), true)
})

test('unreadable request errors are reported without updating settings', (t) => {
  const f = fixture(t)
  mkdirSync(f.requestFile)
  const result = applyDevelopmentMetadataSetup(f.requestFile, f.root, f.settings)
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.stage, 'read')
  assert.equal(result.settingsApplied, false)
  assert.equal(f.settings.getRevision(), 0)
})
