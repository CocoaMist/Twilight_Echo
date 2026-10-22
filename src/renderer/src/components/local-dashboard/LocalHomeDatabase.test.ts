import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { createLibraryHomeStatus } from '../../stores/library/libraryHomeStatus.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const metadata = (revision: number, trackCount: number) => ({
  revision,
  trackCount,
  fileCount: trackCount,
  folders: [],
  exclusions: []
})

test('home status serializes scan storms, discards superseded revisions and stops at unmount', async () => {
  let calls = 0,
    complete!: (value: ReturnType<typeof metadata>) => void
  const home = createLibraryHomeStatus({
    getStorageMode: async () => 'sqlite',
    api: {
      getMetadata: async () => {
        calls++
        return new Promise((resolve) => {
          complete = resolve
        })
      }
    }
  })
  home.refresh()
  await tick()
  assert.equal(calls, 1)
  for (let revision = 1; revision <= 500; revision++) home.refresh(revision)
  assert.equal(calls, 1)
  complete(metadata(1, 100))
  await tick()
  assert.equal(home.state.value.total, null)
  assert.equal(calls, 2)
  complete(metadata(500, 405))
  await tick()
  assert.equal(home.state.value.total, 405)
  for (let i = 0; i < 500; i++) home.refresh(500)
  assert.equal(calls, 2)
  home.refresh(501)
  home.refresh(502)
  home.dispose()
  complete(metadata(501, 0))
  await tick()
  assert.equal(home.state.value.total, 405)
  assert.equal(calls, 3)
})

test('production home routing distinguishes unloaded SQLite from empty JSON and exposes retry', async () => {
  const source = readFileSync(new URL('./LocalHome.vue', import.meta.url), 'utf8')
  const ast = ts.createSourceFile(
    'home.ts',
    source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1],
    ts.ScriptTarget.Latest,
    true
  )
  const script = ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
  for (const mode of ['sqlite', 'json'] as const) {
    let fail = mode === 'sqlite',
      reads = 0,
      closed = 0,
      callback: (() => void) | undefined
    const mounts: Array<() => void> = [],
      unmounts: Array<() => void> = []
    const tracks = ref<unknown[]>([])
    const entry = runInNewContext(
      ts.transpileModule(script + '\n;({home,homeState,emptyLibrary,homePending})', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
      }).outputText,
      {
        computed,
        defineAsyncComponent: () => ({}),
        onMounted: (fn: () => void) => mounts.push(fn),
        onBeforeUnmount: (fn: () => void) => unmounts.push(fn),
        defineProps: () => ({}),
        defineEmits: () => () => {},
        useThemeStore: () => ({ presetLayout: ref('default') }),
        useMusicStore: () => ({
          tracks:
            mode === 'json'
              ? tracks
              : {
                  get value(): never {
                    throw new Error('full renderer library access')
                  }
                }
        }),
        createLibraryHomeStatus,
        window: {
          api: {
            library: {
              getStorageMode: async () => {
                if (fail) throw new Error('discovery offline')
                return mode
              },
              onChanged: (listener: () => void) => {
                callback = listener
                return () => {
                  closed++
                }
              },
              database: {
                getMetadata: async () => {
                  reads++
                  return metadata(reads, reads === 1 ? 405 : 0)
                }
              }
            }
          }
        }
      }
    ) as {
      home: ReturnType<typeof createLibraryHomeStatus>
      homeState: { value: { error: string } }
      emptyLibrary: { value: boolean }
      homePending: { value: boolean }
    }
    assert.equal(entry.homePending.value, true)
    for (const mount of mounts) mount()
    await tick()
    if (mode === 'sqlite') {
      assert.equal(entry.homeState.value.error, 'discovery offline')
      assert.equal(entry.emptyLibrary.value, false, 'discovery failure is not an empty library')
      fail = false
      entry.home.refresh()
      await tick()
      assert.equal(entry.homeState.value.error, '')
      assert.equal(
        entry.emptyLibrary.value,
        false,
        'SQL count selects the local dashboard with no compatibility tracks'
      )
      callback!()
      await tick()
      assert.equal(entry.emptyLibrary.value, true, 'a confirmed empty database selects online home')
    } else {
      assert.equal(entry.emptyLibrary.value, true)
      tracks.value = [{}]
      assert.equal(entry.emptyLibrary.value, false)
      assert.equal(reads, 0)
    }
    assert.equal(entry.homePending.value, false)
    for (const unmount of unmounts) unmount()
    assert.equal(closed, 1)
    const previous = reads
    callback!()
    await tick()
    assert.equal(reads, previous)
  }
  assert.match(source, /v-else-if="!preview && emptyLibrary"/)
})
