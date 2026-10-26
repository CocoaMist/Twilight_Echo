import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'
import { coreLibraryFixture } from '../stores/coreLibraryTestFixture.ts'
import type { UnifiedMusicSearchState } from './useUnifiedMusicSearch.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('production unified search queries Core with an empty renderer, coalesces state refreshes, keeps deep offsets and cancels on unmount', async (t) => {
  const f = await coreLibraryFixture(t, {
    tracks: Array.from({ length: 405 }, (_, i) => ({
      id: `local:${i}`,
      filePath: `D:/Music/${i}.flac`,
      title: `晴天 ${String(i).padStart(4, '0')}`,
      artist: '周杰伦',
      album: 'Album',
      source: 'local',
      format: 'flac'
    }))
  })
  const scope = vue.effectScope(),
    unmounts: Array<() => void> = []
  t.after(() => {
    unmounts.forEach((unmount) => unmount())
    scope.stop()
  })
  const exports: { useUnifiedMusicSearch?: () => UnifiedMusicSearchState } = {}
  const dependencies: Record<string, unknown> = {
    vue: { ...vue, onBeforeUnmount: (fn: () => void) => unmounts.push(fn) },
    '../stores/coreConnection.ts': { useCoreConnection: () => f.core }
  }
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('./useUnifiedMusicSearch.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }
    ).outputText,
    {
      exports,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      AbortController,
      DOMException,
      queueMicrotask,
      Error
    }
  )
  const search = scope.run(() => exports.useUnifiedMusicSearch!())!
  assert.equal(f.queries.length, 0, 'an unused search must not hydrate local data')
  await search.search('晴天', { limit: 20, offset: 200 })
  assert.equal(search.total.value, 405)
  assert.equal(search.items.value[0].track.id, 'local:200')
  assert.equal('filePath' in search.items.value[0].track, false)
  assert.equal(f.queries.length, 1)
  // Keep this edit inside the same relevance window; a longer title may
  // legitimately move outside the deep page under the relevance ranking.
  const saved = f.db.patchTracks([
    { id: 'local:210', expectedVersion: 1, patch: { title: '晴天 021X' } }
  ])
  for (let i = 0; i < 500; i++) f.publish({ libraryRevision: saved.revision })
  for (let i = 0; i < 50 && (search.loading.value || f.queries.length < 2); i++) await tick()
  assert.equal(search.error.value, '')
  assert.equal(f.queries.length, 2)
  assert.equal((f.queries[1].payload as { offset: number }).offset, 200)
  assert.equal(
    search.items.value.find((item) => item.track.id === 'local:210')?.track.title,
    '晴天 021X'
  )
  unmounts.splice(0).forEach((unmount) => unmount())
  assert.equal(search.items.value.length, 0)
  search.refresh()
  f.publish({ libraryRevision: saved.revision + 1 })
  await tick()
  assert.equal(f.queries.length, 2)
  assert.deepEqual(f.commands, [])
})
