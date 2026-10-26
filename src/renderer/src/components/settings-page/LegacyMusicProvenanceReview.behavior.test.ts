import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref, watch } from 'vue'

const source = readFileSync(new URL('./LegacyMusicProvenanceReview.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('review.ts', script, ts.ScriptTarget.Latest, true)
const body = ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join('\n')
const code = ts.transpileModule(`${body}\n({plugins,pluginId,page,includeReviewed,busy,error,message,uncertain,open,refresh,expand,review})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const item = (truncated = false) => ({ albumId: 'old-album', snapshotRevision: -1, title: 'Old album', description: 'Old body', truncated, sourceName: 'Old provider', disposition: 'pending' })
function fixture() {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = []
  const state = ref({ epoch: 'first' })
  let command: (payload: Record<string, unknown>) => Promise<unknown> = async () => ({ revision: 8, total: 1, offset: 0, items: [item()] })
  const entry = runInNewContext(code, {
    ref, watch, Map, Object, Error,
    useCoreConnection: () => ({
      state,
      query: async (name: string, payload: Record<string, unknown>) => {
        calls.push({ name, payload })
        return [{ pluginId: 'rhine', name: 'Rhine', permissions: ['library:write'] }]
      },
      command: async (name: string, payload: Record<string, unknown>) => {
        calls.push({ name, payload })
        return command(payload)
      }
    })
  })
  return { entry, calls, state, respond(action: typeof command) { command = action } }
}
test('review entry explicitly reads a bounded list through the existing Core music API', async () => {
  const f = fixture()
  assert.equal(f.calls.length, 0)
  f.entry.open()
  await turn()
  assert.equal(f.calls[0].name, 'extensions.experiences')
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), { name: 'extensions.music', payload: {
    id: 'rhine', operation: 'provenance.list', args: { offset: 0, limit: 10, includeReviewed: false }
  } })
  assert.equal(f.entry.page.value.total, 1)
  assert.match(source, /LegacyMusicProvenanceItem/)
  assert.match(source, /确认有权迁移/)
})
test('long previews require full text and preserve exact body and revision in explicit confirmation', async () => {
  const f = fixture()
  f.respond(async payload => payload.operation === 'provenance.read'
    ? { revision: 8, item: { ...item(), description: 'Exact full body' } }
    : { revision: 8, total: 1, offset: 0, items: [item(true)] })
  f.entry.open()
  await turn()
  const target = f.entry.page.value.items[0]
  f.entry.review(target, 'manual')
  await turn()
  assert.equal(f.calls.length, 2)
  f.entry.expand(target)
  await turn()
  assert.equal(target.truncated, false)
  f.entry.review(target, 'manual')
  await turn()
  const review = f.calls.find(call => call.payload.operation === 'provenance.review')!
  assert.deepEqual(JSON.parse(JSON.stringify(review.payload.args)), {
    expectedRevision: 8, albumId: 'old-album', snapshotRevision: -1, description: 'Exact full body', disposition: 'manual'
  })
})
test('unknown write is never replayed and requires an explicit reread', async () => {
  const f = fixture()
  f.entry.open()
  await turn()
  f.respond(async payload => {
    if (payload.operation === 'provenance.review') throw new Error('Reply lost')
    return { revision: 9, total: 0, offset: 0, items: [] }
  })
  f.entry.review(f.entry.page.value.items[0], 'excluded')
  await turn()
  assert.equal(f.entry.uncertain.value, true)
  const count = f.calls.length
  f.entry.review(f.entry.page.value.items[0], 'excluded')
  await turn()
  assert.equal(f.calls.length, count)
  f.entry.refresh()
  await turn()
  assert.equal(f.entry.uncertain.value, false)
  assert.equal(f.entry.page.value.total, 0)
})
test('Core reconnect withdraws the old review and rejects late reads without auto requests', async () => {
  const f = fixture()
  f.entry.open()
  await turn()
  let resolve!: (value: unknown) => void
  f.respond(() => new Promise(done => { resolve = done }))
  f.entry.refresh()
  await turn()
  const count = f.calls.length
  f.state.value = { epoch: 'second' }
  assert.equal(f.entry.page.value, null)
  resolve({ revision: 8, total: 1, offset: 0, items: [item()] })
  await turn()
  assert.equal(f.entry.page.value, null)
  assert.equal(f.calls.length, count)
  assert.match(f.entry.error.value, /重新连接/)
})
