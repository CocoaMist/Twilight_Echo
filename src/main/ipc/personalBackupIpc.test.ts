import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { isRecord, remapPersonalPaths, type PersonalBackup } from '../../shared/personalBackup.ts'
import { checkRestoreOptions } from '../../core/persistence/personalBackup.ts'

function fixture() {
  const trusted = {}, calls: string[] = []
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  let incoming: PersonalBackup = {
    format: 'twilight-personal-data', version: 1, createdAt: '2026-10-24T00:00:00Z', data: { playlists: [] }
  }
  const persistence = {
    createPersonalBackup: () => { calls.push('json-export-v1'); return incoming },
    createPersonalBackupV1FromDatabase: async () => { calls.push('database-export-v1'); return incoming },
    writePersonalBackupFile: () => calls.push('write-export'),
    readBackupFile: () => incoming,
    previewRestoreFromDatabase: async () => { calls.push('database-preview'); return { version: 1 } },
    stagePersonalRestoreFromDatabase: async () => calls.push('database-stage'),
    checkRestoreOptions
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      app: { getPath: () => 'profile' },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ['backup.json'] }),
        showSaveDialog: async () => ({ canceled: false, filePath: 'export.json' })
      }
    },
    '../security/electronSecurity.ts': {
      assertTrustedIpcSender: (event: unknown) => {
        if (event !== trusted) throw new Error('Untrusted sender')
      }
    },
    '../security/localPaths.ts': { resolveAuthorizedLibraryRootSettings: async () => [] },
    '../persistence/personalBackup.ts': persistence,
    '../../shared/personalBackup.ts': { isRecord, remapPersonalPaths }
  }
  const exports: { registerPersonalBackupIpc?: (ipc: unknown, database: unknown) => void } = {}
  runInNewContext(ts.transpileModule(readFileSync(new URL('./personalBackupIpc.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    exports, require: (id: string) => { assert.ok(id in dependencies, id); return dependencies[id] }
  })
  exports.registerPersonalBackupIpc!({ handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) }, {})
  return { trusted, calls, handlers, importVersion: (version: 1 | 2) => { incoming = { ...incoming, version } } }
}

test('legacy backup IPC retains v1 export and restore, and cannot stage a v2 file without Core review', async () => {
  const f = fixture()
  const options = { domains: ['playlists'], conflict: 'keep-local', mappings: [] }
  await f.handlers.get('data:exportPersonalBackup')!(f.trusted, {})
  assert.deepEqual(f.calls, ['database-export-v1', 'write-export'])
  await f.handlers.get('data:previewPersonalBackup')!(f.trusted, {})
  f.importVersion(2)
  await assert.rejects(f.handlers.get('data:previewPersonalBackup')!(f.trusted, {}), /Core/)
  await assert.rejects(f.handlers.get('data:stagePersonalRestore')!(f.trusted, options), /请先选择/)
  assert.equal(f.calls.includes('database-stage'), false)
  f.importVersion(1)
  await f.handlers.get('data:previewPersonalBackup')!(f.trusted, {})
  await f.handlers.get('data:stagePersonalRestore')!(f.trusted, options)
  assert.equal(f.calls.filter(call => call === 'database-stage').length, 1)
})

test('legacy backup IPC rejects an untrusted sender before reading or writing', async () => {
  const f = fixture()
  for (const name of ['data:exportPersonalBackup', 'data:previewPersonalBackup', 'data:stagePersonalRestore'])
    await assert.rejects(f.handlers.get(name)!({}, {}), /Untrusted sender/)
  assert.deepEqual(f.calls, [])
})
