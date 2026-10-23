import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatformCacheMaintenance } from './platformCacheMaintenance.ts'

test('platform clear uses Chromium API without deleting its live directory and drains cover owners', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'te-platform-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'old-covers'),
    events: string[] = []
  for (const name of ['cover-cache', 'renderer-cache', 'old-covers']) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'original'), name)
  }
  await writeFile(join(root, 'user-file'), 'keep')
  const clear = createPlatformCacheMaintenance({
    root,
    legacyCover: legacy,
    authorizeRoot: async () => {
      events.push('authorize')
      return root
    },
    maintainRemote: async (action) => {
      events.push('remote')
      return action()
    },
    maintainCovers: async (action) => {
      events.push('covers')
      return action()
    },
    clearMemory: () => events.push('memory'),
    clearChromium: async () => {
      events.push('chromium')
    }
  })
  await clear(new AbortController().signal)
  assert.deepEqual(events, ['authorize', 'remote', 'covers', 'memory', 'memory', 'chromium'])
  assert.deepEqual(await readdir(join(root, 'cover-cache')), [])
  assert.deepEqual(await readdir(legacy), [])
  assert.equal(await readFile(join(root, 'renderer-cache', 'original'), 'utf8'), 'renderer-cache')
  assert.equal(await readFile(join(root, 'user-file'), 'utf8'), 'keep')
})

test('revoked root authorization leaves all platform caches intact', async () => {
  const clear = createPlatformCacheMaintenance({
    root: 'unused',
    legacyCover: 'unused',
    authorizeRoot: async () => {
      throw new Error('denied')
    },
    maintainRemote: async () => {
      throw new Error('must not enter')
    },
    maintainCovers: async () => {
      throw new Error('must not enter')
    },
    clearMemory: () => assert.fail('must not clear'),
    clearChromium: async () => assert.fail('must not clear')
  })
  await assert.rejects(clear(new AbortController().signal), /denied/)
})

test('legacy cleanup cannot delete a selected cache root inside the legacy cover directory', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'te-cache-legacy-root-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const legacy = join(profile, 'cover-cache')
  for (const root of [legacy, join(legacy, 'selected')]) {
    await mkdir(join(root, 'cover-cache'), { recursive: true })
    await writeFile(join(root, 'personal'), 'keep')
    await writeFile(join(root, 'cover-cache', 'stale'), 'cover')
    const clear = createPlatformCacheMaintenance({
      root,
      legacyCover: legacy,
      authorizeRoot: async () => root,
      maintainRemote: async (action) => action(),
      maintainCovers: async (action) => action(),
      clearMemory: () => {},
      clearChromium: async () => {}
    })
    await clear(new AbortController().signal)
    assert.equal(await readFile(join(root, 'personal'), 'utf8'), 'keep')
    assert.deepEqual(await readdir(join(root, 'cover-cache')), [])
  }
})

test('an interrupted platform clear also invalidates memory and never starts Chromium cleanup', async () => {
  const abort = new AbortController()
  let clears = 0
  const clear = createPlatformCacheMaintenance({
    root: 'unused',
    legacyCover: 'unused',
    authorizeRoot: async () => 'unused',
    maintainRemote: async (action) => action(),
    maintainCovers: async (action) => action(),
    clearMemory: () => {
      clears++
      abort.abort(new Error('cancelled'))
    },
    clearChromium: async () => assert.fail('cancelled before Chromium')
  })
  await assert.rejects(clear(abort.signal), /cancelled/)
  assert.equal(clears, 2)
})
