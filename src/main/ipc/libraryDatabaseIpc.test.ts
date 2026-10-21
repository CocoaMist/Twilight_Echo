import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import type { IpcMain } from 'electron'
import { IPC } from '../../shared/ipcChannels.ts'
import type { LibraryDatabaseApi, LibraryFileMutationApi } from '../../shared/libraryDatabase.ts'
import type { LibrarySelectionService } from '../library/librarySelectionService.ts'
import type { LibraryQueueBuildService } from '../library/libraryQueueBuildService.ts'
import {
  validateLibraryFileRemoval,
  validateLibraryDirectoryScan,
  validateLibraryHistorySync,
  validateLibraryPlaylistViewSync,
  validateLibraryQueueReadOptions,
  validateLibraryQueueEdit
} from '../library/libraryDatabaseValidation.ts'

test('production database channels reject before opening a second library authority', async () => {
  const trusted = {},
    untrusted = {}
  const checked: unknown[] = []
  const dependencies: Record<string, unknown> = {
    '../library/libraryDatabaseValidation.ts': {
      validateLibraryFileRemoval,
      validateLibraryDirectoryScan,
      validateLibraryHistorySync,
      validateLibraryPlaylistViewSync,
      validateLibraryQueueReadOptions,
      validateLibraryQueueEdit
    },
    '../../shared/ipcChannels.ts': { IPC },
    '../security/electronSecurity.ts': {
      assertTrustedIpcSender(event: unknown) {
        checked.push(event)
        if (event !== trusted) throw new Error('Untrusted sender')
      }
    }
  }
  const exports: { setupLibraryDatabaseIpc?: (ipc: IpcMain) => void } = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./libraryDatabaseIpc.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        // The gate must not depend on userData, the worker or filesystem services.
        assert.ok(id in dependencies, `Production database gate imported ${id}`)
        return dependencies[id]
      }
    }
  )
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  exports.setupLibraryDatabaseIpc!({
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  } as unknown as IpcMain)
  const channels = [
    IPC.library.databaseBuildQueue,
    IPC.library.databaseSelection,
    IPC.library.databaseRepairPlaylist,
    IPC.library.databaseMetadata,
    IPC.library.databaseQueryTracks,
    IPC.library.databaseQueryCollections,
    IPC.library.databaseTracksByIds,
    IPC.library.databaseLookupPaths,
    IPC.library.databaseLookupPlaylist,
    IPC.library.databaseSyncPlaylistView,
    IPC.library.databasePatchTracks,
    IPC.library.databaseSyncListeningHistory,
    IPC.library.databaseRemoveFiles,
    IPC.library.databaseScanDirectories,
    IPC.library.databaseCreateQueue,
    IPC.library.databaseReadQueue,
    IPC.library.databaseGetQueue,
    IPC.library.databaseEditQueue,
    IPC.library.databaseDeleteQueue,
    IPC.library.databaseSyncQueueReferences,
    IPC.library.databaseCollectQueueGarbage
  ]
  assert.deepEqual([...handlers.keys()].sort(), [...channels, IPC.library.getStorageMode].sort())
  assert.equal(handlers.get(IPC.library.getStorageMode)!(trusted), 'json')
  assert.throws(() => handlers.get(IPC.library.getStorageMode)!(untrusted), /Untrusted sender/)
  for (const channel of channels) {
    const invoke = handlers.get(channel)!
    await assert.rejects(invoke(trusted), /SQLite 曲库尚未启用/)
    await assert.rejects(invoke(untrusted), /Untrusted sender/)
  }
  assert.equal(checked.length, channels.length * 2 + 2)
})

