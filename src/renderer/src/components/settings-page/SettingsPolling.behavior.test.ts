import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import {
  computed,
  createRenderer,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch
} from 'vue'
import { useVisibleSettingsPolling } from './useVisibleSettingsPolling.ts'

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await nextTick()
}

function scriptBody(path: URL): string {
  const source = readFileSync(path, 'utf8').match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('settings.ts', source, ts.ScriptTarget.Latest, true)
  return ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
}

function libraryScript(path: URL): string {
  const source = scriptBody(path)
  const ast = ts.createSourceFile('settings.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = ast.statements
    .filter((node) =>
      ts.isFunctionDeclaration(node)
        ? node.name?.text === 'refreshLibraryWatcherStatus'
        : ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((declaration) =>
            ['libraryWatcherStatus', 'libraryWatcherStatusTimer'].includes(
              declaration.name.getText(ast)
            )
          )
    )
    .map((node) => node.getText(ast))
    .join('\n')
  const pollingCall = ast.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'useVisibleSettingsPolling'
  )
  if (pollingCall) return `${declarations}\n${pollingCall.getText(ast)}`
  const start = source.indexOf('await refreshLibraryWatcherStatus()')
  const end = source.indexOf('await nextTick()', start)
  assert.ok(
    start >= 0 && end > start,
    'baseline still contains its original library polling lifecycle'
  )
  return `${declarations}\nonMounted(async () => { ${source.slice(start, end)} })`
}

type Kind = 'diagnostics' | 'connections' | 'library'
function fixture(
  kind: Kind,
  options: { active?: boolean; baseline?: boolean; deferred?: boolean } = {}
) {
  const props = reactive({ active: options.active, discordEnabled: true, remoteEnabled: false })
  const activeSection = ref(options.active === false ? 'general' : 'library')
  const counters = { diagnostics: 0, discord: 0, remote: 0, library: 0 }
  const pending: Array<(result: object) => void> = []
  const native = (key: keyof typeof counters) => async () => {
    ++counters[key]
    return options.deferred
      ? new Promise<object>((resolve) => pending.push(resolve))
      : { bytes: counters[key], connected: false, urls: [], entries: [] }
  }
  let now = 0
  let timerId = 0
  const timers = new Map<number, { at: number; every: number; callback: () => void }>()
  const schedule = (callback: () => void, ms: number, every = 0): number => {
    timers.set(++timerId, { at: now + ms, every, callback })
    return timerId
  }
  const setTimeout = (callback: () => void, ms: number): number => schedule(callback, ms)
  const setInterval = (callback: () => void, ms: number): number => schedule(callback, ms, ms)
  const clear = (id: number): void => {
    timers.delete(id)
  }
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const oldSetTimeout = globalThis.setTimeout
  const oldClearTimeout = globalThis.clearTimeout
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  globalThis.setTimeout = setTimeout as unknown as typeof globalThis.setTimeout
  globalThis.clearTimeout = clear as unknown as typeof globalThis.clearTimeout
  const relative =
    kind === 'library'
      ? '../SettingsPage.vue'
      : kind === 'diagnostics'
        ? './DiagnosticsSettingsSection.vue'
        : './IntegrationsSettingsSection.vue'
  const baselineName =
    kind === 'library'
      ? 'SettingsPage.vue'
      : kind === 'diagnostics'
        ? 'DiagnosticsSettingsSection.vue'
        : 'IntegrationsSettingsSection.vue'
  const path = options.baseline
    ? new URL(
        `../../../../../.local/neo-perf-20261022/settings-polling-baseline/${baselineName}`,
        import.meta.url
      )
    : new URL(relative, import.meta.url)
  const body = kind === 'library' ? libraryScript(path) : scriptBody(path)
  const expose =
    kind === 'diagnostics'
      ? '{ status, note, refresh }'
      : kind === 'library'
        ? '{ status: libraryWatcherStatus }'
        : '{ status: discordStatus, remoteStatus }'
  let view!: { status: { value: unknown }; note?: { value: string } }
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null
  })
  const app = renderer.createApp({
    setup() {
      view = runInNewContext(
        ts.transpileModule(`${body}\n;(${expose})`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
        }).outputText,
        {
          computed,
          ref,
          watch,
          onMounted,
          onUnmounted,
          onBeforeUnmount,
          useVisibleSettingsPolling,
          activeSection,
          settingsDisposed: false,
          document,
          defineProps: () => props,
          defineEmits: () => () => {},
          QRCode: { toDataURL: async () => '' },
          window: {
            setTimeout,
            clearTimeout: clear,
            setInterval,
            clearInterval: clear,
            api: {
              diagnostics: { getStatus: native('diagnostics') },
              discord: { getStatus: native('discord') },
              remote: { getStatus: native('remote') },
              library: { getWatcherStatus: native('library') }
            }
          },
          setTimeout,
          clearTimeout: clear,
          setInterval,
          clearInterval: clear
        }
      )
      return () => h('div')
    }
  })
  app.mount({})
  return {
    props,
    activeSection,
    counters,
    pending,
    timers,
    view,
    async advance(ms: number) {
      await tick()
      const end = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        now = next[1].at
        if (next[1].every) next[1].at += next[1].every
        else timers.delete(next[0])
        next[1].callback()
        await tick()
      }
      now = end
    },
    visibility(hidden: boolean) {
      document.visibilityState = hidden ? 'hidden' : 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    },
    dispose() {
      app.unmount()
      globalThis.setTimeout = oldSetTimeout
      globalThis.clearTimeout = oldClearTimeout
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  }
}

