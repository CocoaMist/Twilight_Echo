import assert from 'node:assert/strict'
import test from 'node:test'
import type { LibraryDatabaseApi, LibraryTrackRecord } from '../../../shared/libraryDatabase.ts'
import { lookupLibraryTrackByPath, lookupLibraryTracksByPaths } from './libraryTrackByPath.ts'

function apiFixture(ids: Array<string | null>, tracks: LibraryTrackRecord[]) {
  const calls: unknown[][] = []
  const api = {
    lookupTracksByPaths: async (paths: string[], revision?: number) => {
      calls.push(['paths', paths, revision])
      return { ids, revision: 12 }
    },
    getTracksByIds: async (requested: string[], revision?: number) => {
      calls.push(['ids', requested, revision])
      return { tracks, revision: 12 }
    }
  } as unknown as LibraryDatabaseApi
  return { api, calls }
}

test('path lookup fetches only matched IDs and fences the payload read to the path result revision', async () => {
  const record = { id: 'local:1', filePath: 'D:/Music/song.flac', title: 'Song' }
  const { api, calls } = apiFixture(['local:1', null], [record])
  const result = await lookupLibraryTracksByPaths(['D:/Music/song.flac', 'missing.flac'], api, 11)

  assert.deepEqual(calls, [
    ['paths', ['D:/Music/song.flac', 'missing.flac'], 11],
    ['ids', ['local:1'], 12]
  ])
  assert.equal(result.revision, 12)
  assert.equal(result.tracks[0].title, 'Song')
  assert.equal(result.tracks[0].source, 'local')
})

test('a missing path does not request a track payload', async () => {
  const { api, calls } = apiFixture([null], [])
  assert.equal(await lookupLibraryTrackByPath('missing.flac', api), null)
  assert.deepEqual(calls, [['paths', ['missing.flac'], undefined]])
})

test('a path result cannot be combined with a stale or incomplete payload page', async () => {
  const { api } = apiFixture(['local:1'], [{ id: 'local:1', filePath: 'D:/Music/song.flac' }])
  api.getTracksByIds = async () => ({ tracks: [], revision: 11 }) as never
  await assert.rejects(
    lookupLibraryTrackByPath('D:/Music/song.flac', api),
    /曲库在按路径读取期间发生变化/
  )
})
