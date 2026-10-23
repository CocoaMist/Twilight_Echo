import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import type { LibraryMetadata } from '../../shared/libraryDatabase.ts'
import { CoreLibraryBackground } from './background.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('startup and CUE/file watchers have one Core owner; configuration and shutdown close real handles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = resolve('fixture-media')
  const metadata: LibraryMetadata = {
    revision: 1,
    trackCount: 0,
    fileCount: 0,
    folders: [root],
    exclusions: [{ filePath: join(root, 'excluded.flac'), title: '', artist: '', excludedAt: '' }]
  }
  let enabled = true,
    starts = 0,
    closed = 0
  const directories: string[][] = [],
    authorized: string[] = [],
    errors: unknown[] = []
  const callbacks = new Map<string, (event: string, file: string) => void>()
  const background = new CoreLibraryBackground({
    database: { getMetadata: async () => metadata },
    scan: {
      startup: async () => {
        starts++
      },
      poll: async () => false,
      enqueueDirectories: async (roots) => {
        directories.push([...roots])
      }
    },
    enabled: () => enabled,
    authorizeDirectory: async (path) => {
      authorized.push(path)
      return path
    },
    pathKey: (path) => resolve(path).toLowerCase(),
    directoryOf: dirname,
    platform: 'win32',
    now: () => new Date('2026-10-22T00:00:00Z'),
    failed: (error) => errors.push(error),
    watch: ((folder, _options, callback) => {
      callbacks.set(String(folder), callback)
      return Object.assign(new EventEmitter(), {
        close() {
          closed++
        }
      })
    }) as typeof watch
  })
  t.after(() => background.shutdown())
  assert.deepEqual(background.snapshot(), { enabled: false, folders: [] })
  await background.configure()
  assert.equal(starts, 0)
  background.activate()
  background.activate()
  await tick()
  assert.equal(starts, 1)
  assert.deepEqual(authorized, [root])
  assert.equal(background.snapshot().folders[0].state, 'active')
  const changed = callbacks.get(root)!
  changed('rename', 'excluded.flac')
  changed('change', 'album/disc.cue')
  changed('change', 'album/song.wav')
  t.mock.timers.tick(350)
  await tick()
  assert.deepEqual(directories, [[join(root, 'album')]])
  await background.configure()
  assert.equal(starts, 1)
  assert.equal(closed, 0)
  enabled = false
  await background.configure()
  assert.equal(closed, 1)
  assert.equal(background.snapshot().folders[0].state, 'disabled')
  enabled = true
  await background.configure()
  assert.equal(background.snapshot().folders[0].state, 'active')
  changed('change', 'pending.wav')
  await background.shutdown()
  t.mock.timers.tick(350)
  assert.equal(closed, 2)
  assert.equal(directories.length, 1, 'shutdown cancels pending debounces')
  assert.deepEqual(errors, [])
})

test('Linux fallback shutdown joins an in-flight poll without rearming a timer', async (t) => {
  let release!: (value: boolean) => void
  let polling = false,
    joined = false
  const background = new CoreLibraryBackground({
    database: {
      getMetadata: async () => ({
        revision: 0,
        trackCount: 0,
        fileCount: 0,
        folders: ['/music'],
        exclusions: []
      })
    },
    scan: {
      startup: async () => {},
      enqueueDirectories: async () => {},
      poll: () =>
        new Promise((resolve) => {
          polling = true
          release = resolve
        })
    },
    enabled: () => true,
    authorizeDirectory: async (path) => path,
    pathKey: (path) => path,
    directoryOf: dirname,
    platform: 'linux',
    now: () => new Date(),
    failed: assert.fail
  })
  t.after(() => background.shutdown())
  background.activate()
  await tick()
  assert.equal(polling, true)
  assert.equal(background.snapshot().folders[0].mode, 'polling')
  const closing = background.shutdown().then(() => {
    joined = true
  })
  await tick()
  assert.equal(joined, false)
  release(false)
  await closing
  assert.equal(joined, true)
})

test('shutdown during path authorization cannot recreate watchers after services stop', async () => {
  let release!: (path: string) => void,
    handles = 0
  const background = new CoreLibraryBackground({
    database: {
      getMetadata: async () => ({
        revision: 0,
        trackCount: 0,
        fileCount: 0,
        folders: ['/music'],
        exclusions: []
      })
    },
    scan: { startup: async () => {}, poll: async () => false, enqueueDirectories: async () => {} },
    enabled: () => true,
    authorizeDirectory: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    pathKey: (path) => path,
    directoryOf: dirname,
    platform: 'win32',
    now: () => new Date(),
    failed: assert.fail,
    watch: (() => {
      handles++
      throw new Error('Unexpected watcher')
    }) as typeof watch
  })
  background.activate()
  await tick()
  const closing = background.shutdown()
  release('/music')
  await closing
  assert.equal(handles, 0)
})
