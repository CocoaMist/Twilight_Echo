import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { CoreSettingsService, type CoreSettingsServiceOptions } from './service.ts'
import type { CoreSettingsPatch } from '../../shared/coreSettings.ts'

const tick = () => new Promise<void>((done) => setImmediate(done))
const signal = () => new AbortController().signal
function fixture(t: test.TestContext, overrides: Partial<CoreSettingsServiceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-preferences-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const events: unknown[] = []
  const repository = new CoreSettingsRepository({
    filePath: join(root, 'settings.json'),
    environment: { platform: 'win32', defaultCachePath: join(root, 'cache'), resolvePath: resolve },
    changed: () => events.push('committed')
  })
  const service = new CoreSettingsService({
    repository,
    authorizePaths: async (paths) => {
      events.push(paths)
      return paths
    },
    configureLibrary: async (previous, next) => {
      events.push({
        previous: previous?.libraryFolders ?? null,
        folders: next.libraryFolders,
        watch: next.watchLibrary
      })
    },
    serialize: (action) => action(),
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      return () => clearTimeout(timer)
    },
    failed: (error) => {
      throw error
    },
    audio: {
      setAutoMixMode: async (mode) => {
        events.push(mode)
        return true
      },
      invalidateAutoMixSource: () => events.push('invalidate'),
      stop: async () => {
        events.push('stop')
      }
    },
    ...overrides
  })
  const edit = (patch: CoreSettingsPatch, revision = service.getRevision()) =>
    service.edit({ revision, patch }, signal())
  return { root, repository, service, edit, events }
}

test('preferences keep normalization, aliases and atomic full-file persistence under one revision', async (t) => {
  const f = fixture(t)
  await f.edit({
    autoLaunch: true,
    musicCachePath: join(f.root, 'new-cache'),
    closeToTray: true,
    ncmPlaybackQuality: 'hires'
  })
  const state = f.service.state()
  assert.equal(state.revision, 1)
  assert.equal(state.settings.launchAtLogin, true)
  assert.equal(state.settings.closeWindowBehavior, 'tray')
  assert.equal(state.settings.cachePath, join(f.root, 'new-cache'))
  assert.equal(state.settings.musicCachePath, state.settings.cachePath)
  assert.equal(state.settings.ncmPlaybackQuality, 'hires')
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'settings.json'), 'utf8')), state.settings)
  state.settings.libraryFolders.push('not-authority')
  assert.deepEqual(f.service.state().settings.libraryFolders, [])
  assert.equal(f.events.filter((event) => event === 'committed').length, 1)
})

test('startup and folder/watch edits configure Core even with no attached clients', async (t) => {
  const f = fixture(t)
  await f.service.initialize()
  await f.edit({ libraryFolders: ['D:/Music'], watchLibrary: false })
  await f.edit({ watchLibrary: true })
  assert.deepEqual(f.events, [
    { previous: null, folders: [], watch: true },
    { libraryFolders: ['D:/Music'] },
    'committed',
    { previous: [], folders: ['D:/Music'], watch: false },
    'committed',
    { previous: ['D:/Music'], folders: ['D:/Music'], watch: true }
  ])
})

