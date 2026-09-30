import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NetworkSourceFailure } from './errors.ts'
import { createNetworkLibrary } from './networkLibrary.ts'
import {
  createNetworkLibraryPersistence,
  type NetworkLibraryDocument
} from './networkLibraryPersistence.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'

function deeplyNestedValue(depth = 128): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

function makeEntry(path: string, name?: string): NetworkEntry {
  return {
    id: `id:${path}`,
    profileId: 'p1',
    name: name ?? path.split('/').pop() ?? path,
    kind: 'audio',
    path,
    sizeBytes: 100
  }
}

async function makeLibrary() {
  const dir = await mkdtemp(join(tmpdir(), 'network-library-'))
  const library = createNetworkLibrary({ filePath: join(dir, 'library.json') })
  return { dir, library }
}

test('library persists scanned entries across reloads', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [makeEntry('/music/a.flac')])
    const reloaded = createNetworkLibrary({ filePath: join(dir, 'library.json') })
    const entries = await reloaded.listEntries('p1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, '/music/a.flac')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('re-scanning the same root replaces stale entries without duplicates', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [
      makeEntry('/music/a.flac'),
      makeEntry('/music/old.flac')
    ])
    await library.addEntries('p1', '/music', [
      makeEntry('/music/a.flac'),
      makeEntry('/music/b.flac')
    ])
    const entries = await library.listEntries('p1')
    assert.equal(entries.length, 2)
    assert.ok(entries.some((entry) => entry.path === '/music/a.flac'))
    assert.ok(entries.some((entry) => entry.path === '/music/b.flac'))
    assert.ok(!entries.some((entry) => entry.path === '/music/old.flac'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listEntries filters by query and removeEntry/removeProfile work', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [
      makeEntry('/music/beautiful.flac', 'beautiful.flac'),
      makeEntry('/music/rock.mp3', 'rock.mp3')
    ])
    assert.equal((await library.listEntries('p1', 'beaut')).length, 1)
    await library.removeEntry('p1', 'id:/music/beautiful.flac')
    assert.equal((await library.listEntries('p1')).length, 1)
    await library.removeProfile('p1')
    assert.equal((await library.listEntries('p1')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('updateEntries merges metadata onto existing entries by id', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [makeEntry('/music/a.flac')])
    await library.updateEntries('p1', [
      {
        ...makeEntry('/music/a.flac'),
        metadata: { title: 'Song', artist: 'Artist', duration: 123.4 },
        coverPath: '/cache/a.jpg'
      }
    ])
    const entries = await library.listEntries('p1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].metadata?.title, 'Song')
    assert.equal(entries[0].metadata?.duration, 123.4)
    assert.equal(entries[0].coverPath, '/cache/a.jpg')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects an excessively nested network media-library document', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await writeFile(
      join(dir, 'library.json'),
      JSON.stringify({
        p1: { roots: ['/music'], entries: [makeEntry('/music/a.flac')] },
        padding: deeplyNestedValue()
      }),
      'utf-8'
    )

    await assert.rejects(
      () => library.listEntries('p1'),
      (error: unknown) => error instanceof NetworkSourceFailure && error.code === 'network'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent scans preserve every profile and publish valid JSON', async (t) => {
  const { dir, library } = await makeLibrary()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => {
      const profileId = `p${index}`
      return library.addEntries(profileId, '/music', [
        { ...makeEntry(`/music/${index}.flac`), profileId }
      ])
    })
  )
  const saved = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))
  assert.equal(Object.keys(saved).length, 10)
  const reloaded = createNetworkLibrary({ filePath: join(dir, 'library.json') })
  for (let index = 0; index < 10; index++) {
    assert.equal((await reloaded.listEntries(`p${index}`))[0].name, `${index}.flac`)
  }
  assert.deepEqual(await readdir(dir), ['library.json'])
})

