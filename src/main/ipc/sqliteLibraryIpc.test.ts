import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { IPC } from '../../shared/ipcChannels.ts'

function fixture() {
  const trusted = {},
    calls: { method: string; args: unknown[] }[] = [],
    sent: unknown[][] = [],
    sizes: string[] = []
  const emitter = new EventEmitter()
  const owner = new Proxy(emitter, {
    get(target, method: string) {
      if (method === 'on') return target.on.bind(target)
      return (...args: unknown[]) => {
        calls.push({ method, args })
        if (method === 'getStatus') return { state: 'paused', error: 'sensitive' }
        if (method === 'clearLegacyExclusions')
          return Promise.resolve({ library: 'complete-document', clearedFilePaths: ['restored'] })
        return Promise.resolve(method)
      }
    }
  })
  const exports: { registerSqliteLibraryIpc?: (...args: unknown[]) => void } = {}
  const dependencies: Record<string, unknown> = {
    '../../shared/ipcChannels.ts': { IPC },
    '../core/runtime': {
      runtime: {
        mainWindow: { webContents: { send: (...args: unknown[]) => sent.push(args) } },
        appSettings: { libraryFolders: ['authorized'], watchLibrary: true }
      }
    },
    '../security/electronSecurity.ts': {
      assertTrustedIpcSender: (event: unknown) => {
        if (event !== trusted) throw new Error('Untrusted sender')
      }
    },
    '../security/ipcValidation.ts': {
      stringifyJsonForIpcStorage: (_value: unknown, label: string) => sizes.push(label)
    },
    '../security/localPaths': {
      filterAuthorizedLibraryRoots: async (folders: string[]) =>
        folders.filter((folder) => folder === 'authorized')
    },
    '../library/libraryRepository.ts': { MAX_MUSIC_LIBRARY_BYTES: 100 * 1024 * 1024 },
    '../library/watcher.ts': {
      getLibraryWatcherStatusSnapshot: (folders: string[], enabled: boolean) => ({
        folders,
        enabled
      })
    },
    '../security/secureStorage.ts': {
      redactSensitiveText: (value: string) => value.replace('sensitive', 'redacted')
    }
  }
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./sqliteLibraryIpc.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      console,
      require: (id: string) => {
        assert.ok(id in dependencies, `Unexpected dependency: ${id}`)
        return dependencies[id]
      }
    }
  )
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const identity = (value: unknown) => value
  exports.registerSqliteLibraryIpc!(
    {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler)
    },
    owner,
    {
      normalizeSnapshot: identity,
      normalizeRemove: identity,
      normalizeExclusions: identity
    }
  )
  return { trusted, calls, sent, sizes, emitter, handlers }
}

test('compatibility IPC rejects all untrusted calls before touching the owner or arguments', async () => {
  const f = fixture()
  assert.equal(f.handlers.size, 13)
  for (const handler of f.handlers.values())
    await assert.rejects(async () => handler({}, null), /Untrusted sender/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.sizes.length, 0)
})

test('compatibility IPC retains whole snapshots, applies folder grants and bounds mutation requests', async () => {
  const f = fixture()
  assert.equal(await f.handlers.get('data:loadMusicLibrary')!(f.trusted), 'loadLegacyDocument')
  const snapshot = {
    revision: 4,
    tracks: Array.from({ length: 450 }, (_, id) => ({ id: String(id) })),
    folders: ['authorized', 'revoked']
  }
  await f.handlers.get('data:saveMusicLibrary')!(f.trusted, snapshot)
  assert.equal((f.calls.at(-1)!.args[0] as typeof snapshot).tracks.length, 450)
  assert.deepEqual(snapshot.folders, ['authorized'])
  const request = { library: snapshot, items: [{ id: '2' }], mode: 'library' }
  await f.handlers.get(IPC.library.removeTracks)!(f.trusted, request)
  assert.equal(f.calls.at(-1)!.method, 'removeLegacy')
  assert.equal(f.calls.at(-1)!.args[0], request)
  assert.ok(f.sizes.includes('library removal request'))
  const restored = await f.handlers.get(IPC.library.restoreExclusions)!(f.trusted, {
    library: snapshot,
    filePaths: ['restored']
  })
  assert.equal(
    JSON.stringify(restored),
    JSON.stringify({ library: 'complete-document', restoredFilePaths: ['restored'] })
  )
  assert.ok(f.sizes.includes('library exclusion restore request'))
})

test('database revision notifications and scan errors reach the renderer with redaction', () => {
  const f = fixture()
  f.emitter.emit('changed', 42)
  f.emitter.emit('status', { state: 'failed', error: 'sensitive' })
  assert.equal(
    JSON.stringify(f.sent[0]),
    JSON.stringify([IPC.library.changed, { kind: 'database', revision: 42 }])
  )
  assert.equal(
    JSON.stringify(f.sent[1]),
    JSON.stringify([IPC.library.scanStatus, { state: 'failed', error: 'redacted' }])
  )
})
