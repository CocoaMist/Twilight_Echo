import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { CorePlaylistPreviews, type CorePlaylistPreviewsOptions } from './previews.ts'
import { createPlaylistReader, type PlaylistReaderPorts } from './reader.ts'
import type { PlaylistImportDocument } from '../../shared/externalPlaylist.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { readPlaylistImportFile } from './readFile.ts'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const link = 'https://music.163.com/playlist?id=7'
const document = (): PlaylistImportDocument => ({
  name: 'Preview',
  complete: true,
  warnings: [],
  source: { kind: 'file', label: 'Fixture' },
  songs: [
    { title: 'Repeat', platform: 'ncm', platformId: '7' },
    { title: 'Repeat', platform: 'ncm', platformId: '7' }
  ]
})
function fixture(
  t: test.TestContext,
  ports: Partial<PlaylistReaderPorts> = {},
  extra: Partial<CorePlaylistPreviewsOptions> = {}
) {
  const events = new EventEmitter(),
    saved: Playlist[] = []
  const previews = new CorePlaylistPreviews({
    now: () => 1000,
    newId: randomUUID,
    reader: createPlaylistReader({
      providers: () => [],
      resolveShortLink: async () => ({ platform: 'ncm', id: '7', url: link }),
      readPage: async () => ({ songs: document().songs, total: 2, nextOffset: 2, hasMore: false }),
      ...ports
    }),
    chooseFile: async () => 'selected-file',
    readFile: async () => document(),
    save: async (playlist) => {
      saved.push(playlist)
      return { id: playlist.id, revision: 3 }
    },
    changed: () => events.emit('change'),
    reconcile() {},
    ...extra
  })
  t.after(() => previews.shutdown())
  const wait = async (predicate: () => boolean) => {
    while (!predicate()) await once(events, 'change')
  }
  return { previews, saved, wait, events }
}

test('full reads keep duplicate occurrences transient; credentials never enter preview projections or the saved playlist', async (t) => {
  const pages: number[] = [],
    token = 'secret-one-shot-token'
  const f = fixture(t, {
    readPage: async (request) => {
      assert.equal(request.credentials?.accessToken, token)
      pages.push(request.offset)
      return {
        songs: [document().songs[0]],
        total: 2,
        nextOffset: request.offset + 1,
        hasMore: request.offset === 0
      }
    }
  })
  const started = f.previews.start(link, { accessToken: token })
  await f.wait(() => !f.previews.status(started.id).reading)
  const status = f.previews.status(started.id),
    page = f.previews.page(started.id, status.revision)
  assert.deepEqual(pages, [0, 1])
  assert.equal(status.complete, true)
  assert.equal(f.saved.length, 0)
  assert.notEqual(page.items[0].id, page.items[1].id)
  assert.doesNotMatch(JSON.stringify({ status, page }), new RegExp(token))
  const result = await f.previews.save({
    id: status.id,
    revision: status.revision,
    playlistsRevision: 2
  })
  assert.equal(result.id, status.id)
  assert.deepEqual(
    f.saved[0].imported!.entries.map((e) => e.entryId),
    page.items.map((e) => e.id)
  )
  assert.doesNotMatch(JSON.stringify(f.saved), new RegExp(token))
  assert.equal(f.previews.list().total, 0)
})

