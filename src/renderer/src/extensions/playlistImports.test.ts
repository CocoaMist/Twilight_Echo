import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createPlaylistImportQueue } from '../../../main/plugins/playlistImportQueue.ts'
import type { PluginPlaylistImportNotice } from '../../../shared/pluginPlaylistImport.ts'
import { consumePluginPlaylistImports } from './playlistImports.ts'

const notice = (name: string): PluginPlaylistImportNotice => ({
  pluginId: 'test.importer',
  playlists: [{ name, paths: ['D:/Music/song.flac'] }]
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('queues activation imports until both stores load, then drains live imports once in order', async () => {
  const queue = createPlaylistImportQueue()
  const library = deferred()
  const playlists = deferred()
  const applied: string[] = []
  let listener: (() => void) | undefined
  const notify = (): void => listener?.()
  let takes = 0
  queue.enqueue(notice('before-window'))
  const starting = consumePluginPlaylistImports({
    ready: Promise.all([library.promise, playlists.promise]),
    subscribe: (callback) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    take: async () => {
      takes++
      return queue.take()
    },
    apply: (request) => {
      applied.push(request.playlists[0].name)
    },
    onError: (error) => {
      throw error
    }
  })
  library.resolve()
  await tick()
  queue.enqueue(notice('during-playlist-load'))
  assert.equal(listener, undefined)
  assert.equal(takes, 0)
  playlists.resolve()
  const stop = await starting
  assert.deepEqual(applied, ['before-window', 'during-playlist-load'])
  queue.enqueue(notice('live'))
  notify()
  notify()
  await tick()
  assert.deepEqual(applied, ['before-window', 'during-playlist-load', 'live'])
  stop()
})

test('failed hydration leaves accepted imports queued for a later renderer', async () => {
  const queue = createPlaylistImportQueue()
  queue.enqueue(notice('keep'))
  await assert.rejects(
    consumePluginPlaylistImports({
      ready: Promise.reject(new Error('load failed')),
      subscribe: () => {
        assert.fail('must not subscribe before hydration')
      },
      take: async () => {
        assert.fail('must not drain before hydration')
      },
      apply: () => {
        assert.fail('must not import before hydration')
      },
      onError: () => {}
    }),
    /load failed/
  )
  assert.deepEqual(queue.take(), [notice('keep')])
})

test('serializes notifications during a pending pull without dropping newer requests', async () => {
  const queue = createPlaylistImportQueue()
  const gate = deferred()
  let listener!: () => void
  let calls = 0
  const applied: string[] = []
  queue.enqueue(notice('first'))
  const starting = consumePluginPlaylistImports({
    ready: Promise.resolve(),
    subscribe: (callback) => {
      listener = callback
      return () => {}
    },
    take: async () => {
      const batch = queue.take()
      if (++calls === 1) await gate.promise
      return batch
    },
    apply: (request) => {
      applied.push(request.playlists[0].name)
    },
    onError: (error) => {
      throw error
    }
  })
  await tick()
  queue.enqueue(notice('second'))
  listener()
  gate.resolve()
  const stop = await starting
  await tick()
  assert.deepEqual(applied, ['first', 'second'])
  stop()
})

test('one failed import does not discard subsequent queued requests', async () => {
  const queue = createPlaylistImportQueue()
  queue.enqueue(notice('bad'))
  queue.enqueue(notice('good'))
  const applied: string[] = []
  const errors: unknown[] = []
  const stop = await consumePluginPlaylistImports({
    ready: Promise.resolve(),
    subscribe: () => () => {},
    take: async () => queue.take(),
    apply: (request) => {
      if (request.playlists[0].name === 'bad') throw new Error('bad import')
      applied.push(request.playlists[0].name)
    },
    onError: (error) => {
      errors.push(error)
    }
  })
  assert.deepEqual(applied, ['good'])
  assert.equal(errors.length, 1)
  stop()
})

test('plugin imports route through Core with a permission gate and serialized applies', () => {
  // After the Core migration a plugin imports playlists through the Core
  // plugin manager directly: the call is permission-gated there and applied
  // through the serialized playlists service, so the renderer no longer
  // consumes or gates the import queue.
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /startPluginPlaylistImports/, 'renderer must not consume plugin imports')
  const coreEntry = readFileSync(
    new URL('../../../main/coreProcess/entry.ts', import.meta.url),
    'utf8'
  )
  assert.match(coreEntry, /importPlaylists: \(request\) => playlists\.importFromPlugin\(request\)/)
  const manager = readFileSync(new URL('../../../core/plugins/manager.ts', import.meta.url), 'utf8')
  assert.match(manager, /requirePermission\(id, 'library:write', 'library\.importPlaylists'\)/)
  const service = readFileSync(
    new URL('../../../core/playlists/service.ts', import.meta.url),
    'utf8'
  )
  assert.match(service, /importPlaylistPathBatchAsync\(request\.playlists\)/)
  const ipc = readFileSync(new URL('../../../main/ipc/plugins.ts', import.meta.url), 'utf8')
  assert.match(ipc, /playlistImports\.enqueue\(request\)/)
  assert.match(ipc, /event\.sender !== runtime\.mainWindow\?\.webContents/)
  assert.match(ipc, /event\.senderFrame !== event\.sender\.mainFrame/)
})

test('async applies finish before another pull starts and rejected applies do not discard later imports', async () => {
  const queue = createPlaylistImportQueue(),
    gate = deferred()
  queue.enqueue(notice('pending'))
  queue.enqueue(notice('bad'))
  queue.enqueue(notice('same-batch'))
  let listener!: () => void,
    takes = 0,
    active = 0,
    maxActive = 0
  const started: string[] = [],
    finished: string[] = [],
    errors: unknown[] = []
  const starting = consumePluginPlaylistImports({
    ready: Promise.resolve(),
    subscribe: (callback) => {
      listener = callback
      return () => {}
    },
    take: async () => {
      takes++
      return queue.take()
    },
    apply: async (request) => {
      const name = request.playlists[0].name
      started.push(name)
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (name === 'pending') await gate.promise
        if (name === 'bad') throw new Error('async failed')
        finished.push(name)
      } finally {
        active--
      }
    },
    onError: (error) => {
      errors.push(error)
    }
  })
  await tick()
  queue.enqueue(notice('later-pull'))
  listener()
  listener()
  await tick()
  assert.deepEqual(started, ['pending'])
  assert.equal(takes, 1)
  gate.resolve()
  const stop = await starting
  await tick()
  assert.deepEqual(finished, ['pending', 'same-batch', 'later-pull'])
  assert.equal(errors.length, 1)
  assert.equal(maxActive, 1)
  stop()
})
