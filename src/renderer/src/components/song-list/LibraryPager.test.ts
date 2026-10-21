import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref, watch } from 'vue'

// Production pager state/events; DOM and actual focus behavior remain a UI check.
test('library pager clamps visible input, rejects non-integer input and preserves zero-based navigation', () => {
  const props = { page: 2, total: 605, loading: false, label: '歌曲', size: 200 }
  const calls: Array<[string, number]> = []
  const source = readFileSync(new URL('./LibraryPager.vue', import.meta.url), 'utf8').match(
    /<script\b[^>]*>([\s\S]*?)<\/script>/
  )![1]
  const ast = ts.createSourceFile('pager.ts', source, ts.ScriptTarget.Latest, true)
  const body = ast.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(ast))
    .join('\n')
  const stops: Array<() => void> = []
  const entry = runInNewContext(
    ts.transpileModule(body + '\n({navigate, selected, pageCount})', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
    {
      computed,
      ref,
      LIBRARY_PAGE_SIZE: 200,
      watch: (...args: Parameters<typeof watch>) => {
        const stop = watch(...args)
        stops.push(stop)
        return stop
      },
      defineProps: () => props,
      withDefaults: (value: unknown) => value,
      defineEmits: () => (event: string, page: number) => calls.push([event, page])
    }
  )
  entry.navigate(999)
  assert.equal(entry.selected.value, 4)
  assert.deepEqual(calls.pop(), ['page', 3])
  entry.navigate(0)
  assert.equal(entry.selected.value, 1)
  assert.deepEqual(calls.pop(), ['page', 0])
  entry.navigate(2.5)
  assert.equal(entry.selected.value, 3)
  entry.navigate(3)
  assert.equal(calls.length, 0, 'same page must not issue a duplicate request')
  for (const stop of stops) stop()
})
