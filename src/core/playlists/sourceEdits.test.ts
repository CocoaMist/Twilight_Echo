import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData } from '../../shared/track.ts'
import type { UnifiedSearchResult } from '../../shared/unifiedMusicSearch.ts'
import { CorePlaylistSourceEdits } from './sourceEdits.ts'

const original: TrackData = {
  id: 'local:1', source: 'local', title: 'Moon River', artist: 'Singer', album: 'Album',
  duration: 180, filePath: 'D:/Private/song.flac', fileName: 'song.flac', size: 1,
  cover: null, lyrics: null
}
const candidate = { ...original, id: 'ncm:2', source: 'ncm', filePath: 'ncm:2',
  streamUrl: 'https://private.invalid/?token=secret' }
const result = (tracks: TrackData[]): UnifiedSearchResult => ({
  total: tracks.length, health: {}, logicalItems: [], items: tracks.map((track) => ({
    kind: 'track', track, source: track.source!, sourceName: 'Provider', local: false,
    lossless: true, providerAvailable: true, providerReliability: 1
  }))
})

test('source replacement resolves an input in Core and changes only future playlist references', async () => {
  const calls: unknown[] = []
  const signal = new AbortController().signal
  const input = { kind: 'local' as const, id: 'local:1' }
  const service = new CorePlaylistSourceEdits({
    resolve: async (inputs, requestSignal) => {
      assert.deepEqual(inputs, [input]); assert.equal(requestSignal, signal); return [candidate]
    },
    search: async () => { throw Error('unused') },
    replace: async (...args) => { calls.push(args); return { revision: 8, count: 2 } }
  })
  const reply = await service.replace(7, original.id, input, signal)
  assert.deepEqual(calls, [[original.id, candidate, 7, signal]])
  assert.equal(reply.revision, 8)
  assert.equal(reply.count, 2)
  assert.equal(reply.track.id, candidate.id)
  assert.doesNotMatch(JSON.stringify(reply), /filePath|streamUrl|token=secret/)
})

test('manual rematch uses existing metadata ranking and propagates stale revisions without replay', async () => {
  let searches = 0, writes = 0
  const service = new CorePlaylistSourceEdits({
    resolve: async () => [original],
    search: async (query) => { searches++; assert.equal(query, 'Moon River Singer'); return result([
      { ...candidate, id: 'ncm:wrong', title: 'Unrelated' }, candidate
    ]) },
    replace: async (id, track, revision) => {
      writes++; assert.equal(id, original.id); assert.equal(track.id, candidate.id); assert.equal(revision, 5)
      throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
    }
  })
  await assert.rejects(service.rematch(5, { kind: 'local', id: original.id }, new AbortController().signal),
    { code: 'STALE_REVISION' })
  assert.equal(searches, 1)
  assert.equal(writes, 1)
})

test('no match or cancellation leaves playlist ownership unchanged', async () => {
  let writes = 0
  const controller = new AbortController()
  let matches = result([])
  const service = new CorePlaylistSourceEdits({ resolve: async () => [original],
    search: async () => matches,
    replace: async () => { writes++; return { revision: 2, count: 1 } } })
  assert.deepEqual(await service.rematch(1, { kind: 'local', id: original.id }, controller.signal),
    { revision: 1, count: 0, track: null })
  matches = result([candidate]); controller.abort()
  await assert.rejects(service.rematch(1, { kind: 'local', id: original.id }, controller.signal), { name: 'AbortError' })
  assert.equal(writes, 0)
})
