import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createCorePlaybackBookmarks } from './playbackBookmarks.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
test('library bookmark menus consume bounded Core pages without renderer identity keys or persistence', async () => {
  const requests: Array<{ name: string; input: any }> = []
  const state = shallowRef({ phase: 'ready', epoch: 'one', bookmarksRevision: 3 } as unknown as CoreSnapshot)
  const core = { state, query: async (name: string, input: any) => {
    requests.push({ name, input })
    if (name === 'bookmarks.state') return { revision: 3, longTrackResumeSeconds: 2400 }
    const items = Array.from({ length: 201 }, (_, i) => ({ id: `bookmark:${i}`, trackId: `cue:${i}`, title: `Part ${i}`, artist: 'Artist', positionSeconds: i + 30, label: '', kind: i === 200 ? 'resume' : 'manual', createdAt: '2026-01-01', updatedAt: '2026-01-01' }))
    return { revision: 3, total: items.length, offset: input.offset, items: items.slice(input.offset, input.offset + input.limit) }
  }, attach: async () => state.value } as unknown as Pick<CorePlayerClient, 'state' | 'attach' | 'query'>
  const store = createCorePlaybackBookmarks(core)
  try {
    await tick()
    await store.ensureLoaded()
    assert.equal(store.longTrackResumeSeconds.value, 2400)
    assert.equal(store.bookmarksFor({ id: 'cue:0' })[0].id, 'bookmark:0')
    assert.equal(store.resumeBookmarkFor({ id: 'cue:200' })?.id, 'bookmark:200')
    assert.equal(store.bookmarksFor({ id: 'cue:missing' }).length, 0)
    const pages = requests.filter(r => r.name === 'bookmarks.page')
    assert.deepEqual(pages.map(r => r.input.offset), [0, 200])
    assert.equal(pages.every(r => r.input.limit === 200 && r.input.scope === 'all' && r.input.revision === 3), true)
    assert.equal('trackKey' in store.bookmarksFor({ id: 'cue:0' })[0], false)
  } finally { store.dispose() }
})
