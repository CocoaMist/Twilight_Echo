import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { computed, effectScope, nextTick, ref, watch } from 'vue'

test('database locator resolves unloaded rows on demand and releases its control on mode changes', async () => {
  const source = readFileSync(new URL('./useLocatePlayingTrack.ts', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace('export function', 'function')
  type Action = {
    isVisible(viewport: { top: number; bottom: number }): boolean
    activate(): void
  }
  let action: Action | undefined,
    legacyContainer: { value: unknown } | undefined,
    disposed = 0
  const locate = runInNewContext(`${stripTypeScriptTypes(source)}\nuseLocatePlayingTrack`, {
    computed,
    watch,
    useTrackLocator: (container: { value: unknown }) => {
      legacyContainer = container
    },
    registerScrollToTopCompanion: (_container: unknown, value: Action) => {
      action = value
      return { refresh() {}, dispose: () => disposed++ }
    }
  })
  let row: { getBoundingClientRect(): { top: number; bottom: number } } | null = null
  const container = {},
    databaseEnabled = ref(true),
    enabled = ref(true),
    currentTrack = ref<{ id: string } | null>({ id: 'deep:4200' }),
    requests: string[] = []
  const scope = effectScope()
  scope.run(() =>
    locate({
      containerRef: ref(container),
      tbodyRef: ref({
        querySelector: () => row,
        previousElementSibling: { getBoundingClientRect: () => ({ bottom: 40 }) }
      }),
      displayTracks: ref([]),
      currentTrack,
      enabled,
      rowHeight: 68,
      database: { enabled: databaseEnabled, locate: (id: string) => requests.push(id) }
    })
  )
  try {
    assert.equal(legacyContainer?.value, null)
    assert.ok(action)
    assert.equal(action.isVisible({ top: 0, bottom: 600 }), true)
    action.activate()
    assert.deepEqual(requests, ['deep:4200'])
    row = { getBoundingClientRect: () => ({ top: 100, bottom: 168 }) }
    assert.equal(action.isVisible({ top: 0, bottom: 600 }), false)
    row = { getBoundingClientRect: () => ({ top: -68, bottom: 0 }) }
    assert.equal(action.isVisible({ top: 0, bottom: 600 }), true)
    enabled.value = false
    assert.equal(action.isVisible({ top: 0, bottom: 600 }), false)
    enabled.value = true
    currentTrack.value = null
    assert.equal(action.isVisible({ top: 0, bottom: 600 }), false)
    databaseEnabled.value = false
    await nextTick()
    assert.ok(legacyContainer?.value)
    assert.equal(disposed, 1)
  } finally {
    scope.stop()
  }
})
