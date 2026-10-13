import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { LibraryPersistenceClient } from './libraryPersistenceClient.ts'
import { PersistentJsonFileError } from '../persistence/jsonFile.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'

function fixture(t: test.TestContext): { client: LibraryPersistenceClient; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-worker-'))
  const client = new LibraryPersistenceClient(
    new URL('./libraryPersistenceWorker.ts', import.meta.url)
  )
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { client, path: join(root, 'music-library.json') }
}

function document(revision: number, count = 1): LocalMusicLibraryDocument {
  return {
    version: 2,
    revision,
    tracks: Array.from({ length: count }, (_, i) => ({
      id: `track-${i}`,
      filePath: `D:\\Music\\${i}.flac`,
      title: `Song ${i}`,
      artist: 'Artist',
      album: 'Album',
      cover: `cover://album-${i}`,
      lyrics: null
    })),
    folders: ['D:\\Music'],
    exclusions: []
  }
}

test('library worker preserves format, order, valid backup, and recovery errors', async (t) => {
  const { client, path } = fixture(t)
  assert.equal((await client.load(path)).status, 'missing')
  await Promise.all([client.persist(path, document(1)), client.persist(path, document(2, 2))])
  assert.equal((await client.load(path)).document.revision, 2)
  assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).revision, 1)
  writeFileSync(path, '{corrupt')
  const recovered = await client.load(path)
  assert.equal(recovered.status, 'recovered')
  assert.equal(recovered.document.revision, 1)
  assert.equal(readFileSync(`${path}.corrupt`, 'utf8'), '{corrupt')
  writeFileSync(path, '{bad')
  writeFileSync(`${path}.bak`, '{bad backup')
  await assert.rejects(client.load(path), (error: unknown) => {
    assert.ok(error instanceof PersistentJsonFileError)
    assert.equal(error.filePath, path)
    return true
  })
})

test('whole-library serialization and backup validation allow the main event loop to run', async (t) => {
  const { client, path } = fixture(t)
  const library = document(1, 100_000)
  await client.persist(path, library)
  library.revision = 2
  let heartbeats = 0
  const timer = setInterval(() => {
    heartbeats++
  }, 5)
  try {
    await client.persist(path, library)
  } finally {
    clearInterval(timer)
  }
  assert.ok(
    heartbeats > 0,
    'main event loop must run while a large second save validates the previous backup'
  )
  const loaded = await client.load(path)
  assert.equal(loaded.document.revision, 2)
  assert.equal(loaded.document.tracks.length, 100_000)
})

test('library worker limits pending requests and rejects after close', async (t) => {
  const { client, path } = fixture(t)
  const queued = Array.from({ length: 8 }, () => client.load(path))
  await assert.rejects(client.load(path), /busy/)
  await Promise.all(queued)
  await client.close()
  await assert.rejects(client.load(path), /closed/)
})

test('invalid nesting is rejected before persistence without poisoning later jobs', async (t) => {
  const { client, path } = fixture(t)
  let nested: unknown = 'leaf'
  for (let i = 0; i < 200; i++) nested = { nested }
  await assert.rejects(
    client.validate({ tracks: [nested], revision: 0, folders: [] }),
    /deeply nested/
  )
  await client.persist(path, document(3))
  assert.equal((await client.load(path)).document.revision, 3)
})

test('a failed chunk transfer retires its worker before the next job and leaves the last library intact', async (t) => {
  const { client, path } = fixture(t)
  await client.persist(path, document(1))
  const invalid = document(2, 5000)
  invalid.tracks[3000] = { invalid: () => undefined }
  await assert.rejects(client.persist(path, invalid), /clone/)
  assert.equal((await client.load(path)).document.revision, 1)
  await client.persist(path, document(3, 5000))
  assert.equal((await client.load(path)).document.revision, 3)
})