test('concurrent clients, existing audio commits and delayed path grants cannot overwrite a newer revision', async (t) => {
  let finish!: () => void
  const held = new Promise<void>((done) => {
    finish = done
  })
  const f = fixture(t, {
    authorizePaths: async (paths) => {
      await held
      return paths
    }
  })
  const old = f.edit({ downloadFolder: 'D:/Downloads' })
  await tick()
  f.repository.update({ audioDevice: 'new-dac' })
  finish()
  await assert.rejects(old, { code: 'STALE_REVISION' })
  assert.equal(f.service.state().settings.downloadFolder, '')
  assert.equal(f.service.state().settings.audioDevice, 'new-dac')
  const revision = f.service.getRevision()
  const results = await Promise.allSettled([
    f.edit({ language: 'en-US' }, revision),
    f.edit({ theme: 'dark' }, revision)
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(f.service.getRevision(), revision + 1)
})

test('cancelled/unauthorized folder edits never publish and flush joins the active authorization', async (t) => {
  let finish!: () => void
  const held = new Promise<void>((done) => {
    finish = done
  })
  const f = fixture(t, {
    authorizePaths: async (paths) => {
      await held
      return paths
    }
  })
  const controller = new AbortController()
  const edited = f.service.edit(
    { revision: 0, patch: { libraryFolders: ['D:/private'] } },
    controller.signal
  )
  await tick()
  controller.abort(new Error('closed window'))
  let flushed = false
  const flush = f.service.flush().then(() => {
    flushed = true
  })
  await tick()
  assert.equal(flushed, false)
  finish()
  await assert.rejects(edited, /closed window/)
  await flush
  assert.equal(f.service.getRevision(), 0)
  const denied = fixture(t, {
    authorizePaths: async () => {
      throw new Error('not granted')
    }
  })
  await assert.rejects(denied.edit({ downloadFolder: 'D:/private' }), /not granted/)
  assert.equal(denied.service.getRevision(), 0)
})

test('output and DSP settings cannot bypass their transaction commands', async (t) => {
  const f = fixture(t)
  for (const patch of [
    { audioDevice: 'bad' },
    { audioProcessing: {} },
    { playMode: 'shuffle' },
    { cookie: 'secret' }
  ])
    await assert.rejects(f.edit(patch as CoreSettingsPatch), /domain command/)
  assert.equal(f.service.getRevision(), 0)
})

test('stem preference publication precedes invalidation; AutoMix waits for its native ACK', async (t) => {
  const f = fixture(t)
  await f.edit({ autoMixStemMode: 'auto', autoMixStemDevice: 'cpu' })
  assert.deepEqual(f.events, ['committed', 'invalidate'])
  await f.edit({ autoMixMode: 'natural' })
  assert.deepEqual(f.events.slice(2), ['natural', 'committed'])
  const refused = fixture(t, {
    audio: { setAutoMixMode: async () => false, invalidateAutoMixSource() {}, stop: async () => {} }
  })
  await assert.rejects(refused.edit({ autoMixMode: 'natural' }), /AutoMix/)
  assert.equal(refused.service.getRevision(), 0)
})

test('failed settings publication rolls AutoMix back without publishing a new revision', async (t) => {
  const f = fixture(t)
  await f.edit({ language: 'en-US' })
  const file = join(f.root, 'settings.json')
  renameSync(file, join(f.root, 'saved.json'))
  mkdirSync(file)
  writeFileSync(join(file, 'obstruction'), 'not a settings file')
  await assert.rejects(f.edit({ autoMixMode: 'natural' }))
  assert.equal(f.service.state().settings.autoMixMode, 'off')
  assert.equal(f.service.getRevision(), 1)
  assert.deepEqual(f.events, ['committed', 'natural', 'off'])
})

test('native volume persistence coalesces, uses the applied ceiling and flushes before exit', async (t) => {
  const timers = new Set<() => void>()
  const f = fixture(t, {
    schedule: (callback, milliseconds) => {
      assert.equal(milliseconds, 350)
      timers.add(callback)
      return () => {
        timers.delete(callback)
      }
    }
  })
  f.service.rememberVolume(0.2228)
  f.service.rememberVolume(0.3)
  assert.equal(timers.size, 1)
  assert.equal(f.service.getRevision(), 0)
  await f.service.flush()
  assert.equal(timers.size, 0)
  assert.equal(f.service.state().settings.softwareVolume, 0.3)
  assert.equal(f.service.getRevision(), 1)
  f.service.rememberVolume(0.3001)
  await f.service.flush()
  assert.equal(f.service.getRevision(), 1)
  f.service.rememberVolume(0.5)
  timers.values().next().value!()
  assert.equal(f.service.state().settings.softwareVolume, 0.5)
})