test('queued mutations preserve disjoint roots and reads wait for preceding writes', async (t) => {
  const { dir, library } = await makeLibrary()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = library.addEntries('p1', '/a', [makeEntry('/a/a.flac')])
  const second = library.addEntries('p1', '/b', [makeEntry('/b/b.flac')])
  const remove = library.removeEntry('p1', 'id:/a/a.flac')
  const result = await library.listEntries('p1')
  await Promise.all([first, second, remove])
  assert.deepEqual(
    result.map((entry) => entry.path),
    ['/b/b.flac']
  )
})

test('late enrichment does not resurrect removed entries', async (t) => {
  const { dir, library } = await makeLibrary()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await library.addEntries('p1', '/music', [makeEntry('/music/a.flac'), makeEntry('/music/b.flac')])
  const before = await library.listEntries('p1')
  await library.removeEntry('p1', before[0].id)
  await library.updateEntries(
    'p1',
    before.map((entry) => ({ ...entry, metadata: { title: 'enriched' } }))
  )
  const after = await library.listEntries('p1')
  assert.deepEqual(
    after.map((entry) => entry.path),
    ['/music/b.flac']
  )
  assert.equal(after[0].metadata?.title, 'enriched')
})

test('a rejected transaction does not poison subsequent writes or publish its draft', async () => {
  let saved: NetworkLibraryDocument = {}
  let fail = true
  const library = createNetworkLibrary({
    filePath: 'unused',
    persistence: {
      load: async () => structuredClone(saved),
      save: async (document) => {
        if (fail) {
          fail = false
          throw new Error('disk full')
        }
        saved = structuredClone(document)
      }
    }
  })
  await assert.rejects(library.addEntries('p1', '/a', [makeEntry('/a/a.flac')]), /disk full/)
  await library.addEntries('p1', '/b', [makeEntry('/b/b.flac')])
  assert.deepEqual(
    (await library.listEntries('p1')).map((entry) => entry.path),
    ['/b/b.flac']
  )
})

test('multi-profile search reads one snapshot and returns independently owned metadata', async () => {
  let loads = 0
  const source: NetworkLibraryDocument = {
    p1: {
      roots: ['/music'],
      entries: [{ ...makeEntry('/music/a.flac'), metadata: { title: 'Original' } }]
    },
    p2: { roots: ['/music'], entries: [{ ...makeEntry('/music/b.flac'), profileId: 'p2' }] }
  }
  const library = createNetworkLibrary({
    filePath: 'unused',
    persistence: {
      load: async () => {
        loads++
        return source
      },
      save: async () => undefined
    }
  })
  const rows = await library.searchEntries(['p2', 'p1'], ' FLAC ')
  assert.equal(loads, 1)
  assert.deepEqual(
    rows.map((row) => row.profileId),
    ['p2', 'p1']
  )
  rows[1].entry.metadata!.title = 'Caller change'
  assert.equal(source.p1.entries[0].metadata!.title, 'Original')
})

test('persistence coalesces simultaneous reads but sees subsequent external changes', async (t) => {
  const { dir, library } = await makeLibrary()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await library.addEntries('p1', '/music', [makeEntry('/music/a.flac')])
  const path = join(dir, 'library.json')
  const persistence = createNetworkLibraryPersistence(path)
  const first = persistence.load()
  assert.equal(first, persistence.load())
  assert.equal(first, persistence.load())
  await first
  await writeFile(path, '{}')
  assert.deepEqual(await persistence.load(), {})
})

test('failed atomic replacement cleans temporary files without unlinking the target', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'network-library-atomic-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = join(dir, 'library.json')
  await mkdir(target)
  await writeFile(join(target, 'preserved.txt'), 'keep')
  const persistence = createNetworkLibraryPersistence(target)
  await assert.rejects(persistence.save({}))
  assert.equal(await readFile(join(target, 'preserved.txt'), 'utf8'), 'keep')
  assert.deepEqual(await readdir(dir), ['library.json'])
})
