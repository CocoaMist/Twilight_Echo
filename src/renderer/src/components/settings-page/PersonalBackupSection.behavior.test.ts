import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { PERSONAL_DOMAINS, personalDomainLabel } from '../../../../shared/personalBackup.ts'

const source = readFileSync(new URL('./PersonalBackupSection.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('backup.ts', script, ts.ScriptTarget.Latest, true)
const body = ast.statements
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(ast))
  .join('\n')
const code = ts.transpileModule(
  `${body}\n({busy,error,message,staged,preview,selected,exportSelected,mappings,conflict,needsReview,stageUncertain,exportBackup,importBackup,recoverBackup,updatePreview,chooseMapping,restore})`,
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
    computed,
    PERSONAL_DOMAINS,
    personalDomainLabel,
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

test('v2 export selects complete domains and refuses an empty selection', async () => {
  const f = fixture()
  f.entry.exportSelected.value = ['music', 'versions']
  f.respond(true)
  f.entry.exportBackup()
  await turn()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { name: 'backup.export', payload: { domains: ['music', 'versions'] } })
  f.entry.exportSelected.value = []
  f.entry.exportBackup()
  await turn()
  assert.equal(f.calls.length, 1)
  assert.match(f.entry.error.value, /至少选择/)
})

test('v2 changed choices require explicit repreview before stage, preserving mapped roots', async () => {
  const f = fixture(), preview = { id: 'v2', version: 2, createdAt: '2026-10-24', rows: [{ domain: 'library' }, { domain: 'music' }], roots: ['D:/Music'] }
  f.respond(preview)
  f.entry.importBackup()
  await turn()
  assert.equal(f.entry.needsReview.value, false)
  f.entry.selected.value = ['music']
  f.entry.mappings.value[0].to = 'E:/Music'
  f.entry.restore()
  await turn()
  assert.equal(f.calls.length, 1, 'unreviewed changes never stage')
  assert.equal(f.entry.needsReview.value, true)
  f.respond({ ...preview, music: { missingSources: 4, unbound: 3, mappedEntities: 1, conflicts: 0, dependencies: [] } })
  f.entry.updatePreview()
  await turn()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), { name: 'backup.repreview', payload: { id: 'v2', options: { conflict: 'keep-local', mappings: [{ from: 'D:/Music', to: 'E:/Music' }], domains: ['music'] } } })
  assert.equal(f.entry.needsReview.value, false)
  assert.equal(f.entry.preview.value.music.missingSources, 4)
  assert.equal(f.entry.mappings.value[0].from, 'D:/Music')
  f.respond({ restartRequired: true })
  f.entry.restore()
  await turn()
  assert.equal(f.calls.at(-1)!.name, 'backup.stage')
  assert.equal(f.entry.staged.value, true)
})

test('unknown v2 stage retains choices and blocks repeated submission until reviewed', async () => {
  const f = fixture()
  f.respond({ id: 'uncertain', version: 2, rows: [{ domain: 'music' }], roots: [] })
  f.entry.importBackup()
  await turn()
  f.respond(new Error('reply lost'))
  f.entry.restore()
  await turn()
  assert.equal(f.entry.stageUncertain.value, true)
  assert.equal(f.entry.preview.value.id, 'uncertain')
  f.entry.restore()
  await turn()
  assert.equal(f.calls.filter(call => call.name === 'backup.stage').length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(f.entry.selected.value)), ['music'])
})

test('deferred recovery opens a new review through Core without a path or renderer data', async () => {
  const f = fixture()
  f.respond({ id: 'recovered', version: 2, rows: [{ domain: 'music' }], roots: [] })
  f.entry.recoverBackup()
  await turn()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [{ name: 'backup.recover', payload: {} }])
  assert.equal(f.entry.preview.value.id, 'recovered')
  assert.equal(f.entry.needsReview.value, false)
  assert.equal(personalDomainLabel('playlists', 1), '歌单与收藏')
  assert.equal(personalDomainLabel('playlists', 2), '歌单')
})

test('v2 identity reference conflicts block staging music until resolved or explicitly excluded', async () => {
  const f = fixture()
  const preview = {
    id: 'conflicting-identity', version: 2,
    rows: [{ domain: 'music' }, { domain: 'lyrics' }], roots: [],
    music: {
      dependencies: ['music:identity-reference-conflict'],
      referenceConflicts: [{ incomingId: 'artist-old', kind: 'artist', title: '同名人物', targetIds: ['artist-a', 'artist-b'] }]
    }
  }
  f.respond(preview)
  f.entry.importBackup()
  await turn()
  f.entry.restore()
  await turn()
  assert.equal(f.calls.filter(call => call.name === 'backup.stage').length, 0)
  assert.match(f.entry.error.value, /音乐整理.*冲突/)
  assert.equal(f.entry.preview.value.id, preview.id)
  f.entry.selected.value = ['lyrics']
  f.respond({ ...preview, music: undefined })
  f.entry.updatePreview()
  await turn()
  f.respond({ restartRequired: true })
  f.entry.restore()
  await turn()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), {
    name: 'backup.stage', payload: {
      id: preview.id, options: { conflict: 'keep-local', mappings: [], domains: ['lyrics'] }
    }
  })
  assert.equal(f.entry.staged.value, true)
})