for (const kind of ['diagnostics', 'connections', 'library'] as const) {
  test(`${kind}: hidden category has zero status requests, entry refreshes, and document hidden pauses`, async () => {
    const f = fixture(kind, { active: false })
    try {
      await f.advance(60_000)
      assert.deepEqual(f.counters, { diagnostics: 0, discord: 0, remote: 0, library: 0 })
      assert.equal(f.timers.size, 0)
      f.props.active = true
      f.activeSection.value = 'library'
      await tick()
      assert.equal(f.counters[kind === 'connections' ? 'discord' : kind], 1)
      if (kind === 'connections') assert.equal(f.counters.remote, 1)
      f.visibility(true)
      await f.advance(60_000)
      assert.equal(f.counters[kind === 'connections' ? 'discord' : kind], 1)
      assert.equal(f.timers.size, 0)
      f.visibility(false)
      await tick()
      assert.equal(f.counters[kind === 'connections' ? 'discord' : kind], 2)
    } finally {
      f.dispose()
    }
  })

  test(`${kind}: late responses after category switch cannot update state or recreate a timer`, async () => {
    const f = fixture(kind, { deferred: true })
    try {
      await tick()
      f.props.active = false
      f.activeSection.value = 'general'
      for (const resolve of f.pending) resolve({ bytes: 123, connected: true })
      await tick()
      assert.equal(f.view.status.value, null)
      assert.equal(f.timers.size, 0)
    } finally {
      f.dispose()
    }
  })
}

test('standalone diagnostics and connections remain active by default and diagnostics drafts survive hiding', async () => {
  for (const kind of ['diagnostics', 'connections'] as const) {
    const f = fixture(kind)
    try {
      await tick()
      assert.equal(f.counters[kind === 'connections' ? 'discord' : kind], 1)
      if (f.view.note) f.view.note.value = '未提交的问题说明'
      f.props.active = false
      await f.advance(60_000)
      f.props.active = true
      await tick()
      if (f.view.note) assert.equal(f.view.note.value, '未提交的问题说明')
    } finally {
      f.dispose()
    }
  }
})

test('connections preserves remote one-shot refresh and polls Discord only while enabled', async () => {
  const f = fixture('connections')
  try {
    await f.advance(60_000)
    assert.equal(f.counters.discord, 8)
    assert.equal(f.counters.remote, 1)
    f.props.discordEnabled = false
    await tick()
    const disabledCalls = f.counters.discord
    await f.advance(60_000)
    assert.equal(f.counters.discord, disabledCalls)
  } finally {
    f.dispose()
  }
})

test('settings category visibility is forwarded through the still-mounted section hierarchy', () => {
  const page = readFileSync(new URL('../SettingsPage.vue', import.meta.url), 'utf8')
  for (const [component, section] of [
    ['ConnectionsSettingsSection', 'connections'],
    ['SystemSettingsSection', 'system']
  ]) {
    const tag = page.match(new RegExp(`<${component}\\b[^>]*>`))?.[0] ?? ''
    assert.ok(tag.includes(`v-show="activeSection === '${section}'"`))
    assert.ok(tag.includes(`:active="activeSection === '${section}'"`))
  }
  for (const [parent, child] of [
    ['SystemSettingsSection', 'DiagnosticsSettingsSection'],
    ['ConnectionsSettingsSection', 'IntegrationsSettingsSection']
  ]) {
    const source = readFileSync(new URL(`./${parent}.vue`, import.meta.url), 'utf8')
    const tag = source.match(new RegExp(`<${child}\\b[^>]*>`))?.[0] ?? ''
    assert.ok(tag.includes(':active="active ?? true"'))
  }
})

if (process.env.NEO_SETTINGS_POLLING_REPORT) {
  test('capture reproducible hidden-category 60 second request counts before and after', async () => {
    const counts: Record<string, unknown> = {}
    for (const baseline of [true, false]) {
      const totals = { diagnostics: 0, discord: 0, remote: 0, library: 0 }
      for (const kind of ['diagnostics', 'connections', 'library'] as const) {
        const f = fixture(kind, { baseline, active: false })
        try {
          await f.advance(60_000)
          for (const key of Object.keys(totals) as Array<keyof typeof totals>)
            totals[key] += f.counters[key]
        } finally {
          f.dispose()
        }
      }
      counts[baseline ? 'before' : 'after'] = totals
    }
    writeFileSync(
      process.env.NEO_SETTINGS_POLLING_REPORT!,
      JSON.stringify(
        {
          scenario:
            'settings mounted on General category for 60 seconds; Discord enabled; document visible',
          clock: 'virtual time; real Vue component mount/unmount hooks and source status callbacks',
          counts
        },
        null,
        2
      ) + '\n'
    )
  })
}
