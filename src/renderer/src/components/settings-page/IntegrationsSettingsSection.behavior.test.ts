import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, effectScope, ref, watch } from 'vue'

const source = readFileSync(new URL('./IntegrationsSettingsSection.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('integrations.ts', script, ts.ScriptTarget.Latest, true)
const body = ast.statements
  .filter((s) => !ts.isImportDeclaration(s))
  .map((s) => s.getText(ast))
  .join('\n')
const code = ts.transpileModule(
  `${body}\n;({remoteStatus,remoteStatusError,remoteBusy,refreshRemoteStatus,toggleRemote,rotateRemotePin})`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }
).outputText
function fixture(t: test.TestContext) {
  const calls: { name: string; payload: unknown }[] = []
  const emits: unknown[][] = []
  let result: unknown = { enabled: false, urls: [] }
  const scope = effectScope()
  const run = async (name: string, payload: unknown) => {
    calls.push({ name, payload })
    if (result instanceof Error) throw result
    return result
  }
  const entry = scope.run(() =>
    runInNewContext(code, {
      computed,
      ref,
      watch,
      Error,
      defineProps: () => ({ discordEnabled: false, remoteEnabled: false }),
      defineEmits:
        () =>
        (...args: unknown[]) =>
          emits.push(args),
      onMounted() {},
      onBeforeUnmount() {},
      useCoreConnection: () => ({ command: run, query: run }),
      QRCode: { toDataURL: async () => 'data:qr' }
    })
  )!
  t.after(() => scope.stop())
  return {
    entry,
    calls,
    emits,
    respond: (value: unknown) => {
      result = value
    }
  }
}
test('remote settings have one Core writer and preserve returned pairing state', async (t) => {
  const f = fixture(t)
  await f.entry.refreshRemoteStatus()
  f.respond({ enabled: true, urls: ['http://fixture/'], pin: '123456' })
  await f.entry.toggleRemote()
  assert.equal(f.entry.remoteStatus.value.pin, '123456')
  f.respond({ pin: '654321', status: { enabled: true, urls: [], pin: '654321' } })
  await f.entry.rotateRemotePin()
  assert.equal(f.entry.remoteStatus.value.pin, '654321')
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    { name: 'remote.status', payload: {} },
    { name: 'remote.setEnabled', payload: { enabled: true } },
    { name: 'remote.rotatePin', payload: {} }
  ])
  assert.deepEqual(f.emits, [])
  assert.doesNotMatch(script, /window\.api\.remote/)
})
test('remote startup failure stays visible without optimistic settings mutation', async (t) => {
  const f = fixture(t)
  f.respond(new Error('bind failed'))
  await f.entry.toggleRemote()
  assert.equal(f.entry.remoteBusy.value, false)
  assert.equal(f.entry.remoteStatus.value, null)
  assert.equal(f.entry.remoteStatusError.value, 'bind failed')
  assert.deepEqual(f.emits, [])
})
