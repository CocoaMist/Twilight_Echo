import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import type { EntityMetadataDetail, EntityMetadataArtworkOverride, EntityMetadataSourcePreference } from '../../../../shared/entityMetadata.ts'
import { createEntityPersonalMetadataEditor } from './entityPersonalMetadataEditor.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
const detail = (revision = 0): EntityMetadataDetail => ({ entityId: 'artist', revision, targetId: null,
  link: null, name: 'Artist', introduction: null, override: null, facts: [], sourcePreference: { provider: null, available: true } })
function fixture(t: test.TestContext, write?: () => Promise<unknown>) {
  const current = shallowRef<EntityMetadataDetail | null>(detail()), selected = ref('artist'), scope = ref('local')
  const calls: Array<EntityMetadataArtworkOverride | EntityMetadataSourcePreference> = []
  let reads = 0
  const editor = createEntityPersonalMetadataEditor({ scope: () => scope.value, selected: () => selected.value,
    detail: () => current.value, available: () => true, language: () => 'en',
    sourcePreference: async request => { calls.push(request); return write?.() },
    artworkOverride: async request => { calls.push(request); return write?.() }, refresh: async () => { reads++ } })
  t.after(editor.dispose)
  return { editor, current, selected, scope, calls, reads: () => reads }
}

test('personal image draft reads and validates owned bytes, saves once and re-reads rather than displaying command results', async t => {
  const f = fixture(t)
  await f.editor.loadArtwork({ size: 68, type: 'image/png' }, async () => png)
  assert.equal(f.editor.canSubmit.value, true)
  await f.editor.submit()
  assert.deepEqual(f.calls, [{ entityId: 'artist', revision: 0, language: 'en', mode: 'value', dataUrl: png }])
  assert.equal(f.reads(), 1)
  assert.equal(f.editor.state.value.mode, null)
  await f.editor.loadArtwork({ size: 68, type: 'image/svg+xml' }, async () => png)
  assert.equal(f.editor.canSubmit.value, false)
  assert.match(f.editor.state.value.error, /PNG/)
})

test('unknown preference writes preserve the draft and never replay until explicit latest-state review', async t => {
  const f = fixture(t, async () => { throw new Error('lost ack') })
  f.editor.provider('wikipedia')
  await f.editor.submit(); await f.editor.submit()
  assert.equal(f.calls.length, 1)
  assert.equal(f.editor.state.value.provider, 'wikipedia')
  assert.equal(f.editor.needsReview.value, true)
  assert.equal(f.reads(), 1)
  f.current.value = detail(1)
  assert.equal(f.editor.canSubmit.value, false)
  f.editor.acceptLatest()
  assert.equal(f.editor.canSubmit.value, true)
  await f.editor.submit()
  assert.equal(f.calls[1].revision, 1)
})

test('reading another image or changing context cannot attach late bytes to a new entity', async t => {
  const f = fixture(t)
  let resolve!: (value: string) => void
  const loading = f.editor.loadArtwork({ size: 68, type: 'image/png' }, () => new Promise(r => { resolve = r }))
  f.scope.value = 'streaming'
  resolve(png); await loading
  assert.equal(f.editor.state.value.mode, null)
  assert.equal(f.editor.state.value.dataUrl, '')
  assert.equal(f.calls.length, 0)
})

test('clear and reset need explicit submission and background revision changes retain the chosen action', async t => {
  const f = fixture(t)
  f.editor.begin('clear')
  f.current.value = detail(1)
  await f.editor.submit()
  assert.equal(f.calls.length, 0)
  f.editor.acceptLatest(); await f.editor.submit()
  assert.deepEqual(f.calls[0], { entityId: 'artist', revision: 1, language: 'en', mode: 'clear' })
  f.editor.begin('reset'); await f.editor.submit()
  assert.deepEqual(f.calls[1], { entityId: 'artist', revision: 1, language: 'en', mode: 'reset' })
})