test('enabled database channels delegate to the injected authority only after sender verification', async () => {
  const trusted = { sender: {} },
    untrusted = {}
  const calls: { method: string; args: unknown[] }[] = []
  const api = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push({ method, args })
          return Promise.resolve({ method })
        }
    }
  ) as LibraryDatabaseApi
  const exports: {
    setupLibraryDatabaseIpc?: (
      ipc: IpcMain,
      database: LibraryDatabaseApi,
      mutations: LibraryFileMutationApi,
      repair: undefined,
      selections: Pick<LibrarySelectionService, 'handle'>,
      queueBuilds: Pick<LibraryQueueBuildService, 'handle'>
    ) => void
  } = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./libraryDatabaseIpc.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require(id: string) {
        if (id === '../library/libraryDatabaseValidation.ts')
          return {
            validateLibraryFileRemoval,
            validateLibraryDirectoryScan,
            validateLibraryHistorySync,
            validateLibraryPlaylistViewSync,
            validateLibraryQueueReadOptions,
            validateLibraryQueueEdit
          }
        if (id === '../../shared/ipcChannels.ts') return { IPC }
        if (id === '../security/electronSecurity.ts')
          return {
            assertTrustedIpcSender(event: unknown) {
              if (event !== trusted) throw new Error('Untrusted sender')
            }
          }
        throw new Error(`Unexpected dependency: ${id}`)
      }
    }
  )
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  exports.setupLibraryDatabaseIpc!(
    { handle: (channel, handler) => handlers.set(channel, handler) } as unknown as IpcMain,
    api,
    {
      scanDirectories: async (request) => {
        calls.push({ method: 'scanDirectories', args: [request] })
        return {} as never
      },
      removeFiles: async (request) => {
        calls.push({ method: 'removeFiles', args: [request] })
        return {} as never
      }
    },
    undefined,
    {
      handle: async (owner, input) => {
        calls.push({ method: 'selection', args: [owner, input] })
        return { kind: 'closed', id: 'lease' }
      }
    },
    {
      handle: async (owner, input) => {
        calls.push({ method: 'buildQueue', args: [owner, input] })
        return { kind: 'aborted', id: 'seed' }
      }
    }
  )
  assert.equal(handlers.get(IPC.library.getStorageMode)!(trusted), 'sqlite')
  assert.throws(() => handlers.get(IPC.library.getStorageMode)!(untrusted), /Untrusted sender/)
  assert.equal(calls.length, 0, 'mode discovery must not invoke the database worker')
  const query = { limit: 200, search: '周杰伦' },
    ids = ['kept-id'],
    patches = [{ id: 'kept-id', expectedVersion: 3, patch: { title: 'Edit' } }],
    removal = {
      mode: 'library',
      items: [{ id: 'kept-id', filePath: 'D:/Music/one.flac', title: 'One', artist: 'Artist' }]
    }
  const scenarios: [string, string, unknown[]][] = [
    [IPC.library.databaseMetadata, 'getMetadata', []],
    [
      IPC.library.databaseSyncPlaylistView,
      'syncPlaylistView',
      [{ kind: 'begin', id: 'v', versions: [] }]
    ],
    [IPC.library.databaseQueryTracks, 'queryTracks', [query]],
    [IPC.library.databaseQueryCollections, 'queryCollections', ['albums', query]],
    [IPC.library.databaseTracksByIds, 'getTracksByIds', [ids]],
    [IPC.library.databaseTracksByIds, 'getTracksByIds', [ids, 7]],
    [IPC.library.databaseLookupPaths, 'lookupTracksByPaths', [['D:/Music/one.flac'], 7]],
    [
      IPC.library.databaseLookupPlaylist,
      'lookupPlaylistTracks',
      [{ entries: [{ id: 'kept-id' }], versions: [] }, 7]
    ],
    [IPC.library.databasePatchTracks, 'patchTracks', [patches]],
    [
      IPC.library.databaseSyncListeningHistory,
      'syncListeningHistory',
      [{ kind: 'begin', id: 'sync', mode: 'replace' }]
    ],
    [IPC.library.databaseRemoveFiles, 'removeFiles', [removal]],
    [
      IPC.library.databaseScanDirectories,
      'scanDirectories',
      [{ directories: [resolve('Music')], reason: 'tags' }]
    ],
    [IPC.library.databaseCreateQueue, 'createLibraryQueue', [query, 'kept-id']],
    [IPC.library.databaseReadQueue, 'readLibraryQueue', ['queue-id', 400, 200]],
    [IPC.library.databaseGetQueue, 'getLibraryQueue', ['queue-id']],
    [IPC.library.databaseEditQueue, 'editLibraryQueue', ['queue-id', 2, { kind: 'clear' }]],
    [IPC.library.databaseDeleteQueue, 'deleteLibraryQueue', ['queue-id', 3]],
    [
      IPC.library.databaseSyncQueueReferences,
      'syncLibraryQueueReferences',
      ['owner', ['queue-id']]
    ],
    [IPC.library.databaseCollectQueueGarbage, 'collectLibraryQueueGarbage', [3600]]
  ]
  for (const [channel, method, args] of scenarios) {
    const handler = handlers.get(channel)!
    const count = calls.length
    await assert.rejects(async () => handler(untrusted, ...args), /Untrusted sender/)
    assert.equal(calls.length, count)
    await handler(trusted, ...args)
    assert.deepEqual(calls.at(-1), { method, args })
  }
  const selection = handlers.get(IPC.library.databaseSelection)!
  const command = { kind: 'read', id: 'lease', cursor: 200, projection: 'files' }
  const previousCalls = calls.length
  await assert.rejects(async () => selection(untrusted, command), /Untrusted sender/)
  assert.equal(calls.length, previousCalls)
  await selection(trusted, command)
  assert.deepEqual(calls.at(-1), { method: 'selection', args: [trusted.sender, command] })
  const buildQueue = handlers.get(IPC.library.databaseBuildQueue)!
  const seed = { kind: 'begin', id: 'seed', contentRevision: 7, order: 'original' }
  const beforeSeed = calls.length
  await assert.rejects(async () => buildQueue(untrusted, seed), /Untrusted sender/)
  assert.equal(calls.length, beforeSeed)
  await buildQueue(trusted, seed)
  assert.deepEqual(calls.at(-1), { method: 'buildQueue', args: [trusted.sender, seed] })
  const before = calls.length
  for (const request of [
    null,
    { mode: 'unknown', items: [] },
    { mode: 'trash', items: [{}] },
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map((expectedVersion) => ({
      ...removal,
      items: [{ ...removal.items[0], expectedVersion }]
    })),
    { ...removal, items: [{ ...removal.items[0], expectedInstance: 1 }] },
    ...[0, -1, 1.5, '1'].map((expectedInstance) => ({
      ...removal,
      items: [{ ...removal.items[0], expectedVersion: 1, expectedInstance }]
    })),
    { mode: 'library', items: Array.from({ length: 1001 }, () => removal.items[0]) }
  ]) {
    await assert.rejects(
      async () => handlers.get(IPC.library.databaseRemoveFiles)!(trusted, request),
      /Invalid/
    )
  }
  assert.equal(calls.length, before, 'invalid file mutations must never reach the owner')
  for (const request of [
    null,
    { directories: [], reason: 'import' },
    { directories: ['relative'], reason: 'tags' },
    { directories: [resolve('Music')], reason: 'watch' },
    { directories: [resolve('bad\0path')], reason: 'import' },
    { directories: Array(1001).fill(resolve('Music')), reason: 'import' }
  ]) {
    await assert.rejects(
      async () => handlers.get(IPC.library.databaseScanDirectories)!(trusted, request),
      /Invalid/
    )
  }
  assert.equal(calls.length, before, 'invalid scope requests must never reach the owner')
  for (const request of [
    null,
    { kind: 'begin', id: 'x', mode: 'patch' },
    { kind: 'append', id: 'x', sequence: 1, entries: Array(1001).fill({ id: 't', lastPlayed: 1 }) }
  ])
    await assert.rejects(
      async () => handlers.get(IPC.library.databaseSyncListeningHistory)!(trusted, request),
      /Invalid/
    )
  assert.equal(calls.length, before)
  for (const request of [
    null,
    { kind: 'begin', id: '', versions: [] },
    { kind: 'append', id: 'v', sequence: 1, entries: Array(201).fill({ id: 'one' }) },
    {
      kind: 'append',
      id: 'v',
      sequence: 1,
      entries: [{ id: 'x', snapshot: { id: 'x', title: 'X', artist: 'A', filePath: 12 } }]
    }
  ])
    await assert.rejects(
      async () => handlers.get(IPC.library.databaseSyncPlaylistView)!(trusted, request),
      /Invalid/
    )
  assert.equal(
    calls.length,
    before,
    'invalid playlist definitions must not cross the process boundary'
  )
})
