import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, shallowRef } from 'vue'
import { createCoreLyricsManagement } from './lyricsManagement.ts'
import { DEFAULT_LYRICS_MANAGEMENT } from '../../../shared/lyricsManagement.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreLyricsMutation, CoreLyricsState } from '../../../shared/coreLyrics.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'

const turn = async () => { await nextTick(); await new Promise<void>((resolve) => setImmediate(resolve)) }
function fixture(t: test.TestContext) {
  const state = shallowRef({ phase: 'ready', epoch: 'one', lyricsRevision: 3, lyricsContentRevision: 1,
    track: { id: 'song' }, queue: { occurrenceId: 'second' } } as CoreSnapshot)
  let authority: CoreLyricsState = { revision: 3, contentRevision: 1,
    preferences: { ...DEFAULT_LYRICS_MANAGEMENT }, current: { trackId: 'song', occurrenceId: 'second' },
    loadState: { trackId: 'song', status: 'ready' }, error: null }
  const calls: { name: string; payload: unknown }[] = []
  let reject = false
  const core: Pick<CorePlayerClient, 'state' | 'attach' | 'command' | 'query'> = {
    state, attach: async () => state.value!,
    query: async (name, payload) => {
      calls.push({ name, payload })
      if (name === 'lyrics.state') return structuredClone(authority) as never
      if (name === 'lyrics.current') return { revision: authority.revision, contentRevision: 1,
        current: authority.current, automatic: null, effective: null, override: null, offsetSeconds: 0 } as never
      return { candidates: [] } as never
    },
    command: async (name, payload) => {
      calls.push({ name, payload })
      if (name !== 'lyrics.edit') return null
      const mutation = payload as CoreLyricsMutation
      if (reject || mutation.revision !== authority.revision) {
        reject = false
        throw Object.assign(new Error('Lyrics changed; read fresh state'), { code: 'STALE_REVISION' })
      }
      if (mutation.edit.kind === 'visibility') Object.assign(authority.preferences, mutation.edit.patch)
      if (mutation.edit.kind === 'globalOffset') authority.preferences.globalOffsetMs = mutation.edit.offsetMs
      authority.revision++
      return structuredClone(authority)
    }
  }
  const store = createCoreLyricsManagement(core)
  t.after(store.dispose)
  return { store, state, calls, authority: () => authority,
    change: (patch: Partial<CoreLyricsState>) => { authority = { ...authority, ...patch } },
    reject: () => { reject = true } }
}

test('lyrics controls project Core preferences and issue focused edits without a document writer', async (t) => {
  const f = fixture(t)
  await f.store.ensureLoaded()
  assert.equal(f.calls.some((call) => call.name === 'lyrics.edit'), false)
  await f.store.updateVisibility({ showOriginal: false, showRomanization: true })
  assert.equal(f.store.document.value.showOriginal, false)
  assert.equal(f.store.document.value.showTranslation, true)
  assert.equal(f.store.document.value.showRomanization, true)
  assert.deepEqual(f.calls.find((call) => call.name === 'lyrics.edit')?.payload, {
    revision: 3, edit: { kind: 'visibility', patch: { showOriginal: false, showRomanization: true } }
  })
  assert.deepEqual(f.store.document.value.tracks, {})
})

test('CAS rejection refreshes authority without replaying a stale focused edit', async (t) => {
  const f = fixture(t)
  await f.store.ensureLoaded()
  f.change({ revision: 4, preferences: { ...f.authority().preferences, globalOffsetMs: 875, showTranslation: false } })
  f.reject()
  await assert.rejects(f.store.updateGlobalOffset(-200), /Lyrics changed/)
  assert.equal(f.store.document.value.globalOffsetMs, 875)
  assert.equal(f.store.document.value.showTranslation, false)
  assert.equal(f.calls.filter((call) => call.name === 'lyrics.edit').length, 1)
  await f.store.updateGlobalOffset(-200)
  assert.equal(f.store.globalOffsetMs.value, -200)
  assert.equal(f.store.error.value, null)
})

test('draft edits retain their read revision and Core search uses occurrence identity', async (t) => {
  const f = fixture(t)
  await f.store.ensureLoaded()
  const draftRevision = f.store.getRevision()
  f.change({ revision: 4 })
  f.state.value = { ...f.state.value!, lyricsRevision: 4 }
  await turn()
  await assert.rejects(f.store.updateTrack('song', { original: 'draft' }, draftRevision), /Lyrics changed/)
  assert.equal((f.calls.find((call) => call.name === 'lyrics.edit')?.payload as CoreLyricsMutation).revision, 3)
  await f.store.search()
  assert.deepEqual(f.calls.at(-1), { name: 'lyrics.search', payload: { trackId: 'song', occurrenceId: 'second' } })
})
