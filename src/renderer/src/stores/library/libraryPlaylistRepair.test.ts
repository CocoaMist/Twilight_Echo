import assert from 'node:assert/strict'
import test from 'node:test'
import { findLibraryPlaylistRelocations } from './libraryPlaylistRepair.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'
import type {
  LibraryPlaylistRepairApi,
  LibraryPlaylistRepairRequest
} from '../../../../shared/playlistRepair.ts'

const track = (i: number): Track => ({
  id: `old:${i}`,
  filePath: `D:/Old/${i}.flac`,
  fileName: `${i}.flac`,
  title: `Song ${i}`,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  size: 1,
  cover: 'data:image/png;base64,large',
  lyrics: 'heavy'
})

test('folder repair supports playlists above the import limit using one 200-identity RPC at a time, without candidate arrays', async () => {
  let active = 0,
    peak = 0,
    maximum = 0,
    batches = 0,
    closed = 0
  const missing = Array.from({ length: 20005 }, (_, i) => track(i))
  const api: LibraryPlaylistRepairApi = {
    async repairPlaylist(request) {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      try {
        if (request.kind === 'open') return { kind: 'ready', id: 'r', candidateCount: 300000 }
        if (request.kind === 'close') {
          closed++
          return { kind: 'closed', id: request.id }
        }
        batches++
        maximum = Math.max(maximum, request.missing.length)
        for (const identity of request.missing) {
          assert.deepEqual(
            Object.keys(identity).sort(),
            ['id', 'filePath', 'fileName', 'title', 'artist', 'duration'].sort()
          )
        }
        return {
          kind: 'resolved',
          id: request.id,
          sequence: request.sequence,
          result: {
            relocations: [],
            ambiguousTrackIds: [],
            unresolvedTrackIds: request.missing.map((item) => item.id)
          }
        }
      } finally {
        active--
      }
    }
  }
  const result = await findLibraryPlaylistRelocations(missing, 'E:/Moved', api)
  assert.equal(result.unresolvedTrackIds.length, 20005)
  assert.equal(batches, 101)
  assert.equal(maximum, 200)
  assert.equal(peak, 1)
  assert.equal(closed, 1)
})

for (const reason of ['unknown-reply', 'wrong-sequence'] as const)
  test(`${reason} stops resolution immediately, discards the session and returns no partial repair`, async () => {
    const requests: LibraryPlaylistRepairRequest[] = []
    const api: LibraryPlaylistRepairApi = {
      async repairPlaylist(request) {
        requests.push(request)
        if (request.kind === 'open') return { kind: 'ready', id: 'r', candidateCount: 400 }
        if (request.kind === 'close') return { kind: 'closed', id: request.id }
        if (request.sequence === 2 && reason === 'unknown-reply') throw new Error('reply lost')
        return {
          kind: 'resolved',
          id: request.id,
          sequence: reason === 'wrong-sequence' ? 7 : request.sequence,
          result: {
            relocations: [],
            ambiguousTrackIds: [],
            unresolvedTrackIds: request.missing.map((item) => item.id)
          }
        }
      }
    }
    await assert.rejects(
      findLibraryPlaylistRelocations(
        Array.from({ length: 605 }, (_, i) => track(i)),
        'E:/Moved',
        api
      ),
      /reply lost|已失效/
    )
    assert.equal(requests.at(-1)?.kind, 'close')
    assert.equal(
      requests.filter((item) => item.kind === 'resolve').length,
      reason === 'unknown-reply' ? 2 : 1
    )
  })

test('no missing tracks does not scan a directory or open a repair session', async () => {
  assert.deepEqual(
    await findLibraryPlaylistRelocations([], 'E:/Moved', {
      repairPlaylist: async () => {
        throw new Error('unexpected scan')
      }
    }),
    { relocations: [], unresolvedTrackIds: [], ambiguousTrackIds: [] }
  )
})
