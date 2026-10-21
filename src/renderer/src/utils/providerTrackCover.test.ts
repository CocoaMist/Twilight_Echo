import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music.ts'
import { findExactProviderTrackCover } from './providerTrackCover.ts'

const track: Track = {
  id: 'ncm:42', source: 'ncm', title: 'Song', artist: 'Artist', album: 'Album',
  filePath: 'ncm:42', fileName: 'Song', duration: 180, size: 0, cover: null, lyrics: null
}

test('uses artwork only when the provider returns the exact same track identity', async () => {
  const found = await findExactProviderTrackCover(track, {
    id: 'ncm', name: 'NCM', source: 'internal', capabilities: ['search'],
    searchSongs: async () => ({ items: [{ ...track, cover: 'cover://exact' }], total: 1 })
  })
  assert.deepEqual(found, {
    cover: 'cover://exact', coverSource: 'cover://exact', coverSmall: null, coverSmallSource: 'cover://exact'
  })
})

test('does not borrow a cover from a title-only or different-provider candidate', async () => {
  const found = await findExactProviderTrackCover(track, {
    id: 'ncm', name: 'NCM', source: 'internal', capabilities: ['search'],
    searchSongs: async () => ({
      items: [{ ...track, id: 'ncm:43', cover: 'cover://wrong' }], total: 1
    })
  })
  assert.equal(found, null)
})
