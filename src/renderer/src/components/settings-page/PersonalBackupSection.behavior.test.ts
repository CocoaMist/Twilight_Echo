import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref } from 'vue'

const source = readFileSync(new URL('./PersonalBackupSection.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('backup.ts', script, ts.ScriptTarget.Latest, true)
const body = ast.statements
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(ast))
  .join('\n')
const code = ts.transpileModule(
  `${body}\n({busy,error,message,staged,preview,selected,mappings,conflict,exportBackup,importBackup,chooseMapping,restore})`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  const calls: { name: string; payload: unknown }[] = []
  let next: unknown = null
  const core = {
    command: async (name: string, payload: unknown) => {
      calls.push({ name, payload })
      if (next instanceof Error) throw next
      return next
    }
  }
  const entry = runInNewContext(code, {
    ref,
    window: { api: {} },
    useCoreConnection: () => core,
    useFocusTrap() {},
    useEscapeToClose() {},
    Error
  })
  return {
    entry,
    calls,
    respond(value: unknown) {
      next = value
    }
  }
}

test('backup export and preview use the Core repository without collecting renderer data', async () => {
  const f = fixture()
  f.respond('/backup.zip')
  f.entry.exportBackup()
  await turn()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [{ name: 'backup.export', payload: {} }])
  assert.match(f.entry.message.value, /已导出/)
  assert.doesNotMatch(
    script,
    /sessionWriter|rendererData|useMusicStore|useListeningStats|readPersonalRendererData/
  )
  f.respond(null)
  f.entry.importBackup()
  await turn()
  assert.equal(f.entry.preview.value, null)
})

test('restore keeps the preview identity and passes plain selected domains and mapped paths', async () => {
  const f = fixture()
  f.respond({
    id: 'preview-7',
    rows: [{ domain: 'playlists' }, { domain: 'lyrics' }],
    roots: ['D:/Music', 'E:/Old']
  })
  f.entry.importBackup()
  await turn()
  f.respond('F:/Music')
  await f.entry.chooseMapping(f.entry.mappings.value[0])
  f.entry.selected.value = ['lyrics']
  f.entry.conflict.value = 'use-backup'
  f.respond(null)
  f.entry.restore()
  await turn()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), {
    name: 'backup.stage',
    payload: {
      id: 'preview-7',
      options: {
        conflict: 'use-backup',
        mappings: [{ from: 'D:/Music', to: 'F:/Music' }],
        domains: ['lyrics']
      }
    }
  })
  assert.equal(f.entry.preview.value, null)
  assert.equal(f.entry.staged.value, true)
  assert.equal(f.entry.busy.value, false)
})

test('failed staging preserves the preview for retry and releases busy state', async () => {
  const f = fixture()
  f.entry.preview.value = { id: 'preview-8' }
  f.respond(new Error('write failed'))
  f.entry.restore()
  await turn()
  assert.equal(f.entry.error.value, 'write failed')
  assert.equal(f.entry.preview.value.id, 'preview-8')
  assert.equal(f.entry.staged.value, false)
  assert.equal(f.entry.busy.value, false)
})
