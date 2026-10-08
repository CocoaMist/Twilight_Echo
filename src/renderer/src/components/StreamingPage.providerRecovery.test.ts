import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { effectScope, nextTick, reactive, ref, watch } from 'vue'

const source = readFileSync(new URL('./StreamingPage.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true)
const recoveryNodes = ast.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === 'refreshStreamingSurface') ||
    (ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'watch' &&
      ['ncmNavigationAvailable', '() => props.active'].includes(
        node.expression.arguments[0]?.getText(ast)
      ))
)
const code = ts.transpileModule(recoveryNodes.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function fixture(t: { after: (fn: () => void) => void }) {
  const calls: string[] = []
  const ncmNavigationAvailable = ref(false)
  const activeProvider = ref('ncm')
  const props = reactive({ active: true })
  const bindings = {
    watch,
    ncmNavigationAvailable,
    activeProvider,
    props,
    NCM_PROVIDER_ID: 'ncm',
    activeTab: ref('library'),
    checkLogin: async () => {
      calls.push('login')
    },
    ensureLibraryLoaded: async () => {
      calls.push('library')
    },
    refreshExternalProviderState: async () => {
      calls.push('external')
    },
    loadRecommendations: async () => {
      calls.push('home')
    },
    discovery: {
      ensureLoaded: async () => {
        calls.push('discovery')
      }
    },
    isLoggedIn: ref(true),
    cloudSongs: ref([]),
    refreshCloudSongs: async () => {
      calls.push('cloud')
    }
  }
  const scope = effectScope()
  scope.run(() => runInNewContext(code, bindings))
  t.after(() => scope.stop())
  return { calls, ncmNavigationAvailable, activeProvider, props }
}

async function flush() {
  await nextTick()
  await new Promise<void>((done) => setImmediate(done))
}

test('late NCM registration restores the visible library without leaving the page', async (t) => {
  const f = fixture(t)
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'])
  f.ncmNavigationAvailable.value = false
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'], 'disabling must not wake the plugin')
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library', 'login', 'library'])
})

test('registration on an inactive page defers recovery until the user opens it', async (t) => {
  const f = fixture(t)
  f.props.active = false
  await flush()
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, [])
  f.props.active = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'])
})

test('NCM registration leaves the selected external provider alone', async (t) => {
  const f = fixture(t)
  f.activeProvider.value = 'bili'
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, [])
})
