import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { LocalLibraryWatchChange } from '../../shared/localLibraryScan.ts'
import { LibraryWatcherPoller } from './libraryWatcherPolling.ts'
import * as extensions from './watcherExtensions.ts'

function fixture() {
  let callback!: (type: string, name: string | null) => void
  const pending = new Map<number, () => void>()
  let sequence = 0
  const deliveries: LocalLibraryWatchChange[][] = []
  const watch = Object.assign(new EventEmitter(), { close() {} })
  const runtime = {
    libraryDatabase: {
      enqueueWatcherChanges: (changes: LocalLibraryWatchChange[]) => deliveries.push(changes)
    },
    libraryWatcherDebounceMs: 350
  }
  const exports: { applyLibraryWatchers?: (folders: string[], enabled: boolean) => void } = {}
  const dependencies: Record<string, unknown> = {
    fs: {
      watch: (_folder: string, _options: object, cb: typeof callback) => {
        callback = cb
        return watch
      },
      existsSync: () => true
    },
    path,
    '../core/runtime': { runtime },
    './libraryRepository.ts': {
      isActiveLibraryPathExcluded: () => false,
      isLibraryPathMutationInProgress: () => false
    },
    './watcherExtensions.ts': extensions,
    './libraryWatcherPolling.ts': { LibraryWatcherPoller }
  }
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./watcher.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      console,
      process: { platform: 'win32' },
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      setTimeout: (action: () => void) => {
        const id = ++sequence
        pending.set(id, action)
        return id
      },
      clearTimeout: (id: number) => pending.delete(id),
      clearInterval: (id: number) => pending.delete(id)
    }
  )
  const root = path.resolve('media')
  exports.applyLibraryWatchers!([root], true)
  return {
    root,
    deliveries,
    pending,
    emit(name: string) {
      callback('change', name)
    },
    flush() {
      const timers = [...pending.values()]
      pending.clear()
      timers.forEach((timer) => timer())
    },
    stop() {
      exports.applyLibraryWatchers!([], false)
    }
  }
}

test('native SQLite events coalesce by directory without indefinitely delaying the first flush', () => {
  const f = fixture()
  for (let i = 0; i < 5000; i++) f.emit(`album/${i}.flac`)
  assert.equal(f.pending.size, 1)
  f.flush()
  assert.equal(f.deliveries.length, 1)
  assert.equal(
    JSON.stringify(f.deliveries[0]),
    JSON.stringify([{ kind: 'reconcile', path: path.join(f.root, 'album') }])
  )
  f.stop()
})

test('native SQLite event staging stays bounded when more than 256 directories change', () => {
  const f = fixture()
  for (let i = 0; i < 5000; i++) f.emit(`album-${i}/track.flac`)
  assert.equal(f.pending.size, 1)
  f.flush()
  assert.equal(
    JSON.stringify(f.deliveries[0]),
    JSON.stringify([{ kind: 'reconcile', path: f.root }])
  )
  f.stop()
})