test('explicit read cancellation retains incomplete entries and refuses Save', async (t) => {
  let entered!: () => void
  const secondPage = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = fixture(t, {
    readPage: async (request, signal) => {
      if (request.offset) {
        entered()
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
      return { songs: [document().songs[0]], total: 2, nextOffset: 1, hasMore: true }
    }
  })
  const { id } = f.previews.start(link)
  await secondPage
  await f.previews.cancel(id)
  const status = f.previews.status(id)
  assert.equal(status.complete, false)
  assert.equal(status.count, 1)
  assert.match(status.error!, /取消/)
  await assert.rejects(
    f.previews.save({ id, revision: status.revision, playlistsRevision: 0 }),
    /完整读取/
  )
  assert.equal(f.saved.length, 0)
  await f.previews.discard(id, status.revision)
  assert.equal(f.previews.list().total, 0)
})

test('a provider changing its exact total and a final incomplete page both fail the full-read fence', async (t) => {
  for (const provider of [true, false]) {
    const read = async (_id: string, offset: number) => ({
      songs: [document().songs[0]],
      total: offset ? 3 : 2,
      nextOffset: offset + 1,
      hasMore: offset === 0
    })
    const f = fixture(
      t,
      provider
        ? { providers: () => [{ id: 'ncm', readPlaylistImportPage: read }] }
        : { readPage: (request) => read('', request.offset) }
    )
    const { id } = f.previews.start(link)
    await f.wait(() => !f.previews.status(id).reading)
    assert.equal(f.previews.status(id).complete, false)
    assert.match(f.previews.status(id).error!, provider ? /发生变化/ : /不完整/)
    assert.equal(f.saved.length, 0)
  }
})

test('file mapping is atomic, keeps matching duplicate IDs, and fences old matcher results after reconfiguration and binding', async (t) => {
  const doc = document()
  doc.columns = ['Title', 'Path']
  doc.table = {
    columns: doc.columns,
    rows: [
      ['Repeat', 'C:/one.flac'],
      ['Repeat', 'C:/one.flac']
    ]
  }
  doc.songs = [
    { title: 'Repeat', locations: ['C:/one.flac'] },
    { title: 'Repeat', locations: ['C:/one.flac'] }
  ]
  const f = fixture(t, {}, { readFile: async () => doc })
  const status = (await f.previews.file(new AbortController().signal))!,
    before = f.previews.read(status.id)!
  const ids = before.entries.map((e) => e.entryId),
    generation = before.generation
  assert.throws(
    () =>
      f.previews.configure({
        id: status.id,
        revision: status.revision,
        name: 'Do not publish',
        columns: { title: 99 }
      }),
    /列编号/
  )
  assert.equal(f.previews.status(status.id).name, 'Preview')
  const configured = f.previews.configure({
    id: status.id,
    revision: status.revision,
    columns: { title: 0, location: 1 }
  })
  assert.deepEqual(
    f.previews.read(status.id)!.entries.map((e) => e.entryId),
    ids
  )
  await f.previews.apply(status.id, generation, [
    { entryId: ids[0], revision: 0, resolution: { state: 'missing' } }
  ])
  assert.equal(f.previews.read(status.id)!.entries[0].resolution.state, 'pending')
  f.previews.bind(status.id, configured.revision, ids[0], null)
  await f.previews.apply(status.id, f.previews.read(status.id)!.generation, [
    { entryId: ids[0], revision: 0, resolution: { state: 'missing' } }
  ])
  assert.equal(f.previews.read(status.id)!.entries[0].resolution.state, 'pending')
  assert.doesNotMatch(
    JSON.stringify(f.previews.page(status.id, f.previews.status(status.id).revision)),
    /C:\/one|locations|filePath/
  )
})

test('Save joins the real commit, prevents concurrent edits, and leaves a failed save available for explicit retry', async (t) => {
  let release!: () => void,
    attempts = 0
  const ack = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(
    t,
    {},
    {
      save: async (playlist) => {
        attempts++
        if (attempts === 1) throw Error('disk unavailable')
        await ack
        return { id: playlist.id, revision: 1 }
      }
    }
  )
  let p = (await f.previews.file(new AbortController().signal))!
  await assert.rejects(
    f.previews.save({ id: p.id, revision: p.revision, playlistsRevision: 0 }),
    /disk unavailable/
  )
  p = f.previews.status(p.id)
  assert.equal(p.saving, false)
  const work = f.previews.save({ id: p.id, revision: p.revision, playlistsRevision: 0 })
  assert.equal(f.previews.status(p.id).saving, true)
  assert.throws(
    () => f.previews.configure({ id: p.id, revision: p.revision, name: 'stale' }),
    (e: { code: string }) => e.code === 'STALE_REVISION'
  )
  await assert.rejects(
    f.previews.discard(p.id, f.previews.status(p.id).revision),
    (e: { code: string }) => e.code === 'BUSY'
  )
  release()
  await work
  assert.equal(f.previews.list().total, 0)
  assert.equal(attempts, 2)
})

test('selected files use the real portable parser and keep cancelled selection out of transient state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-core-import-file-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'repeat.m3u8')
  await writeFile(
    file,
    '#EXTM3U\n#EXTINF:123,Artist - First\none.flac\n#EXTINF:123,Artist - First\none.flac\n'
  )
  const f = fixture(t, {}, { chooseFile: async () => file, readFile: readPlaylistImportFile })
  const status = (await f.previews.file(new AbortController().signal))!
  assert.equal(status.count, 2)
  assert.equal(status.complete, true)
  assert.equal(
    f.previews.read(status.id)!.entries[0].original.locations![0],
    join(directory, 'one.flac')
  )
  const cancel = fixture(t, {}, { chooseFile: async () => null })
  assert.equal(await cancel.previews.file(new AbortController().signal), null)
  assert.equal(cancel.previews.list().total, 0)
})

test('preview choices and occurrence pages stay bounded, with stable indices for large exported files', async (t) => {
  const doc = document()
  doc.columns = Array.from({ length: 405 }, (_, i) => `Column ${i}`)
  doc.playlists = Array.from({ length: 405 }, (_, i) => ({ name: `List ${i}`, songs: doc.songs }))
  const f = fixture(t, {}, { readFile: async () => doc })
  const p = (await f.previews.file(new AbortController().signal))!
  assert.equal(p.columnCount, 405)
  assert.equal(p.playlistCount, 405)
  assert.equal(Object.hasOwn(p, 'playlists'), false)
  assert.equal(f.previews.choices(p.id, p.revision, 'columns').items.length, 200)
  assert.equal(f.previews.choices(p.id, p.revision, 'playlists', 400).items[4].index, 404)
  const selected = f.previews.configure({ id: p.id, revision: p.revision, playlistIndex: 404 })
  assert.equal(selected.name, 'List 404')
  assert.throws(
    () => f.previews.choices(p.id, p.revision, 'columns'),
    (e: { code: string }) => e.code === 'STALE_REVISION'
  )
})

test('discard removes its authority before awaiting read cancellation, so a concurrent Save cannot publish it', async (t) => {
  const f = fixture(t)
  const p = (await f.previews.file(new AbortController().signal))!
  const discard = f.previews.discard(p.id, p.revision)
  await assert.rejects(
    f.previews.save({ id: p.id, revision: p.revision, playlistsRevision: 0 }),
    /不存在/
  )
  await discard
  assert.equal(f.saved.length, 0)
})
